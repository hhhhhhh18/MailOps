# P0-1 — Account Deletion / Complete Data Erasure: Architecture Audit

**Status:** AUDIT ONLY. No files, schema, migrations or dependencies were modified.
**Scope inspected:** `backend/prisma/schema.prisma` (780 lines, 16 models), auth service/middleware/routes/controllers,
cleanup service, audit service, queue registry, all 6 workers, notification dispatcher/channels, Gmail OAuth service,
settings controller/routes, frontend Settings privacy surface.
**Date:** 2026-09-26

---

## 0. Executive summary

**The single most important finding:** every one of the **14 relations originating from `User` is already
`onDelete: Cascade`**, and that cascade is enforced by PostgreSQL foreign keys (Prisma `relationMode` is the default
`foreignKeys`). A single `prisma.user.delete()` therefore already erases all 16 user-owned tables, including
`NotificationAttempt` transitively. The database layer is not the problem.

**What is missing is everything around the database.** Five things cannot be done by cascade, and one of them is an
ordering constraint that silently fails if you get it wrong:

1. **Gmail OAuth revocation must happen before the row is deleted.** The refresh token lives *in* the row that the
   cascade destroys. If you delete first, the grant stays live in the user's Google account with no way to revoke it.
   `disconnectGmailAccount()` already implements revocation and is reusable.
2. **The audit receipt cannot be written after the delete** — `recordAudit()` inserts `AuditLog.userId`, a non-nullable
   FK. After the user row is gone the insert raises an FK violation, and `recordAudit()` **swallows all errors** and
   only logs a warning. So the code path would appear to succeed while recording nothing.
3. **Redis job payloads retain `userId` / `emailId` after deletion.** `removeOnComplete: { count: 500 }` means completed
   job payloads persist. The existing helper `obliterateUserJobs()` covers exactly one queue and one job-id shape.
4. **The `voice:calls:{userId}:{date}` Redis key embeds the userId in the key name.**
5. **`AuditLog` is the one genuine policy decision** (Section 6) — it is the only table where "delete everything" and
   "retain for security/legal reasons" pull in opposite directions.

**Recommendation: Option C — DB cascades for the bulk erasure, wrapped in an explicit orchestration service for the
pre-flight (revoke + count), the post-flight (Redis), and the receipt.** Detailed reasoning in Section 7. The decisive
argument is *drift resistance*: hand-enumerating 16 models in a service means the 17th model added next sprint leaks
data silently. Relying on the FK cascade means a new model fails **loudly** (FK violation) instead of quietly retaining
data.

---

## 1. Complete User-owned data inventory

### 1.1 Database (16 models, all reachable from `User`)

| # | Model | Relation to User | `userId` col | User-owned data | Email/body/content | Credential/token/secret | onDelete vs User |
|---|-------|------------------|:---:|:---:|:---:|:---:|:---:|
| 1 | `User` | **root** | — | email, name, avatarUrl, timezone, lastLoginAt, emailVerifiedAt, passwordHash, isDemo | — | passwordHash | — |
| 2 | `UserSettings` | 1:1 (`userId` @unique) | ✅ | scan cadence, channel prefs, quiet hours, retention policy | — | — | **Cascade** |
| 3 | `GmailAccount` | 1:N | ✅ | emailAddress, grantedScopes, historyId, sync cursor | — | **accessTokenEnc, refreshTokenEnc** | **Cascade** |
| 4 | `Email` | 1:N | ✅ | fromName, fromEmail, toEmail, subject, snippet, `bodyText`, labels | **yes — full body when `storeEmailBody`** | — | **Cascade** |
| 5 | `EmailAnalysis` | 1:N | ✅ | reasoning, summary, `extracted` JSON (company/role/recruiter/salary) | **yes — derived from body** | — | **Cascade** |
| 6 | `Application` | 1:N | ✅ | company, role, jobId, location, salary, applicationUrl, `recruiterName`, `recruiterEmail`, notes | yes (recruiter PII) | — | **Cascade** |
| 7 | `ApplicationEvent` | 1:N | ✅ | title, description, from/to status, `metadata` JSON, dueAt | yes (career timeline) | — | **Cascade** |
| 8 | `Notification` | 1:N | ✅ | title, `body`, actionUrl, `metadata` JSON, ack state | sometimes | — | **Cascade** |
| 9 | `NotificationAttempt` | **transitive** via Notification | ❌ **none** | error text, providerMessageId, sentAt | — | — | **Cascade (via Notification)** |
| 10 | `Integration` | 1:N (`@@unique[userId,kind]`) | ✅ | `config` JSON (channel ids, **phone numbers**, recipients) | — | **`secretsEnc`** (Slack webhook, Meta token, Twilio SID+authToken, AI key) | **Cascade** |
| 11 | `CleanupAction` | 1:N | ✅ | senderEmail, reason, protectedReason, `audit` JSON, batchId | yes (sender address) | — | **Cascade** |
| 12 | `ScanJob` | 1:N | ✅ | cursor, error, counters, triggeredBy | — | — | **Cascade** |
| 13 | `AuditLog` | 1:N | ✅ | action, entityType/Id, summary, `metadata` JSON, **ip, userAgent** | possible in metadata | — | **Cascade** |
| 14 | `RefreshToken` | 1:N | ✅ | **ip, userAgent** | — | tokenHash | **Cascade** |
| 15 | `PasswordResetToken` | 1:N | ✅ | requestedByIp | — | tokenHash | **Cascade** |
| 16 | `EmailVerificationToken` | 1:N | ✅ | — | — | tokenHash | **Cascade** |

