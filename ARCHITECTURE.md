# MailOps — Architecture

## 1. The shape of the problem

A job seeker's inbox contains recruitment mail buried inside marketing noise. The
information that matters — a shortlist, an assessment deadline, an offer — arrives
as unstructured prose and is easy to miss. MailOps turns that stream into two
durable artefacts:

1. **A structured application timeline** that survives the deletion of the emails
   it was derived from.
2. **A notification ladder** that keeps trying to reach the user until the thing
   that mattered has been acknowledged.

Everything below exists to make those two things true without lying to the user
and without ever destroying something irreversibly by mistake.

---

## 2. Layering

The backend is a strict four-layer stack. Business logic never lives in a route
handler or a controller.

```
HTTP  ──►  Route  ──►  Controller  ──►  Service  ──►  Repository / Prisma
             │            │               │
        wiring only   validate +       all business
        (middleware)  serialise        rules + decisions
```

| Layer | Directory | Responsibility | Must not |
|---|---|---|---|
| Route | `src/routes/` | path → controller wiring, per-route middleware (auth, validation) | contain logic |
| Middleware | `src/middleware/` | auth, validation, CSRF, rate limits, error shaping | know about domains |
| Controller | `src/controllers/` | parse input, call one service, return the response envelope | contain rules |
| Service | `src/services/` | all business rules and decisions | touch `req`/`res` |
| Data | `src/config/prisma.ts` | the single `PrismaClient` | leak into HTTP |

Services are grouped by domain: `gmail/`, `ai/`, `applications/`,
`notifications/`, `decisions/`, `cleanup/`, `analytics/`, `audit/`, `dashboard/`,
`emails/`, `settings/`, `auth/`.

`src/utils/` holds pure helpers (similarity, dates, text, crypto, redaction,
errors). They have no I/O and are the most heavily tested code in the repo.

---

## 3. Runtime topology

```
                       ┌──────────────────────────┐
                       │  API process             │
   Browser ──────────► │  src/index.ts            │
   (Next.js)           │  Express + Prisma        │
                       └───────┬───────┬──────────┘
                               │       │
                        Postgres      Redis
                                       │
                       ┌───────────────┴──────────────────────┐
                       │  Worker process(es)                   │
                       │  src/workers/index.ts                 │
                       │                                       │
                       │  email-scan      (2 concurrent)       │
                       │  email-processing(WORKER_CONCURRENCY) │
                       │  application-processing               │
                       │  notification    (min 2)              │
                       │  escalation      (min 2)              │
                       │  cleanup         (1)                  │
                       │  scheduler       (5-minute tick)      │
                       └───────────────────────────────────────┘
```

The API and the worker are the same codebase with different entrypoints, so they
share the service layer and can be scaled independently. The API never performs
long-running work: a request either does bounded database work or enqueues a job.

**Reads degrade, writes fail loudly.** Without Redis the API still serves the
dashboard, application pages and analytics. Queue-backed actions return a `503`
with `QUEUE_UNAVAILABLE` and `degraded: true`, which the UI renders as "background
processing is temporarily unavailable" rather than a crash.

---

## 4. The agent loop

```
OBSERVE → UNDERSTAND → REMEMBER → DECIDE → ACT → INFORM
```

| Step | Implemented by | Notes |
|---|---|---|
| **Observe** | `email-scan` worker → `gmail/sync.service.ts` | Only place that reads Gmail. Stores normalised metadata, enqueues one job per new message. |
| **Understand** | `email-processing` worker → `ai/analysis.service.ts` | Classify → extract → summarise → decide. Persists `EmailAnalysis`, no side effects beyond that. |
| **Remember** | `application-processing` worker → `applications/` | Creates or updates the `Application`, appends immutable `ApplicationEvent` rows. |
| **Decide** | `decisions/decision.engine.ts` | Pure function: severity, whether to notify, which channels, whether escalation is armed, whether a call is eligible, whether cleanup applies. |
| **Act** | `notifications/`, `cleanup/` | Delivery, escalation timers, cleanup proposals. Destructive actions require approval. |
| **Inform** | Dashboard, Slack, WhatsApp, voice, audit log | The user can always see what happened and why. |

The separation is what makes the pipeline resumable: a failure in the *Act* stage
never requires re-running *Understand*, and each stage is independently retryable
and idempotent.

---

## 5. Worker architecture

Six BullMQ queues, one per responsibility.

```
scheduler (5 min tick)
   │
   ├─► email-scan ─────► Gmail API ─► Email rows (QUEUED)
   │                                        │
   │                                        ▼
   │                              email-processing
   │                                        │
   │                                        ▼
   │                             application-processing
   │                                        │
   │                                        ▼
   │                                  notification
   │                                        │
   │                                        ▼
   │             ┌────────────────── escalation (delayed jobs)
   │             │                          │
   │             ▼                          ▼
   │        cleanup                   Slack / WhatsApp / Voice
   └─► retention + cleanup proposals (daily)
```

