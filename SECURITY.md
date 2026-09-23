# MailOps — Security

MailOps holds the keys to a user's mailbox, their job-search history, and a phone
number it is permitted to call. That combination sets the bar.

This document describes the threat model, the controls in place, and — where a
control is partial — what remains.

---

## 1. Threat model

| # | Threat | Impact | Primary control |
|---|---|---|---|
| T1 | Attacker reads stored OAuth tokens | Full mailbox read access | AES-256-GCM envelope encryption; key held outside the database |
| T2 | Attacker obtains a session | Account takeover | httpOnly cookies, short-lived access tokens, rotating hashed refresh tokens |
| T3 | Cross-site request forgery | Silent state change, e.g. approving a deletion | Double-submit CSRF token + SameSite=Lax cookies |
| T4 | XSS reads tokens or exfiltrates data | Session theft | No tokens in JS-reachable storage; strict CSP in production; React's default escaping; no `dangerouslySetInnerHTML` |
| T5 | Malicious email content manipulates the AI | Wrong classification, wrong actions, possible prompt injection | Email is passed as untrusted data with an explicit instruction to ignore embedded instructions; every output is schema-validated and business-rule guarded |
| T6 | AI over-reach (hallucinated company/deadline/status) | Fabricated application history | Grounded extraction, evidence requirements, `null` over guesses, confidence gates, human review for low confidence |
| T7 | Destructive action on important mail | Permanent data loss | Cleanup proposals only; explicit per-batch approval; server-side protection guard re-checked per item; Trash instead of permanent delete |
| T8 | Lost/stolen email content from a DB dump | Privacy breach | Body storage is minimised and optional; retention sweep; plain-text-only extraction, never raw HTML |
| T9 | Credential leakage via logs | Token compromise | Centralised pino redaction + a defensive sanitiser for nested objects and audit metadata |
| T10 | Noisy/blind automation (unwanted calls, notification storms) | User harm and churn | Opt-in voice, quiet hours, daily cap, escalation ladder bounded by enabled channels, dedupe keys |
| T11 | Resource exhaustion / brute force | Denial of service | Global + auth rate limits, bounded body size, bounded pagination, bounded per-scan message count |
| T12 | Enumeration of other users' data | IDOR | Every query is scoped by `userId` from the session; no endpoint accepts a user identifier |

Out of scope for this repository: host hardening, network segmentation, secret
manager choice, physical security, and the compliance posture of the messaging
providers.

---

## 2. Gmail permissions

Requested scopes — and only these (`backend/src/services/gmail/scopes.ts`):

| Scope | Why it is needed |
|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | Read messages to classify them and extract application facts |
| `https://www.googleapis.com/auth/gmail.modify` | Archive / move to Trash when the user approves a cleanup batch |
| `https://www.googleapis.com/auth/userinfo.email` | Show which account is connected, so the user disconnects the right one |
| `openid` | Required by Google's OAuth consent screen |

**Not requested, and impossible to configure otherwise:**

- `https://mail.google.com/` — full mailbox access including *permanent* delete
- `https://www.googleapis.com/auth/gmail.send` — MailOps never sends mail as the user
- `gmail.settings.*` — no filter/settings mutation
- Any Drive, Contacts or Calendar scope

`auditGrantedScopes()` compares the granted set against the required set at connect
time. A partial grant sets the account status to `ERROR`, surfaces the missing
scopes in Settings, and blocks scanning until the user reconnects. The permission
list and the reasoning behind each entry are rendered verbatim in the connect
flow, so consent is informed rather than implied.

**Cleanup uses Trash, not permanent delete.** Even a fully approved deletion is
recoverable in Gmail for 30 days.

---

## 3. OAuth flow

```
POST /api/gmail/oauth/start
   │  generates a random nonce, stores { userId, createdAt } in memory (TTL 10 min)
   ▼
Google consent screen (access_type=offline, prompt=consent)
   │
   ▼
GET /api/gmail/oauth/callback?code=…&state=<nonce>
   │  consumeState(): single-use (deleted before validation), TTL-checked,
   │  bound to the userId that started the flow
   ▼
getToken() → verify a refresh_token was issued
   │
   ▼
encrypt(refresh_token, access_token) → GmailAccount row
   │  + record granted scopes, audit the connection
   ▼
enqueue the first scan
```