**No attachments are stored** — `Email.hasAttachments` is a boolean only; there is no blob/attachment table and no
filesystem or object-storage reference in the schema. Confirmed by inspection.

**No billing/payment records exist.** There is no Invoice, Subscription, Payment or Plan model. This matters for
Section 12 — adding payments later introduces records that legally **cannot** be deleted, and today's
"everything cascades" schema would happily delete them.

### 1.2 Outside PostgreSQL

| Store | What | User-identifiable? | Reached by `user.delete()`? |
|---|---|---|---|
| Redis — BullMQ `emailScan` | `{ userId, gmailAccountId, type, triggeredBy }` | **yes** | ❌ no |
| Redis — BullMQ `emailProcessing` | `{ emailId, userId, force }` | **yes** | ❌ no |
| Redis — BullMQ `applicationProcessing` | `{ userId, emailId, applicationId, analysisId }` | **yes** | ❌ no |
| Redis — BullMQ `cleanup` | `{ userId, batchId, emailIds[], action }` | **yes** | ❌ no |
| Redis — BullMQ `notification` | `{ notificationId }` | no | ❌ no |
| Redis — BullMQ `escalation` | `{ notificationId, stage }` | no | ❌ no |
| Redis — completed/failed job bodies | retained per `removeOnComplete/removeOnFail` | **yes** | ❌ no |
| Redis — `voice:calls:{userId}:{YYYY-MM-DD}` | call counter, **userId in the key** | **yes** | ❌ no |
| Redis — `scheduler:daily:{date}` | daily-job guard | no | n/a |
| Redis — in-memory OAuth `pendingStates` | `{ userId, nonce, createdAt }` in a module-level `Map` | **yes** | ❌ no (ephemeral, TTL-bounded, per-process) |
| Application logs | redacted via `redactSecrets`; `ip`/`userAgent`/`userId` appear in structured logs | **partly** | ❌ no |
| External providers | Google grant, Slack channel, Meta, Twilio, AI provider | **yes** | ❌ no |
| Backups | none implemented yet (P0-10) | — | ❌ n/a today, **⚠️ future** |

---

## 2. Prisma relation / deletion map

```
User
├── UserSettings                      (1:1)  ── cascade
├── GmailAccount                      (1:N)  ── cascade
│   ├── Email                         (1:N)  ── cascade  [FK gmailAccountId]
│   │   ├── EmailAnalysis             (1:1)  ── cascade  [FK emailId]
│   │   ├── Notification              (1:N)  ── SetNull  [FK emailId]
│   │   ├── CleanupAction             (1:N)  ── SetNull  [FK emailId]
│   │   └── ApplicationEvent          (1:N)  ── SetNull  [FK emailId]
│   └── ScanJob                       (1:N)  ── cascade  [FK gmailAccountId]
├── Email                             (1:N)  ── cascade  (also FK userId)
├── EmailAnalysis                     (1:N)  ── cascade  (also FK userId)
├── Application                       (1:N)  ── cascade
│   └── ApplicationEvent              (1:N)  ── cascade  [FK applicationId]
├── ApplicationEvent                  (1:N)  ── cascade  (also FK userId)
├── Notification                      (1:N)  ── cascade
│   └── NotificationAttempt           (1:N)  ── cascade   ★ no userId of its own
├── Integration                       (1:N)  ── cascade  ★ holds encrypted secrets
├── CleanupAction                     (1:N)  ── cascade
├── ScanJob                           (1:N)  ── cascade
├── AuditLog                          (1:N)  ── cascade  ◆ retention decision
├── RefreshToken                      (1:N)  ── cascade  ★ credential material
├── PasswordResetToken                (1:N)  ── cascade  ★ credential material
└── EmailVerificationToken            (1:N)  ── cascade  ★ credential material
```

**Two-level propagation.** `Email`, `Application` and `Notification` each carry **two** FKs into the user's ownership
graph (a direct `userId` card-cascade *and* a parent FK with `SetNull`). Deleting the `User` deletes the parent rows in
the same statement, so the `SetNull` rules never fire on surviving rows — they exist to keep the graph consistent when
an *individual* email is deleted (the retention sweep and `purgeUserEmailData` rely on exactly that behaviour). This
mixed cascade shape is correct but is the reason the deletion must be verified by counting rows rather than assumed
(Section 11).

