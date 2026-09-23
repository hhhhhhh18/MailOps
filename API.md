# MailOps — API

Base URL: `http://localhost:4000` (development). All application endpoints are
under `/api`.

---

## 1. Conventions

### Response envelope

Every 2xx JSON response from `/api` is wrapped:

```json
{ "success": true, "data": { } }
```

List endpoints add pagination metadata:

```json
{
  "success": true,
  "data": [ /* items */ ],
  "meta": {
    "page": 1, "pageSize": 25, "total": 148, "totalPages": 6,
    "hasNext": true, "hasPrev": false
  }
}
```

Every error:

```json
{
  "success": false,
  "error": {
    "code": "GMAIL_CONNECTION_EXPIRED",
    "message": "Gmail access has expired. Please reconnect your Gmail account.",
    "retryable": false,
    "degraded": false,
    "requestId": "req_9f3c21ab"
  }
}
```

- `retryable` — a retry may succeed (transient).
- `degraded` — MailOps continued in reduced capacity; other channels still work.
- `requestId` — echo this when reporting a problem; it appears in server logs.
- `details` — validation details, included outside production only.

### Authentication

Two supported mechanisms, checked in this order:

1. **Cookie** `mailops_at` — httpOnly, SameSite=Lax, set by `/api/auth/login`.
   This is what the browser app uses.
2. **Header** `Authorization: Bearer <access token>` — for scripted callers and tests.

There is no query-string token support (it would leak into logs and referrers).

### CSRF

State-changing requests (`POST`, `PATCH`, `PUT`, `DELETE`) that authenticate by
cookie must send both:

- cookie `mailops_csrf` (set on login and on `GET /api/auth/me`)
- header `X-CSRF-Token` with the same value

Requests using a bearer token are exempt (they are not cookie-authenticated and
therefore not CSRF-reachable). `GET`/`HEAD`/`OPTIONS` are exempt.

### Rate limits

| Scope | Window | Max | Env |
|---|---|---|---|
| Global (`/api/*`) | 60 s | 120 | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| Auth (`/api/auth/register`, `/api/auth/login`) | 60 s | 10 | `AUTH_RATE_LIMIT_MAX` |
| Health | — | exempt | — |

Rate-limit headers are returned (`RateLimit-*`). Exceeding a limit returns `429`
with `RATE_LIMITED` and `retryable: true`.

### Pagination and filtering

List endpoints accept `page` (default 1), `pageSize` (default 25, max 100), and
endpoint-specific filters. Unknown query parameters are rejected with `422`.

---

## 2. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Payload or query failed schema validation |
| `UNAUTHENTICATED` | 401 | Missing/expired token |
| `FORBIDDEN` | 403 | Authenticated but not allowed (includes CSRF failure) |
| `NOT_FOUND` | 404 | Resource missing or not owned by the caller |
| `CONFLICT` | 409 | Duplicate or conflicting state |
| `RATE_LIMITED` | 429 | Too many requests |
| `GMAIL_NOT_CONNECTED` | 409 | No connected Gmail account |
| `GMAIL_CONNECTION_EXPIRED` | 502 | Refresh token revoked/expired — reconnect required |
| `GMAIL_INVALID_TOKEN` | 502 | Google rejected the credentials |
| `GMAIL_API_UNAVAILABLE` | 502 | Gmail 5xx / quota exceeded |
| `AI_PROVIDER_UNAVAILABLE` | 502 | LLM provider unreachable (deterministic engine takes over) |
| `AI_INVALID_OUTPUT` | 502 | Model response failed schema validation |
| `SLACK_DISCONNECTED` / `WHATSAPP_UNAVAILABLE` / `VOICE_UNAVAILABLE` / `EMAIL_CHANNEL_UNAVAILABLE` | 502 | Channel-specific delivery failure |
| `DATABASE_UNAVAILABLE` | 503 | PostgreSQL unreachable |
| `REDIS_UNAVAILABLE` | 503 | Redis unreachable |
| `QUEUE_UNAVAILABLE` | 503 | Background processing unavailable (`degraded: true`) |
| `PROTECTED_EMAIL` | 409 | A protection rule blocked a destructive action |
| `INTEGRATION_NOT_CONFIGURED` | 503 | Server lacks credentials for that integration |
| `INTERNAL_ERROR` | 500 | Unexpected; message is generic in production |

---

## 3. Health

### `GET /health/live`

Liveness. Never touches a dependency.

```json
{ "status": "ok", "service": "mailops-api", "uptimeSeconds": 421 }
```

### `GET /health`