If Google omits the refresh token (user previously granted access), MailOps fails
with an actionable message rather than storing a session that cannot survive the
access-token lifetime.

Access tokens are refreshed automatically when within 60 s of expiry, and the
refreshed token is re-encrypted before being persisted.

Disconnect revokes the grant **at Google** (so it disappears from the user's
account permissions page) and then deletes the stored ciphertext. A revocation
failure is logged and non-fatal — the local credentials are still removed.

### Multi-instance note

The pending-state store is in-process, which is correct for a single API instance.
For a horizontally scaled deployment, move it to Redis with the same 10-minute
TTL. See DEPLOYMENT.md.

---

## 4. Credential storage

**Algorithm:** AES-256-GCM. **Format:** `v1.<iv-b64>.<authTag-b64>.<ciphertext-b64>`
with a fresh random 12-byte IV per record.

- GCM authenticates as well as encrypts: tampering produces a hard failure, never
  silent corruption.
- The key lives in `ENCRYPTION_KEY`, never in the database, and is never logged.
- In production a missing or wrong-length key is a **fatal startup error**.
- In development a deterministic fallback derived from `JWT_SECRET` keeps local
  runs working; `describeKey()` (operational diagnostics only) reports whether the
  real key is in use.
- **Columns:** `GmailAccount.accessTokenEnc`, `.refreshTokenEnc`,
  `Integration.secretsEnc`.
- Access tokens are never serialised to the client. `GET /api/gmail/accounts`
  returns a `hasCredentials` boolean and nothing more.
- Integration secrets follow the same path and are masked in the UI after saving.

Rotating the key requires re-encryption. See DATABASE.md §8.

---

## 5. Authentication and sessions

| Control | Implementation |
|---|---|
| Password hashing | bcrypt, cost 12 (4 under test) |
| Password policy | Minimum 10 characters, at least one letter and one digit |
| Account enumeration | Identical generic error for unknown email and wrong password; a dummy bcrypt comparison runs when the user is missing so response timing does not leak existence |
| Access token | JWT (HS256), 15-minute default TTL, claims `{ sub, email, typ: "access" }`, `typ` verified on every request |
| Refresh token | 48 random bytes, **stored only as an HMAC-SHA256 hash**, rotated on every use, revocable |
| Cookie flags | `httpOnly`, `SameSite=Lax`, `secure` (mandatory in production), `path=/`, explicit `maxAge` |
| Session invalidation | `POST /api/auth/sessions/revoke` revokes all refresh tokens; the user is signed out everywhere |
| Deleted users | `requireAuth` re-checks the user exists on every request, so a valid signature cannot outlive the account |

`SameSite=Lax` (rather than `Strict`) is required for the top-level redirect back
from Google to carry the session context; CSRF is instead covered by the
double-submit token below.

---

## 6. CSRF

State-changing methods that authenticate by cookie must present both the readable
`mailops_csrf` cookie and a matching `X-CSRF-Token` header, compared with
`crypto.timingSafeEqual`. A cross-site attacker can cause the cookie to be sent but
cannot read it, so it cannot forge the header.

Exempt: `GET`/`HEAD`/`OPTIONS`, and any request carrying `Authorization: Bearer`
(not cookie-authenticated, therefore not CSRF-reachable).

The interactive OAuth start endpoint additionally validates `returnTo` as a
same-app absolute path (`safeRedirectPath`), rejecting `//`, backslashes and
newlines to prevent open redirects.

---

## 7. Authorization

- Every data access is scoped by `userId` taken from the verified session — never
  from a request parameter. Services use `findFirst({ where: { id, userId } })`
  patterns, returning `404` rather than `403` so existence is not disclosed.
- Demo accounts (`isDemo: true`) are blocked from all non-`GET` requests by
  `blockDemoWrites`, so a shared demo cannot connect real integrations or trigger
  destructive actions.
- Admin-style diagnostics require authentication and expose no secrets — only
  presence flags, fingerprints and reachability.

---

## 8. Input validation