**Anything NOT cascade?** No. All 14 `User`-originating relations are `Cascade`; there is no `Restrict`, `NoAction` or
`SetNull` pointing at `User`. This is the property that makes Option C work.

---

## 3. Current cascade behaviour

**Verified from the schema, not assumed:**

- **All 14 direct `User` relations: `onDelete: Cascade`.** → `prisma.user.delete()` removes every user-owned row.
- **`NotificationAttempt`: no `userId`.** It is reachable only through `Notification`, which is why it needs no direct
  rule — the cascade reaches it one level deeper. It must not be forgotten, and it must not be independently orphaned.
- **`Email.applicationId`, `ApplicationEvent.emailId`, `Notification.emailId`, `CleanupAction.emailId/applicationId`:
  `SetNull`.** These preserve history when an *email* is deleted — the deliberate design recorded at the top of
  `schema.prisma` ("Structured application history is INDEPENDENT of the original email").
- **Enforcement is at the database level.** Prisma's default `relationMode = "foreignKeys"` means the `ON DELETE`
  clauses in the generated migration are what actually run. A raw SQL `DELETE FROM "User"` behaves identically to
  `prisma.user.delete()`.
- **A plain `prisma.user.delete()` is a single statement**, so it is atomic without an interactive transaction and is
  **not subject to Prisma's 5-second interactive-transaction timeout** — a real advantage for a user with tens of
  thousands of `Email` rows, where an explicit per-model delete loop inside `$transaction(async …)` could time out
  mid-way. (An explicit multi-statement approach would need `{ timeout: … }`.)
- **`requireAuth` already rejects deleted users.** `middleware/auth.ts:41` performs a DB existence check and throws
  `"Your account is no longer available."`, explicitly commented as keeping "deleted/disabled accounts from holding a
  valid signing key for the token's lifetime". With `JWT_ACCESS_TTL_SECONDS = 900`, a deleted user's access token is
  therefore **invalid immediately**, not in 15 minutes. **No new work is needed to invalidate sessions** beyond
  clearing cookies.
- **⚠️ `optionalAuth` does NOT do that check** (`middleware/auth.ts:55`) — it trusts the JWT claims and hard-codes
  `isDemo: false`. It is currently **unreferenced dead code**, so there is no live gap, but it is a loaded gun for
  whoever wires it up next.

---

## 4. External credential cleanup analysis

`disconnectGmailAccount()` (`services/gmail/oauth.service.ts:290`) already implements the exact primitive needed:

```
decrypt refreshTokenEnc ?? accessTokenEnc  →  createOAuthClient()  →  client.revokeToken(token)
→ prisma.gmailAccount.update({ status: "DISCONNECTED", secretsEnc: null })
```
Revocation failure is logged as a warning and is **non-fatal** — the correct posture to inherit. It requires
`isGmailConfigured()` (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET present).

| External system | Credential MailOps holds | Stored where | Programmatic revocation available **today**? | What deletion can actually do |
|---|---|---|---|---|
| **Google / Gmail** | OAuth2 refresh + access token | `GmailAccount.accessTokenEnc/refreshTokenEnc` | ✅ **YES** — `client.revokeToken()` | **Fully revoke the grant** (must run *before* the cascade). This is the only true revocation in the codebase. |
| **Slack** | Incoming webhook URL | `Integration.secretsEnc` | ❌ **NO** | Delete the row (destroys our copy). The webhook itself stays live in the Slack workspace until an admin removes the app. **User action required.** |
| **WhatsApp** | Meta Cloud API access token, `phoneNumberId`, recipient number | `Integration.secretsEnc` + `config` | ❌ **NO** | Delete the row. Token revocation is a Business Manager action. **User action required.** `config.to` (their phone number) is deleted with the row. |
| **Voice (Twilio)** | `accountSid` + `authToken` — **the user's own** Twilio credentials | `Integration.secretsEnc` | ❌ **NO** (and should not) | Delete the row. These are the user's credentials, not a grant we issued; they rotate them on their side. |
| **Email channel** | SMTP credentials / recipients | `Integration.secretsEnc` + `config` | ❌ NO | Delete the row. |
| **AI provider** | API key | `Integration.secretsEnc` | ❌ NO | Delete the row. |
| **Already-delivered messages** | — | Slack / WhatsApp / Twilio / SMTP | ❌ **impossible** | Cannot recall messages already sent. Must be disclosed. |
| **AI provider-side retention** | prompt/response history | provider systems | ❌ **not integrated** | See risk R6. |