### Idempotency, three layers

| Layer | Mechanism |
|---|---|
| Message | `@@unique([userId, gmailMessageId])`; `P2002` on insert means a racing scan already stored it, which is a no-op |
| Job | Stable BullMQ job ids — `scan:<account>:<type>`, `email:<emailId>`, `esc:<notificationId>:<stage>` — collapse duplicates |
| Cursor | The Gmail `historyId` is advanced only after a scan succeeds, so a failure re-reads rather than skips |

### Retry policy

`DEFAULT_JOB_OPTIONS` in `config/constants.ts`: 5 attempts with exponential
backoff starting at 5 s, keeping the last 500 completions and 1000 failures.

Gmail calls have their own internal backoff (`GmailClient.call`) for 429/5xx,
capped at 30 s, and never retry 401/403 — a revoked credential or missing scope
must surface as an actionable error, not burn attempts.

### Scheduling

A single 5-minute tick rather than per-user repeatable jobs, because the scan
interval is a *user setting* (default 3.5 h) that users change. The tick asks "who
is due?" using the stored interval, which means changing a setting takes effect
immediately with no job re-registration.

The same tick is the **safety net** for escalations: `sweepOverdueEscalations()`
re-queues any notification whose delayed job was lost (Redis flush, worker killed
mid-flight). An escalation timer is never silently dropped.

---

## 6. Decision engine

`decisions/decision.engine.ts` is a pure function. It sits between probabilistic
AI output and every side effect:

```
AI output
   │
   ▼
Schema validation (Zod)
   │
   ▼
Business-rule guards (dates plausible? status evidenced? confidence gate)
   │
   ▼
DECISION ENGINE ──► severity, notify?, channels, requiresAck?, voiceEligible?,
   │                cleanupCandidate?, explanation
   ▼
User approval where destructive
   │
   ▼
Action
```

Inputs: category, sub-category, priority, confidence, requiresAction, needsReview,
whether the email is already linked, the extracted deadline, whether the sender is
protected, and the user's settings. Outputs a `Decision` — including a
human-readable `explanation` that is stored on the analysis and shown in the UI.

Key properties, each with tests:

- **Severity mapping** is a table, not scattered conditionals: offers are
  `CRITICAL`; interviews/assessments with a deadline are `CRITICAL`; shortlists and
  recruiter requests are `HIGH`; rejections are `HIGH` but never acknowledgement-
  requiring and never voice-eligible.
- **Escalation stages are derived from the channels the user enabled**, so an
  account with only the dashboard enabled can never reach WhatsApp, let alone
  phone them.
- **Voice is doubly gated**: `voiceEligible` here, and `checkVoiceGate()` again
  immediately before dialling (opt-in, in-ladder, event type enabled, quiet hours,
  daily cap).
- **Cleanup candidacy excludes protected categories and protected senders** at this
  layer *and* again at execution time.

---

## 7. Escalation

```
important email detected
        │
        ▼
  dashboard notification              ← always
        │
  requiresAck && escalation enabled?
        │
        ▼
  wait delays[0] (default 30 min) ──► acknowledged? ──► STOP
        │ no
        ▼
      Slack (if enabled)
        │
  wait delays[1] (60 min)  ──► acknowledged? ──► STOP
        │ no
        ▼
    WhatsApp (if enabled)
        │
  wait delays[2] (120 min) ──► acknowledged? ──► STOP
        │ no
        ▼
  Voice call (if opted in, in-window, under cap, event type allowed)
```

The plan is **computed once and stored on the notification**
(`metadata.plan`), so the worker that wakes up two hours later cannot disagree
with what the user was promised. Delay timers are BullMQ delayed jobs; each stage
advances only on success, so a crash re-checks acknowledgement rather than
double-dialling.

Stopping conditions checked at every stage: acknowledged (via any surface),
resolved, cancelled, paused by the user, or already past this stage.

---

## 8. Application matching and duplicate detection

The single most visible failure mode in a job tracker is creating a new record for
every email an employer sends. Two mechanisms prevent it.

### Matching (email → existing application)

```
new email
   │
   ▼
extract company + role + jobId + applicationUrl
   │
   ▼
candidate retrieval (indexed on companyKey / roleKey / jobId)
   │
   ▼
matchApplicationIdentity()
   ├─ identical jobId or applicationUrl ──► score 1.0, AUTO_LINK
   └─ otherwise 0.65×company + 0.35×role
          ≥ 0.70  AUTO_LINK
          ≥ 0.50  REVIEW  (user decides)
          < 0.50  NEW_APPLICATION
```