- **Zod at the boundary** (`middleware/validate.ts`): body, query and params are
  parsed and **replaced** with validated output, so a controller can only read
  schema-checked data. Strict objects reject unknown keys, which is what stops a
  `role: "ADMIN"` style payload reaching a service through a spread.
- **Bounded surfaces:** `express.json({ limit: "1mb" })`, form bodies 256 kb,
  `pageSize` ≤ 100, `emailIds` ≤ 500 per cleanup batch,
  `GMAIL_MAX_MESSAGES_PER_SCAN` ≤ 200 per scan.
- **Settings bounds:** every numeric setting is range-checked (scan interval
  15–1440 min, voice call cap 0–10, retention 7–3650 days, escalation delays
  1–1440 min, max 5 stages).
- **User-supplied URLs** are validated as same-app paths before any redirect.
- Prisma parameterises all SQL; there is no string-built SQL anywhere in the
  codebase.

---

## 9. AI-specific security

MailOps treats model output as untrusted input from a third party.

```
email (untrusted) → provider → JSON → Zod schema → business-rule guards
                → confidence gate → decision engine → (user approval) → action
```

| Control | Where |
|---|---|
| Email passed as delimited data with an explicit instruction to ignore embedded instructions | `services/ai/prompts.ts` (shared rules block) |
| Strict enum membership — an invented category is rejected, not coerced | `services/ai/schemas.ts` |
| Confidence clamped to `[0,1]`, malformed values default to `0` | `confidence` transform |
| Missing optional fields treated as `null`, so a partial response is usable rather than fatal | `nullableString` / `isoDate` `.optional()` |
| Implausible dates cleared; status claims without a verbatim `evidence` string discarded | `applyExtractionGuards()` |
| Malformed JSON → one repair retry → deterministic engine, with `fallbackUsed` recorded | `services/ai/runner.ts` |
| Low confidence never drives a state change; it becomes a `REVIEW_REQUIRED` task | `analysis.service.ts`, `application-processing.service.ts` |
| **No chain-of-thought is stored or displayed** — only a ≤320-character user-facing rationale | `reasoning` field |
| Prompt versioning so a stored analysis remains attributable | `PROMPT_VERSIONS` |

Details: [AI_PIPELINE.md](AI_PIPELINE.md).

---

## 10. Destructive-action controls

Deletion is the only irreversible operation in MailOps, so it is defended in depth.

1. **The classifier refuses to mark protected mail as unwanted** (`NEVER_CLEANUP_CATEGORIES`).
2. **The decision engine refuses to propose it** (`cleanupCandidate` requires the
   category to be user-approved, not in the never-clean list and not a protected
   sender).
3. **The approval endpoint is the only execution path.** The cleanup *worker*
   explicitly refuses `execute-cleanup` jobs and logs them as requiring approval.
4. **The guard is re-evaluated server-side for every item**, immediately before the
   Gmail call — regardless of what the client asked for.
5. **Approval is per batch.** There is no standing permission and no "always allow"
   flag on the endpoint.
6. **Trash instead of permanent delete**, so a mistake is recoverable for 30 days.
7. **Revert endpoint** for executed archive/trash actions.
8. **Audit record per item**, with actor, action, sender, category and Gmail message
   id.

Protection rules: any `JOB` category; any email linked to an application; personal
correspondence (when enabled); financial/government senders (bank, tax, `.gov`,
payment processors); Gmail `STARRED` or `IMPORTANT` labels.

---

## 11. Logging and redaction

Two independent layers, because path-based redaction alone is defeatable by
nesting.

1. **pino `redact`** (`config/logger.ts`) covers ~40 paths, including
   `req.headers.authorization`, `req.headers.cookie`, `res.headers['set-cookie']`,
   `password`/`passwordHash`, every token variant, `apiKey`, `clientSecret`,
   `secretsEnc`, and body/html/raw content fields.
2. **`safeLogObject()`** recursively walks objects and redacts any key matching
   `/(token|secret|password|authorization|cookie|api[-_]?key|body|credential)/i`,
   truncating long strings. Used where an object might be logged wholesale.