**Conclusion:** of six external integrations, **exactly one (Gmail) can be revoked programmatically.** The rest can only
have their stored credentials destroyed. The UI must present the remaining manual steps as explicit, honest guidance
rather than implying the credentials are dead.

---

## 5. Background-job risk analysis

**Queues** (6): `emailScan`, `emailProcessing`, `applicationProcessing`, `notification`, `cleanup`, `escalation`.
Payload-bearing PII queues: the first four. The last two carry only opaque ids (`notificationId`, `stage`).

| Risk | Verdict | Reasoning from the actual code |
|---|---|---|
| **Processing after deletion** | ⚠️ **Yes, jobs will still run** | No cancellation exists. But they cannot recreate user data: every insert carries a `userId` FK, and Postgres checks it at write time, so once the `User` row is gone the write raises an FK violation. Failures, not corruption. |
| **Recreation of user-owned data** | ✅ **Not possible** | Same FK argument. `prisma.user.delete()` removes the row the FK points at, so a late `application.create` / `email.create` cannot commit. |
| **Gmail re-ingestion after deletion** | ✅ **Not possible** | `scanDueAccounts()` selects `gmailAccount` rows that no longer exist; the scan worker needs a live account to fetch. Deleting the account kills the ingestion path. |
| **Notification delivery after deletion** | ✅ **Safe by construction** | `dispatchNotification()` returns an empty no-op outcome when the `Notification` row is missing (`dispatcher.service.ts:36`). Same for escalation: `sweepOverdueEscalations()` queries `Notification` rows. **This queue is already deletion-safe.** |
| **Access to deleted credentials** | ⚠️ **Ordering-dependent** | If revocation happens before the delete, in-flight jobs hold a dead token and fail cleanly. If a job already decrypted a token into memory, it may complete once. Revoking first shrinks the window to milliseconds. |
| **Cleanup acting on the user's real Gmail after erasure** | 🔴 **Genuine side-effect risk** | `enqueueCleanup({ userId, batchId, emailIds })` calls the Gmail API to archive/trash messages. A queued or delayed cleanup job could **modify the user's mailbox after they asked for erasure**. This is the one job that produces an externally visible effect, and it is not prevented by the FK argument. Revoking the grant first is what stops it. |
| **Residual PII in Redis** | 🔴 **Yes** | Payloads for the four PII queues, plus retained completed/failed job bodies (`removeOnComplete: {count:500}`, `removeOnFail: {count:1000}`), plus `voice:calls:{userId}:{date}` with the userId **in the key name**. |
| **`obliterateUserJobs()` is inadequate** | 🔴 | `queues/index.ts:189` removes only `email:${emailId}` on the `emailProcessing` queue. It misses (a) the `:${Date.now()}` suffix used for forced reprocessing, (b) all five other queues, (c) completed/failed bodies, (d) the voice counter. Its docstring ("delete my MailOps data") also overstates what it does. |

### Recommended job safety measures

1. **Revoke the Gmail grant and mark the account `DISCONNECTED` before anything else** — this neutralises every
   worker that needs Google, including the cleanup job that writes to Gmail.
2. **Purge the queues by userId, not by assumed job id.** For each PII-bearing queue, enumerate jobs
   (`getJobs`/`getWaiting`/`getDelayed`/`getFailed`/`getCompleted`) and remove those whose payload matches the userId;
   plus `queue.clean(0, N, "completed"|"failed")` for retained bodies. Never rely on reconstructing a job id.
3. **Delete the `voice:calls:*` keys** for the user.
4. **Defence in depth in the workers themselves** — have the PII-bearing processors re-assert that the `User` still
   exists at the top of the handler and return early if not. The FK guarantee is real but produces noisy error logs and
   pointless retries for a deleted account, and it does not cover work that has no DB write (e.g. the Slack/voice send).
5. **Wrap payload ids in a deletion tombstone (optional, stronger).** A short-lived Redis key
   (`deleting:{userId}`, TTL ≈ max job lifetime) checked by workers makes cancellation deterministic rather than
   relying on FK timing. Worth it only if job volume makes the enumeration in step 2 impractical.
6. **Retire `obliterateUserJobs()`** or fix it to the above; leaving it as-is invites a future caller to trust it.

---

## 6. Audit-log retention recommendation

This is the one place where two first-principles rules genuinely conflict, and I will not resolve it silently.

**The tension, stated in the codebase's own terms.** `audit.service.ts:10` declares: *"Audit records are append-only
and are never deleted when the related email is deleted — the whole point is that the user can see what MailOps did
even after the underlying Gmail message is gone."* That rule is about **email** deletion. Account deletion is a
different trigger with a different legal basis, and it legitimately overrides append-only for user-scoped content. But
a *minimal* record that the erasure happened should survive, because "we cannot demonstrate that we deleted the data"
is itself a compliance failure (GDPR Art. 5(2) accountability).