Readiness. Dependency checks are time-bounded so this always responds.

```json
{
  "status": "ok",
  "service": "mailops-api",
  "version": "1.0.0",
  "environment": "development",
  "uptimeSeconds": 421,
  "dependencies": { "database": "ok", "redis": "ok", "aiProvider": "heuristic" },
  "degradedCapabilities": []
}
```

`status` is `ok` | `degraded` | `unavailable`. HTTP 200 when healthy, 503 when the
database is unreachable.

### `GET /` — service banner.

---

## 4. Auth — `/api/auth`

| Method | Path | Auth | Body / notes |
|---|---|---|---|
| `POST` | `/register` | public | `{ email, password (≥10 chars, letter + digit), name?, timezone? }` → `201` with `{ user, csrfToken }` and auth cookies |
| `POST` | `/login` | public | `{ email, password }` → `{ user, csrfToken }` + cookies |
| `POST` | `/refresh` | refresh cookie | Rotates the refresh token; returns `{ user, authenticated }`. Returns `authenticated: false` when there is no session (not an error) |
| `POST` | `/logout` | optional | Revokes the refresh token, clears cookies |
| `GET` | `/me` | required | `{ user, settings, gmailAccounts, csrfToken, defaults }` — the SPA bootstrap |
| `POST` | `/sessions/revoke` | required | Revokes **all** refresh tokens for the user |

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@mailops.local","password":"MailOpsDemo123"}' \
  -c cookies.txt
```

---

## 5. Gmail — `/api/gmail`

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/oauth/start` | required | Body `{ returnTo? }` (same-app path only). Returns `{ consentUrl, scopes[], explanation }`. The explanation is shown verbatim in the consent dialog |
| `GET` | `/oauth/callback` | **public** | Google's redirect target. CSRF protection is the single-use, user-bound `state`. Redirects to the web app with `?gmail=connected\|denied\|failed` |
| `GET` | `/accounts` | required | Connected accounts + `scopeAudit` (`{ ok, missing[] }`) + the scope descriptions. **Never returns tokens.** |
| `POST` | `/disconnect` | required | Body `{ gmailAccountId }`. Revokes the Google grant, deletes stored tokens. Emails in Gmail are untouched |
| `POST` | `/scan` | required | Body `{ gmailAccountId?, fullRescan? }`. Enqueues a scan → `202`-style `{ queued, jobId }` |
| `POST` | `/scan/inline` | required | Runs a scan synchronously. **Disabled in production** (`403`) |
| `GET` | `/scan/status` | required | `{ schedule: { lastScanAt, nextScanAt, intervalMinutes, scanningEnabled, lastScanError, scannedMessagesLast24h }, jobs[] }` |

---

## 6. Emails — `/api/emails`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Filters: `page`, `pageSize`, `tab` (`all`\|`important`\|`jobs`\|`needs_review`\|`promotional`\|`spam`\|`newsletters`\|`rejected`), `category`, `subCategory`, `priority`, `processingState`, `applicationId`, `search`, `from`, `to`, `sortBy` (`receivedAt`\|`priority`\|`confidence`), `sortDir` |
| `GET` | `/counters` | `{ all, important, jobs, promotional, spam, newsletters, rejected, needsReview }` |
| `GET` | `/review-queue` | Emails awaiting human confirmation (low confidence / failed) |
| `GET` | `/:emailId` | Full detail: analysis, `aiAnalysis` (UI-shaped), application, cleanup actions, notifications, linked events |
| `PATCH` | `/:emailId/analysis` | **User override.** `{ category?, subCategory?, priority?, requiresAction?, companyOverride?, roleOverride?, note? }` |
| `POST` | `/:emailId/review` | Resolve a review item. Discriminated body: `{ action: "LINK", applicationId }` \| `{ action: "CREATE" }` \| `{ action: "IGNORE", note? }` \| `{ action: "NOT_JOB" }` |
| `POST` | `/:emailId/reprocess` | Re-run the AI pipeline → `202 { jobId }` |

`GET /:emailId` example (abridged):