Plus storage-layer helpers in `utils/redact.ts`: `redactSecrets()` strips bearer
tokens, `ya29.*` / `1//*` OAuth tokens, `xox*` Slack tokens and JWT-shaped strings
from free text; `maskEmail()` / `maskPhone()` for display; `sanitizeForAudit()`
depth-limits and truncates anything written to the audit log so it can never become
a shadow inbox.

**Never logged:** OAuth access or refresh tokens, full private email bodies,
passwords, API secrets, session cookies, encryption keys.

Integration errors are passed through `redactSecrets()` before they are logged,
because a provider error can echo request material.

---

## 12. HTTP hardening

| Control | Value |
|---|---|
| Security headers | Helmet: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS with preload in production |
| CSP (production) | `default-src 'self'`; `script-src 'self'`; `object-src 'none'`; `frame-ancestors 'none'`; `connect-src 'self' <web origin>` |
| CORS | Explicit origin allow-list; never a wildcard with credentials. Credentials enabled; `X-CSRF-Token` and `X-Request-Id` allowed; `X-Request-Id` and rate-limit headers exposed |
| `X-Powered-By` | Disabled |
| Trust proxy | Exactly one hop, so rate limits key on the real client IP |
| Timeouts | `keepAliveTimeout` 30 s, `headersTimeout` 35 s; dependency checks are time-bounded |
| Error leakage | Internal messages are replaced with a generic 500 in production; Prisma codes and stack traces are development-only |

---

## 13. Availability and graceful failure

- **Reads degrade, writes fail loudly.** Redis being down returns `503
  QUEUE_UNAVAILABLE` with `degraded: true` on queue-backed actions while the
  dashboard, application pages and analytics keep working.
- **Dependency checks are bounded.** `/health` returns within ~2.5 s even when both
  PostgreSQL and Redis are unreachable — it will not hang exactly when an operator
  needs it. The same batching applies to the voice-call guard, so an unreachable
  Redis cannot stall an escalation.
- **Redis unavailability cannot exceed a call cap.** Voice counts are derived from
  persisted `NotificationAttempt` rows when the Redis counter is missing.
- **Graceful shutdown** drains in-flight jobs before closing queues and datastores
  (30 s budget), so a cleanup batch or status transition is never cut in half.

---

## 14. Privacy

| Principle | Implementation |
|---|---|
| Minimise what is read | Bounded lookback window, bounded messages per scan, `-in:chat -in:sent -in:draft` excluded |
| Minimise what is stored | Salient plain text only (never raw HTML); `storeEmailBody=false` keeps headers and snippets only |
| Retention | `dataRetentionDays` trims bodies and purges unlinked emails; application history is never deleted by retention |
| Transparency | `GET /api/settings/privacy` returns a literal inventory: counts per table, retention state, and the endpoints that change them |
| Portability | `GET /api/settings/privacy/export` returns a complete JSON export |
| Erasure | `DELETE /api/settings/privacy/email-data` with an explicit `keepApplicationHistory` choice |
| Third parties | Email content goes only to the configured AI provider, for classification/extraction/summarisation; no prompt data is retained by MailOps beyond the derived analysis |
| Notifications | Carry application facts and a link, never email bodies ("do not send sensitive email contents unnecessarily") |

---

## 15. Known limitations

Stated plainly rather than implied:

1. **OAuth state is in-process.** Correct for one API instance; a multi-instance
   deployment must move it to Redis (see DEPLOYMENT.md).
2. **Access tokens cannot be revoked before expiry.** A signed JWT stays valid for
   up to `JWT_ACCESS_TTL_SECONDS` (default 900) after logout. Shortening the TTL or
   adding a denylist for sensitive deployments is the mitigation.
3. **The demo-account guard is coarse.** It blocks all writes; it is not a
   per-feature capability model.
4. **Keyword heuristics can be fooled.** The deterministic engine is transparent
   and testable, not adversarially robust. Prompt injection and lexical evasion are
   mitigated by validation and the review gate, not eliminated.
5. **No malware or attachment scanning.** Attachments are detected (so "has
   attachments" is known) but never opened or stored.
6. **Slack webhooks are bearer credentials.** Anyone with the URL can post to that
   channel; they are stored encrypted and never returned, but scope is limited to
   the channel the user chose.
7. **No SOC 2 / ISO 27001 posture.** The controls above are engineering controls;
   they are not an audit.