**What an `AuditLog` row actually contains:** `action`, `entityType`, `entityId`, `summary`, `metadata` JSON,
**`ip`**, **`userAgent`**, `createdAt`. So it mixes (a) operational history, (b) network identifiers, and (c)
occasionally content-adjacent details inside `summary`/`metadata`.

| | Option A — delete with the account | Option B — retain, anonymized | Option C — minimal receipt + scoped retention |
|---|---|---|---|
| **Privacy posture** | Strongest; matches "complete erasure" | Weakest unless genuinely anonymized | Strong; keeps only what has a purpose |
| **Provable erasure** | ❌ none | ✅ | ✅ receipt survives |
| **Abuse / fraud investigation** | ❌ destroyed | ✅ | ⚠️ only if security events are explicitly retained |
| **Breach forensics after departure** | ❌ | ✅ | ⚠️ partial |
| **Schema change** | none | requires `AuditLog.userId` nullable + `SetNull` | one new table, no FK change |
| **Implementation risk** | lowest | 🟠 makes `userId` nullable → every audit query must handle nulls | low, additive |
| **Honesty of "anonymized"** | n/a | ⚠️ **`ip` is personal data (GDPR). Nulling `userId` alone is *pseudonymization*, not anonymization** | ✅ by design |

**Recommendation: Option C.** Concretely:

1. **Delete all `AuditLog` rows for the user** via the existing cascade. They are user-scoped, they contain the user's
   `ip`/`userAgent`, and their main audience (the in-app "what MailOps did" view) ceases to exist when the account does.
2. **Write one `AccountDeletionRecord` row *before* the delete** — in a new table with **no FK to `User`**: `id`,
   `deletedUserIdHash` (HMAC of the id, so it is not a re-identifier but is matchable against a support ticket),
   `requestedAt`, `completedAt`, `initiator` (`USER` | `ADMIN`), `emailDomainHash` or nothing, `countsByModel` JSON,
   `gmailGrantRevoked` bool, `revokeFailures` JSON, `requestedByIpHash`. This is the accountability artifact and it is
   genuinely de-identified.
3. **Optionally retain a narrow security-event subset** (e.g. repeated failed logins, `security.*` actions) in
   de-identified form (no `ip`, no `userAgent`, userId replaced by the same HMAC) if the product wants abuse
   protection. Only if there is a stated purpose and a retention period — otherwise it is unjustified retention.
4. **Document the retention basis** in the privacy policy: what survives, why (accountability + fraud prevention,
   GDPR Art. 17(3) / Art. 6(1)(f)), and for how long.

Reasoning against Option A alone: after it, MailOps has **zero** evidence it ever performed an erasure, cannot answer a
regulator's "prove you deleted it", and cannot investigate a fraud ring that signs up, abuses the AI quota, and deletes.
Reasoning against Option B as usually implemented: keeping the row and nulling `userId` while retaining `ip` +
`userAgent` + timestamp is **not** anonymization, and it would be dishonest to label it as such.

**Forward-looking flag:** the moment billing is added, invoices become records MailOps is **legally required** to
retain for tax law and the deletion service must be able to *preserve* them. Today's schema cascades every user
relation, so a future `Invoice` model with a cascade FK would silently destroy statutory records. The P0-1 design
should therefore include an explicit "retained-by-obligation" concept rather than assuming erasure is total.

---

## 7. Recommended deletion architecture

**Option C — database cascades for bulk erasure, wrapped in an explicit orchestration service.**

### Why not Option A (pure cascade)?

It is one line and it is nearly right, but it cannot do the four things in Section 0: revoke before delete, count what
was deleted, clean Redis, or record a receipt. Pure cascade also gives the user **no transparency report**, which is
what "complete data erasure" should be able to show.

### Why not Option B (explicit transactional deletion of all 16 models)?

**Drift is the disqualifier.** An explicit list of 16 models is a maintenance liability: the 17th user-owned model
added in a future sprint is erased only if someone remembers to update the service, and the failure mode is **silent
data retention** — the worst possible outcome for a privacy feature. It also puts a large multi-statement delete inside
an interactive transaction, risking Prisma's 5-second timeout on a large account and a partially-deleted user, and it
would need to replicate the FK ordering (`NotificationAttempt` before `Notification`, etc.) that the database already
knows.

### The recommended shape