`matchEmailToApplication()` (AI, with the deterministic matcher as the fallback
engine) adjudicates the candidate set; the deterministic thresholds remain
authoritative, so an over-confident model cannot auto-file an ambiguous email.

### Duplicate detection

Same scoring, higher threshold (0.82), plus a time guard: a near-identical
application created within the last 14 days is the *same cycle*, not a duplicate.
Detections are advisory — MailOps sets `needsReview`, records a
`DUPLICATE_FLAGGED` event and offers *View previous application* /
*Continue anyway*. It never blocks the user.

### Status transitions never rewind

`STATUS_RANK` orders the pipeline. An incoming email may only move an application
*forward*, except for `REJECTED`/`WITHDRAWN`, which are terminal and always apply.
A late-arriving "application received" email therefore cannot drag an application
back from `INTERVIEW` — a real scenario when a scan re-reads an old window.

---

## 9. Data integrity decisions

| Decision | Why |
|---|---|
| `Email` → `Application` is optional (`onDelete: SetNull`) | Deleting email content must never delete the career record |
| `ApplicationEvent` is append-only (no update path in the service) | The timeline is evidence; rewriting it would destroy trust |
| Retention trims bodies and purges only *unlinked* emails | Application evidence survives the retention window |
| Notification dedupe via `@@unique([userId, dedupeKey])` | Re-fire updates the row instead of creating a storm |
| Credentials stored as ciphertext (`*Enc` columns) | A database dump alone is not enough to read a mailbox |
| `companyKey` / `roleKey` denormalised | Indexed matching without `LIKE %…%` table scans |

---

## 10. Frontend architecture

```
app/(app)/layout.tsx  ──► AppShell (the single auth gate)
                              │
      ┌───────────────────────┼────────────────────────┐
      │                       │                        │
  Sidebar (desktop)     TopBar (scan status)     Mobile drawer + bottom nav
      │
      ▼
  pages: dashboard · applications · applications/[id] · emails · rejected
         cleanup · notifications · analytics · audit · settings
      │
      ▼
  lib/hooks.ts  ──►  lib/api.ts  ──►  backend /api
   (TanStack Query)   (single fetch client: credentials, CSRF, envelope, refresh)
```

- **No `fetch` outside `lib/api.ts`.** One place owns credentials, the CSRF
  header, envelope unwrapping, and single-flight token refresh on 401.
- **Filter objects are query keys.** Changing a filter is a different query;
  returning to a previous filter is served from cache.
- **Status colour is defined once** (`lib/utils.ts` `STATUS_TONES` /
  `TONE_CLASSES`), so green always means an offer and red always means
  rejected/critical.
- **Responsive by construction**: `DataTable` renders a real table on desktop and
  stacked cards on mobile, rather than a horizontally scrolling grid.

---

## 11. Failure isolation

Each integration fails independently, and a failure never cascades.

| Failure | Effect | Mitigation |
|---|---|---|
| Gmail revoked/expired | Scanning stops for that account | Status → `EXPIRED`, actionable banner, user reconnects; stored history intact |
| Gmail API 5xx/429 | Scan job fails | Internal exponential backoff; job retries; cursor not advanced |
| AI provider down | Analyses degrade | `runAiTask` retries once, then uses the deterministic engine and records `fallbackUsed` |
| AI returns malformed JSON | Analysis would be wrong | Zod validation → one repair retry → deterministic fallback |
| Slack webhook broken | Slack attempts fail | Per-attempt failure recorded; WhatsApp escalation still runs |
| WhatsApp unavailable | Escalation stage skipped | Recorded as `SKIPPED`; ladder advances to the next stage |
| Voice provider down | Call fails | Attempt recorded as `FAILED`; no retry beyond the stage plan |
| Redis down | Queues stop | Reads still work; producers return `503 QUEUE_UNAVAILABLE`; health reports `degraded` |
| Postgres down | API returns `503 DATABASE_UNAVAILABLE` | `/health` responds within a bounded timeout instead of hanging |

---

## 12. What is deliberately not here

- **No `gmail.send`.** MailOps never sends mail as the user.
- **No full mailbox scope.** Cleanup uses `gmail.modify` (archive/trash), which is
  recoverable, rather than `https://mail.google.com/` (permanent delete).
- **No stored chain-of-thought.** Only a one-sentence rationale is persisted.
- **No unbounded AI prompt.** Each responsibility has its own prompt, schema and
  version string, so one can change without invalidating the others.
- **No background deletion.** The cleanup worker proposes; only the approval
  endpoint executes.