```json
{
  "success": true,
  "data": {
    "id": "clx…", "subject": "Congratulations! You've been shortlisted",
    "fromEmail": "careers@microsoft.com", "receivedAt": "2026-09-16T09:30:00.000Z",
    "processingState": "PROCESSED", "needsReview": false, "deletedFromGmail": false,
    "applicationId": "clx…",
    "analysis": { "category": "JOB", "subCategory": "SHORTLISTED", "priority": "HIGH", "confidence": 0.94, "…": "…" },
    "aiAnalysis": {
      "category": "JOB", "subCategory": "SHORTLISTED", "priority": "HIGH",
      "confidence": 0.94, "requiresAction": false, "needsReview": false,
      "summary": "Microsoft shortlisted your application for Software Engineer.",
      "reasoning": "Detected because the email uses shortlisting language.",
      "provider": "heuristic", "model": "heuristic:classifier@1.3.0",
      "promptVersion": "classifier@1.3.0", "analysedAt": "2026-09-16T09:31:04.000Z"
    },
    "application": { "id": "clx…", "company": "Microsoft", "role": "Software Engineer", "status": "SHORTLISTED" }
  }
}
```

---

## 7. Applications — `/api/applications`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Filters: `page`, `pageSize`, `sortBy` (`company`\|`role`\|`appliedDate`\|`status`\|`lastUpdated`\|`createdAt`), `sortDir`, `status` (single or repeated), `company`, `role`, `location`, `jobId`, `search`, `from`, `to`, `needsReview` |
| `GET` | `/summary` | `{ total, thisWeek, thisMonth, shortlisted, assessments, interviews, offers, rejected, withdrawn, active, needsReview, byStatus }` |
| `GET` | `/rejected` | Closed applications with `originalEmail` (subject, sender, snippet, `deletedFromGmail`) and the recorded `rejectionEvent` |
| `GET` | `/:applicationId` | Full record + `events[]` (timeline) + `emails[]` + `notifications[]` |
| `PATCH` | `/:applicationId` | `{ company?, role?, location?, jobId?, applicationUrl?, salary?, recruiterName?, recruiterEmail?, notes? }` |
| `POST` | `/:applicationId/status` | **User override.** `{ status, note? }` → writes a `USER_OVERRIDE` event |
| `POST` | `/:applicationId/notes` | `{ note, dueAt? }` → timeline note, or a tracked deadline when `dueAt` is given |
| `POST` | `/:applicationId/duplicate-decision` | `{ decision: "CONTINUE" \| "MERGE" }` — merge re-points emails/events/notifications and deletes the newer row |

Note on deletion semantics: `GET /rejected` returns rows whose `originalEmail` may
have `deletedFromGmail: true` or be `null` entirely. The structured record and its
timeline are always present — that is the point of the endpoint.

---

## 8. Notifications — `/api/notifications`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Filters: `page`, `pageSize`, `status`, `severity`, `type`, `requiresAck`, `unacknowledgedOnly`, `applicationId`. Each item includes `attempts[]` (per-channel delivery history) and `metadata.plan` (the escalation ladder) |
| `GET` | `/counts` | `{ unread, pendingAck, escalatedToday }` |
| `POST` | `/:notificationId/acknowledge` | `{ via?: "DASHBOARD" \| "SLACK" \| "WHATSAPP" \| "EMAIL" \| "VOICE" }`. **Stops the escalation ladder immediately** |
| `POST` | `/:notificationId/resolve` | Marks resolved without an acknowledgement |
| `POST` | `/:notificationId/pause` | `{ paused: boolean }` — suspend/resume the ladder |
| `POST` | `/:notificationId/retry` | Re-dispatch the initial channels → `202` |
| `POST` | `/reconcile` | Re-arm ladders for unacknowledged notifications; clear timers for settled ones |
| `POST` | `/sweep` | Safety-net sweep for overdue escalations whose delayed job was lost |

---

## 9. Cleanup — `/api/cleanup`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Filters: `page`, `pageSize`, `status`, `category`, `batchId`, `sender`. Items include the email preview and analysis |
| `GET` | `/summary` | `{ totalProposed, byCategory, bySender[], protectedCount, executedCount, lastProposalAt, autoCleanupEnabled }` |
| `POST` | `/approve` | **The only endpoint that can remove mail.** Body `{ emailIds: string[] (1–500), action: "DELETE" \| "ARCHIVE" \| "KEEP" \| "IGNORE_SENDER" }` |
| `POST` | `/:cleanupActionId/revert` | Restores an executed archive/trash action |

`POST /approve` response:

```json
{
  "success": true,
  "data": {
    "batchId": "batch_m1x2p3",
    "requested": 12, "executed": 10, "skipped": 0,
    "blocked": [{ "emailId": "clx…", "reason": "Job and recruitment emails are never deleted automatically." }],
    "failed": [],
    "message": "10 email(s) processed. 1 protected item(s) were left untouched."
  }
}
```

Semantics per action:

- `DELETE` → Gmail *Trash* (recoverable for 30 days), `deletedFromGmail = true`.
- `ARCHIVE` → removes the INBOX label; the message stays in All Mail.
- `IGNORE_SENDER` → applies the `mailops-ignored` label; the scanner's query
  excludes that label in future scans. Nothing is deleted.
- `KEEP` → clears the proposal; no Gmail call at all.

Protection is re-validated server-side for **every** item in the batch, regardless
of what the client sends.

---

## 10. Analytics and dashboard

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/analytics/overview?weeks=12` | Totals, funnel, rates, timings, per-company/per-role breakdowns, weekly + monthly activity series, inbox composition, cleanup impact, notification stats, `responseTimeByCompany` |
| `GET` | `/api/dashboard` | One call for the morning view: greeting, headline, summary, counters, scan schedule, cleanup summary, notification counts + recent, `attention[]` (ordered by the decision engine), recent applications, important emails, upcoming deadlines, 7-day activity |
| `GET` | `/api/dashboard/system` | Queue depth and availability, plus a `degraded` flag |

`attention[]` items carry `kind` (`ACTION_REQUIRED` \| `DEADLINE` \|
`IMPORTANT_UPDATE` \| `REJECTION` \| `REVIEW` \| `SYNC_PROBLEM`), `severity`,
`headline`, `detail`, `deadline`, `actionLabel`, `actionUrl`.

---

## 11. Settings, integrations, audit, privacy — `/api/settings`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | `{ account, settings, integrations[], capabilities, limits }` |
| `PATCH` | `/` | Strict settings patch. Every field is bounded (see `settingsPatchSchema`): e.g. `scanIntervalMinutes` 15–1440, `voiceMaxCallsPerDay` 0–10, `dataRetentionDays` 7–3650, `escalationDelaysMinutes` 1–1440 (max 5 entries) |
| `PUT` | `/integrations/:kind` | `{ displayName?, config?, secrets?, verify? }`. Secrets are encrypted before storage and never echoed. `verify: true` on Slack performs a live test post |
| `DELETE` | `/integrations/:kind` | Disconnects and deletes stored credentials |
| `GET` | `/audit` | Filters: `page`, `pageSize`, `action`, `actor`, `entityType`, `from`, `to` |
| `GET` | `/privacy` | Data inventory, retention state, available controls, AI-processing statement |
| `GET` | `/privacy/export` | Full JSON export (`Content-Disposition: attachment`) |
| `DELETE` | `/privacy/email-data` | `{ keepApplicationHistory: boolean }` — deletes stored emails and analyses |
| `POST` | `/privacy/retention-sweep` | Run the retention sweep for the caller on demand |
| `GET` | `/diagnostics` | Database/Redis reachability, queue health, encryption key fingerprint (**never** key material), AI provider, environment |

### Additional top-level endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/integrations` | Integration status list (secret-free) |
| `GET` | `/api/integrations/:kind` | Single integration status |
| `GET` | `/api/meta/taxonomy` | Canonical enums the UI renders (categories, sub-categories, statuses, priorities, channels, escalation stages, cleanup actions, voice event keys) |

---

## 12. Worked examples

### Acknowledge a notification (stops escalation)

```bash
curl -X POST http://localhost:4000/api/notifications/<id>/acknowledge \
  -b cookies.txt \
  -H "X-CSRF-Token: $(grep mailops_csrf cookies.txt | awk '{print $7}')" \
  -H 'Content-Type: application/json' \
  -d '{"via":"DASHBOARD"}'
```

### Approve a cleanup batch

```bash
curl -X POST http://localhost:4000/api/cleanup/approve \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' \
  -d '{"emailIds":["clx1","clx2"],"action":"ARCHIVE"}'
```

### Resolve an ambiguous application match

```bash
curl -X POST http://localhost:4000/api/emails/<emailId>/review \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' \
  -d '{"action":"LINK","applicationId":"clx_app_1"}'
```

### Correct the AI's classification

```bash
curl -X PATCH http://localhost:4000/api/emails/<emailId>/analysis \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' \
  -d '{"subCategory":"INTERVIEW","note":"This is an interview invite, not an assessment"}'
```

### Trigger a scan and poll status

```bash
curl -X POST http://localhost:4000/api/gmail/scan -b cookies.txt \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -d '{}'

curl http://localhost:4000/api/gmail/scan/status -b cookies.txt
```

### Configure Slack and verify the webhook

```bash
curl -X PUT http://localhost:4000/api/settings/integrations/SLACK \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"#job-search","verify":true,"secrets":{"webhookUrl":"https://hooks.slack.com/services/…"}}'
```