```
ObliterateUserAccountService.obliterate(userId, { actor, confirmation })

Phase 0 — PRE-FLIGHT (no writes to user content)
  • load user + counts for every owned model (also the "what will be deleted" preview)
  • self-delete guard: refuse if isDemo
  • collect the external-revocation plan

Phase 1 — EXTERNAL REVOCATION (must precede any row deletion)
  • for each GmailAccount: disconnectGmailAccount() → revokeToken()
      - failure is NON-FATAL but recorded (mirrors the existing disconnect contract)
  • for each Integration: record manual-revocation guidance (Slack/Meta/Twilio — see §4)

Phase 2 — THE ERASURE (single statement, DB cascades)
  • persist AccountDeletionRecord (no FK to User)
  • prisma.user.delete({ where: { id } })
      → one statement, atomic, no interactive-transaction timeout,
        cascades all 16 tables including NotificationAttempt

Phase 3 — OUTSIDE-POSTGRES CLEANUP (idempotent, best-effort, retryable)
  • purge queue jobs by userId (4 PII queues) + retained completed/failed bodies
  • delete voice:calls:{userId}:* keys
  • log the outcome (redacted) and, on partial failure, flag for the retry sweep

Phase 4 — RESPONSE
  • clear auth cookies (access + refresh + csrf)
  • return countsByModel, gmailGrantRevoked, and manualSteps[]
```

**Failure semantics.** Phase 1 failures never block erasure (a user's right to erasure must not depend on Google being
reachable) — they are recorded so an operator can follow up. A Phase 2 failure means **nothing** was deleted (single
statement) and the API returns an error with the user intact: correct and safe. Phase 3 failures leave residue only in
Redis and are retryable, which is why the receipt exists.

**Why the receipt is written before Phase 2, not after:** `recordAudit()` inserts a non-nullable `userId` FK and
swallows every error, so an audit call after the delete would silently record nothing. The receipt must be a
pre-delete insert into a table with no `User` FK.

**Reuse, don't reinvent.** Existing pieces to build on: `disconnectGmailAccount`, `revokeAllSessions`,
`purgeUserEmailData` (as the model for the "count → delete → report" shape), `AUDIT_ACTIONS.dataPurged`,
`blockDemoWrites`, `securityRateLimit`/`authRateLimit`, `sanitizeForAudit`, `redactSecrets`.

**Note the two distinct intents and do not conflate them.** `purgeUserEmailData({ keepApplicationHistory })` answers
*"stop reading my email, keep my timeline"*. Account deletion answers *"erase me"* and must have **no**
`keepApplicationHistory` option — the whole point is total erasure. Offering the flag on the account-deletion endpoint
would be a design error and a support nightmare.

---

## 8. Required schema changes

**The cascade itself needs no change** — all 14 `User` relations are already `Cascade` and must be left alone.

| # | Change | Needed? | Purpose |
|---|---|---|---|
| 1 | New model `AccountDeletionRecord` (**no FK to `User`**) | ✅ **recommended** | Surviving de-identified receipt (§6 Option C) — cannot be achieved with a `User` FK in place |
| 2 | `AuditLog.userId` → nullable + `SetNull` | ❌ **not recommended** | Only if choosing Option B; would force null-handling into every audit query for a worse privacy outcome than Option C |
| 3 | `User.deletionRequestedAt DateTime?` (+ scheduler-driven finalisation) | ❌ **not for v1** | Only if a grace period is chosen (§9). Adds state to the scanner, notifier and login paths |
| 4 | `User.erasureBlockedAt DateTime?` / legal-hold flag | ⚠️ **note for later** | Litigation hold must be able to *suspend* deletion. No such mechanism exists today |
| 5 | `Invoice` / `Subscription` with **`Restrict`** (not cascade) FK | ⚠️ **future, P1** | Statutory retention must survive erasure; a cascade FK here would be a compliance bug |

Also required in the migration: indexes on `AccountDeletionRecord.requestedAt` and (for matching) the hashed id.

---

## 9. Security design decisions

| Question | Recommendation | Reasoning |
|---|---|---|
| **Who can request deletion** | The authenticated user, for **their own** account only | `requireAuth` + `currentUserId`; no user id in the request body, so there is no IDOR surface. **No admin/support path exists** — there is no role model in the schema at all (Section 12) |
| **Authentication required** | ✅ `requireAuth` | Non-negotiable |
| **CSRF required** | ✅ existing double-submit middleware | Must confirm the new route is not in any CSRF exemption; verify a 403 with no token, as was done for P0-4 |
| **Re-authentication** | ✅ **required** | Deletion is the highest-impact irreversible action in the product. Note `User.passwordHash` is nullable — fine while password login is the only method, but if SSO is added the re-auth factor must be revisited |
| **Password confirmation** | ✅ **required** | A live session is not sufficient proof of intent; a stolen session must not be able to destroy an account |
| **Confirmation phrase** | ✅ **type the account email address** | Prevents accidental submission *and* proves the user knows which account they are in (meaningful for multi-account users) |
| **Immediate vs delayed** | **Immediate for v1** | A grace period requires a soft-delete state threaded through the scanner, notifier, escalation ladder and (later) billing — broad, error-prone surface. Immediate is contained, atomic and matches "without undue delay". Revisit once there is a soft-delete concept. Honest tradeoff: immediate is **unforgiving**, which is exactly why password + phrase are mandatory |
| **Revoke all sessions** | ✅ `revokeAllSessions(userId)` **and** clear all auth cookies | Refresh tokens cascade anyway, but explicit revocation is the auditable act. `requireAuth`'s DB check already kills outstanding access tokens instantly — verified in §3 |
| **Rate limit** | ✅ reuse `authRateLimit` | Blocks a compromised session from hammering the endpoint |
| **Demo account** | ✅ `blockDemoWrites` | The demo account is shared; deleting it must be impossible |
| **Audit** | Record the receipt **before** the delete; never log the password, tokens, cookies or the raw confirmation input | `recordAudit` swallows errors — an audit call in the wrong place fails silently |
| **Data minimisation in logs** | Reuse `redactSecrets`; never log the account email in the deletion log line | Consistent with the P0-4 redaction work |

**Verify these security properties, don't assume them:** that a *second*, concurrent deletion request cannot deadlock
or produce a partial state (the single-statement delete makes each request atomic; the second sees no row and should
return 404/401, not 500).

---

## 10. Required API endpoints

| Method | Path | Protection | Notes |
|---|---|---|---|
| `GET` | `/api/settings/privacy/deletion-preview` | `requireAuth` | Returns per-model counts + the manual-steps list. **Prefer extending the existing `GET /api/settings/privacy`** (which already returns a `database` counts block) over adding a near-duplicate route. Supports informed consent before a destructive act |
| `DELETE` | `/api/auth/account` | `requireAuth`, CSRF, `authRateLimit`, `blockDemoWrites` | Body `{ password, confirmation }`; confirmation must equal the account email. Clears cookies; returns `{ deleted: true, countsByModel, gmailGrantRevoked, manualSteps[] }` |
| — | *(existing `DELETE /api/settings/privacy/email-data`)* | unchanged | Keep it. It is a **different intent** (§7) |
| — | *(new `AUDIT_ACTIONS.accountDeleted` / `accountDeletionRejected`)* | — | Add to `audit.service.ts`; rejected attempts (wrong password, wrong phrase) are security-relevant and should be logged |

Do **not** accept a target user id from the client. Do **not** add a `keepApplicationHistory` flag here.

---

## 11. Required frontend changes

1. **Danger zone inside the existing `PrivacySection`** (`app/(app)/settings/page.tsx:885` — reuse `Card`, `Button`,
   `InlineAlert`, `useToast`; do **not** redesign).
2. **Pre-deletion inventory** rendered from the preview endpoint: what will be deleted (emails, analyses,
   applications, timeline, notifications, connections, sessions) so consent is informed.
3. **Confirmation dialog** requiring: typed account email + current password, with the destructive action gated until
   both are valid.
4. **Explicit manual-steps disclosure**: only Gmail is revoked automatically; Slack / WhatsApp / Twilio must be
   removed by the user — and messages already delivered cannot be recalled.
5. **Post-deletion flow**: `queryClient.clear()` (no stale cached user data left in memory), redirect to `/login` with
   a confirmation state.
6. **Graceful handling of the now-invalid session**: `requireAuth` returns *"Your account is no longer available."* —
   the existing 401 handling must surface that rather than a generic error.
7. **Demo account**: the control must be hidden or disabled for `isDemo` users, matching the server guard.

---

## 12. Required tests

**Security / auth (no DB)**
- Unauthenticated → 401; missing CSRF → 403; cookie/header mismatch → 403.
- Wrong password → 400/403 and **account still intact**; wrong/missing confirmation phrase → rejected.
- Demo account → blocked.
- Rate limiting applies (own file, per the P0-4 lesson about limiter contamination).
- Raw password / tokens never appear in the response body or in audit metadata.

**Erasure completeness (integration) — the core suite**
- **Per-model zero-row assertion:** create a fully-populated user (Gmail account, emails, analyses, applications,
  events, notifications **with attempts**, integrations, cleanup actions, scan jobs, audit logs, all three token
  tables, settings), delete, then assert **0 rows in all 16 tables** for that id. Explicitly include
  `NotificationAttempt` — it is the model with no `userId`, and the whole reason to enumerate 16 rather than 15.
- **Multi-user isolation:** a second user's rows are untouched.
- **Idempotency:** a second delete → 404/401, not 500; a concurrent double-delete leaves no partial state.
- **Post-deletion auth:** login fails; the old access token is rejected with *"Your account is no longer available."*;
  refresh fails; cookies are cleared.
- **Counts returned** match what was actually deleted (so the user-facing report is truthful).

**Drift guard — the highest-value test**
- **A schema-inventory test** that reads the Prisma DMMF, enumerates every model containing a `userId` field, and
  asserts each one is either cascade-covered or explicitly acknowledged by the deletion service. This converts the
  "someone forgets model #17" failure from silent data retention into a failing build. Without it, Option C's main
  advantage is a claim rather than a property.

**External revocation**
- Gmail: `revokeToken` **called before** the DB delete (assert call ordering with a mocked OAuth client); revoked on
  success; revoke failure still completes the erasure **and** records the failure; per-account behaviour with two
  connected accounts.
- Integrations: rows deleted; manual-steps guidance returned for Slack/WhatsApp/Voice.

**Background jobs**
- Enqueue jobs on all four PII queues, delete the user, run each worker → no re-created rows, no unhandled exception.
- Queue purge removes the user's jobs **and** retained completed/failed bodies.
- `voice:calls:{userId}:*` keys gone.
- Notification/escalation jobs for a deleted user no-op cleanly (the existing safe path).

**Receipt**
- `AccountDeletionRecord` written exactly once, **before** deletion, containing no raw email, no `ip`, no token; the
  hashed id is not reversible but matches a recomputation.

---

## 13. Risks and unknowns

| # | Risk / unknown | Severity | Note |
|---|---|:---:|---|
| R1 | **Audit retention is a policy decision, not a technical one** | 🟠 | Option C recommended (§6) but **needs product/legal sign-off** before implementation |
| R2 | **Billing records will break total erasure** | 🔴 | No Invoice/Subscription exists today. When added, statutory retention requires a `Restrict` FK — today's "everything cascades" schema would silently delete tax records |
| R3 | **Backups are not covered** | 🔴 | No backup system exists yet (P0-10). Erasure is only **complete** once backup retention expires. Must be disclosed; do not claim instantaneous total erasure |
| R4 | **AI-provider-side retention is outside MailOps' control** | 🟠 | No provider deletion API is integrated. Whether prompts/responses are retained, and for how long, is **unknown** and depends on vendor terms — verify before making any claim about AI data |
| R5 | **`metadata` / `audit` / `extracted` JSON columns are opaque** | 🟠 | `AuditLog.metadata`, `Notification.metadata`, `ApplicationEvent.metadata`, `CleanupAction.audit`, `EmailAnalysis.extracted` may hold content-adjacent PII beyond what the columns name. A manual sample review is needed before asserting "complete" erasure |
| R6 | **The Gmail cleanup side-effect window** | 🟠 | A queued cleanup job can modify the user's real mailbox. Revoking first shrinks but does not formally eliminate the window; a worker-side existence re-check is the durable fix |
| R7 | **Residual PII in Redis** | 🟠 | Job payloads + retained completed/failed bodies + `voice:calls:{userId}:*`. Requires Phase 3 to be implemented, and it is best-effort/retryable, not transactional |
| R8 | **`obliterateUserJobs()` is misleading and incomplete** | 🟡 | Retire or fix it; a future caller trusting its name would leave data behind |
| R9 | **No admin/support deletion path** | 🟡 | There is no role model in the schema. A user who loses access to their email cannot have their account deleted by support today |
| R10 | **`optionalAuth` trusts JWTs without a DB check** | 🟡 | Dead code today; becomes a hole the moment it is used on a user-scoped route |
| R11 | **Large-account cascade performance** | 🟡 | A single-statement cascade over 14 tables is atomic but can be slow/lock-heavy for tens of thousands of emails. Needs a load sanity check; the single-statement form avoids the transaction-timeout trap |
| R12 | **No litigation-hold / erasure-suspension mechanism** | 🟡 | Deletion cannot be blocked when it must be (active investigation, legal hold) |
| R13 | **MailOps does not delete the user's actual Gmail messages** | 🟢 by design | Correct — MailOps stores a copy. Must be stated in the UI so users do not expect their mailbox to change. Previously-executed cleanup actions are **not** reverted (Gmail Trash is user-recoverable) |
| R14 | **`purgeUserEmailData` and account deletion could be confused** | 🟡 | Two destructive flows with different intent. UI copy and the absence of `keepApplicationHistory` on the new endpoint must make the distinction unmistakable |

---

## 14. Summary of what P0-1 needs

**Schema:** 1 new table (`AccountDeletionRecord`, no `User` FK) + indexes. Cascade rules unchanged.
**Backend:** 1 orchestration service (4 phases), 1 `DELETE` endpoint, 1 preview extended into the existing privacy
endpoint, 2 new audit actions, a corrected job/Redis purge, worker-side existence guards.
**Frontend:** a danger zone in the existing `PrivacySection`, a confirmation dialog, manual-steps disclosure, and a
post-deletion redirect with cache clearing.
**Tests:** per-model zero-row erasure assertions (16 tables), a DMMF-driven drift guard, revocation **ordering**,
Redis/job cleanup, receipt integrity, session invalidation, and the security/validation set.
**Non-negotiable ordering:** revoke external grants → write the receipt → delete the user row → clean Redis.
