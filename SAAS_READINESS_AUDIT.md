# MailOps — SaaS Readiness Audit

**Scope:** the codebase as it exists today, verified by direct inspection of source
files (no changes made, nothing installed, no schema/DB modification).
**Method:** read-only inspection of `backend/src`, `frontend`, `prisma/`, Docker and
config. Each finding below is anchored to an observed file/behaviour, not to a
hypothetical architecture.

Severity key: **P0** = required before real users · **P1** = required before beta ·
**P2** = useful after beta.

---

## A. Current architecture

```
Browser (Next.js 14 App Router, :3000)
   │  httpOnly cookies (mailops_at / mailops_rt) + readable mailops_csrf
   │  X-CSRF-Token on every non-GET
   ▼
Backend API (Express 4 + TS, :4000)
   securityHeaders → cors → json → cookies → globalRateLimit → csrf → routes
   route → controller → service → Prisma
   │
   ├── PostgreSQL 16 + Prisma 5.22  (14 models)
   └── Redis 7 + BullMQ  (6 queues)
             │
   Worker process (setInterval scheduler + 6 BullMQ workers)
   email-scan → email-processing → application-processing → notification → escalation
   cleanup (proposal + retention sweep)

AI: provider abstraction — `heuristic` (deterministic lexicons, default)
    or `openai-compatible` (AI_BASE_URL / AI_API_KEY / AI_MODEL)
    5 separated responsibilities: classify, extract, summarize, duplicate, match
    (+ voice script), each with its own zod schema + prompt version.

Channels: Dashboard · Slack (incoming webhook) · WhatsApp (Cloud API) ·
          Email (console provider by default; nodemailer optional) · Voice (provider API)
Channels are per-user `Integration` rows whose secrets are AES-256-GCM encrypted.
```

Processes are separate (`node dist/index.js` vs `node dist/workers/index.js`), the API
never scans, and `docker compose` keeps app services behind `profiles: ["app"]` so the
documented dev path starts only Postgres + Redis.

## B. What already works (verified)

- **Auth**: register/login/logout/refresh/me/revoke-all. Short-lived access JWT in an
  httpOnly `SameSite=Lax` cookie; 48-byte refresh tokens stored only as HMAC-SHA256
  hashes and **rotated on every use**; user-existence check on every authenticated
  request; dummy-hash comparison on unknown email so timing does not leak existence.
- **CSRF**: global double-submit middleware + `GET /api/auth/csrf` bootstrap. Verified
  live: login 200 with token, 403 with none, 403 on cookie/header mismatch, 403 on an
  authenticated POST without the header.
- **Multi-user isolation**: every request-path lookup is `userId`-scoped
  (`getEmailDetail`, `overrideEmailAnalysis`, `resolveReviewDecision`, cleanup
  revert/approve, notification ack/resolve/pause, Gmail account lookups). Cross-user
  reads return 404, not 403. **No IDOR found in the HTTP surface.**
- **Credential security**: AES-256-GCM envelope encryption with a versioned format,
  key outside the DB, redaction in the logger, integration secrets encrypted, Slack
  webhook verified by a live POST before it is saved.
- **Product logic**: idempotent Gmail ingestion (unique `userId+gmailMessageId`),
  history-based incremental sync with full-scan fallback, body minimisation honouring
  `storeEmailBody`, immutable application timeline, rejection records that survive
  email deletion, duplicate *flagging* that never blocks the user, user-approved
  cleanup with a protected-mail re-check at execution time, escalation ladder with
  per-user timers/quiet hours/max-calls, audit log, retention sweep, data export.
- **Production config guards**: `env.ts` refuses to boot with a weak/missing
  `JWT_SECRET`, `ENCRYPTION_KEY`, or `COOKIE_SECURE=false` in production.
- **Operational basics**: `/health`, `/health/live`, non-root multi-stage Docker images,
  separate API/worker images, 177 passing backend tests, 14 frontend routes building.

---

## C. P0 — required before real users

### P0-1 · There is no account deletion
Only email-data purging exists (`purgeUserEmailData`, `DELETE /api/settings/privacy/email-data`).
`deleteUser`/`deleteAccount` do not exist anywhere in the backend. A user cannot close
their account, and the erasure right under GDPR/DPDP cannot be honoured.
*Evidence:* grep for `deleteUser|deleteAccount|purgeUser` → only `purgeUserEmailData`.

### P0-2 · There is no password change and no password reset
Auth routes are `/csrf /register /login /refresh /logout /me /sessions/revoke`.
Grep for `forgot|resetPassword` → no matches. A user who forgets their password is
permanently locked out with no recovery path, and a signed-in user cannot rotate a
compromised password.

### P0-3 · The login page publishes working demo credentials, and the seed has no production guard
`frontend/app/login/page.tsx` renders `demo@mailops.local` / `MailOpsDemo123`
literally in the UI. `prisma/seed.ts` contains **no** `NODE_ENV` check, so running it
against production creates a known-credential account. Mitigating factor: `blockDemoWrites`
does make the demo user read-only on write routes — but the credentials are still public
and the account still authenticates.

### P0-4 · No email verification
Any address can be registered, and nothing proves the user controls it. Combined with
the email notification channel, this permits using MailOps to send mail to arbitrary
addresses. It also removes the only viable account-recovery channel (see P0-2).

### P0-5 · Rate limiting does not work beyond a single process, and there is no per-user limit
Both limiters are created with the default in-memory store
(`rateLimit({...})` at `middleware/security.ts:62` and `:78` — no `store:` key). Limits
reset on every restart and are not shared across instances, so they become decorative
as soon as there are two API replicas. Separately, the only per-identity limit is on
`/login` and `/register`; expensive endpoints (manual scan, reprocess, AI re-analysis,
export) have no per-user ceiling.

### P0-6 · The default deployment runs no real AI
`AI_PROVIDER` defaults to `heuristic` (`config/env.ts:43`), so classification/extraction
run on regex lexicons unless an operator overrides it. `env.ts` refuses weak *secrets*
in production but does **not** refuse a production boot with no AI provider configured,
and `aiProviderConfigured` is only surfaced as a UI hint.

### P0-7 · No AI cost accounting or budget caps
There is no token/cost counter per user, per period, or per provider call, and no cap.
One user with a large mailbox can generate unbounded third-party spend. `tokenUsage` is
persisted on `EmailAnalysis` for diagnostics only — it is never aggregated or limited.

### P0-8 · Email content goes to a third-party model with no redaction or consent control
The classifier/extractor prompts include subject, sender and body text. There is no
PII/secret scrubbing before the outbound call, no per-user opt-out for third-party
processing, and no in-product disclosure naming the sub-processor. The Privacy page
describes what MailOps stores, not what it transmits elsewhere.

### P0-9 · Gmail OAuth state lives in process memory
`pendingStates` is a module-level `Map` (`services/gmail/oauth.service.ts:34`). With more
than one API instance, or after a restart between consent-start and callback, the
callback fails with "OAuth state is invalid or has already been used". The code comment
already acknowledges Redis is required for multi-instance deployments.

### P0-10 · Deployment has no migration gate, no TLS, and no backups
The API image runs `node dist/index.js` with no `prisma migrate deploy` step; migrations
are a manual, documented command. Nothing in the repo terminates TLS or defines a reverse
proxy, and there is no backup/restore procedure for a database that holds derived mailbox
history. For a product whose value is a durable career timeline, this is unbounded loss.

### P0-11 · The frontend is completely untested and has never been rendered
`frontend/package.json` has no test script; there are **0** test files, no Playwright or
Cypress config. The 14 routes only build and typecheck. Every UI guarantee in the spec
(empty states, mobile layouts, redirect-after-login, responsive tables) is currently
unverified. During this session the dashboard was verified only at the HTTP boundary.

---

## D. P1 — required before beta

| # | Area | Issue |
|---|---|---|
| P1-1 | Sessions | No refresh-token **reuse detection**: replaying a rotated token yields 401 but does not revoke the family or alert. No session/device list, no email-change flow. |
| P1-2 | Abuse | No per-account lockout/backoff on repeated failures (only IP-based limiting) — distributed credential stuffing is unmitigated. |
| P1-3 | Email infra | Transactional email is the `console` provider by default; nodemailer is optional and unconfigured. Verification + reset (P0-2/4) depend on this existing. |
| P1-4 | Queues | The scheduler is a bare `setInterval` in the worker (`workers/scheduler.ts:51`) — two worker replicas double-tick every scan/retention/cleanup job. Needs a BullMQ job scheduler or a distributed lock. |
| P1-5 | Queues | No queue monitoring/dashboard/alerting, no per-user concurrency isolation, no dead-letter review. A single heavy mailbox can occupy the shared worker pool; failures are only visible in logs. |
| P1-6 | Gmail | Ingestion uses a fixed `newer_than` lookback window, so applications older than the window are never discovered; no backfill progress UI; no Gmail push (`users.watch`) so detection is poll-only. |
| P1-7 | Gmail | On disconnect, pending/in-flight scan jobs and queued messages are not cancelled or purged, and "delete MailOps data" is a separate flow rather than part of the disconnect confirmation. |
| P1-8 | AI | No accuracy evaluation harness (golden set) for classify/extract/match, and no regression gate on prompt changes — the 5 prompts are versioned but unmeasured. |
| P1-9 | AI | Prompt-injection exposure: email bodies are untrusted input rendered into prompts. Needs explicit untrusted-content framing and output constraints (partly present) plus tests. |
| P1-10 | AI | No multilingual handling or per-user language/locale setting; classification quality for non-English inboxes is unknown. |
| P1-11 | Cost/limits | No quota/billing concept at all (plans, seats, usage limits) — required before charging anyone. |
| P1-12 | Analytics | Metrics aggregate in JS over full result sets loaded per request; no SQL aggregation/materialised views, no date-range or per-company filters, so this degrades as data grows. |
| P1-13 | Notifications | Dashboard notifications are poll-based (no WebSocket/SSE), so "real-time" is a refresh interval; Slack is webhook-only (per-user manual setup, no OAuth app). |
| P1-14 | Notifications | WhatsApp business-initiated messages require approved templates and a per-user phone config; voice provider is unverified against a live API. Both are launch blockers for the escalation ladder as advertised. |
| P1-15 | Cleanup | No allowlist management for `IGNORE_SENDER` results, no unsubscribe/per-sender suppression UI, no post-trash recovery guidance (relies on Gmail's 30-day trash). |
| P1-16 | Audit | Audit logs have no retention/rotation policy and no tamper-evidence; no alerting on suspicious patterns (mass delete, repeated auth failure). |
| P1-17 | Testing | Integration tests run against the **development** database (they inherit `DATABASE_URL` from `backend/.env` via the test setup), so a test run mutates dev/seed data instead of using an isolated database. |
| P1-18 | Testing | No worker/queue tests, no channel-provider contract tests, no auth E2E, no load tests, no cross-tenant isolation regression suite. |
| P1-19 | Testing | A wall-clock-dependent test was found and fixed during this session; nothing prevents further time/date-dependent flakiness (no frozen clock in tests). |
| P1-20 | Frontend | No global React error boundary verified — a render-time crash risks a blank page with no recovery. No accessibility audit. No browser-verified mobile/bottom-nav behaviour. |
| P1-21 | Onboarding | New accounts land on an empty dashboard with generic empty states: no guided "connect Gmail → first scan → first application" flow, no progress feedback during initial sync. |
| P1-22 | Config | No production guard requiring `GOOGLE_CLIENT_ID/SECRET` when Gmail is enabled, no validation that `WEB_BASE_URL`/CORS origins are production URLs, no `.dockerignore` review. |
| P1-23 | Secrets | Secrets are plain environment variables; no secrets-manager/KMS integration and no documented key-rotation procedure (the versioned cipher format supports rotation, tooling does not exist). |
| P1-24 | Observability | No error tracking (e.g. Sentry), no metrics, no log aggregation, no uptime alerting, no queue dashboard. Failures today are only discoverable by reading worker logs. |
| P1-25 | VCS/CI | **The project has no `.git` directory at all** and no CI configuration. No history, no rollback, no review, no pipeline to run the 177 tests or block on migrations. |

## E. P2 — useful after beta

- **P2-1** MFA/TOTP and passkeys for sign-in.
- **P2-2** Access-token revocation (denylist/epoch) — currently a stolen access JWT stays
  valid until expiry (short TTL is the only mitigation).
- **P2-3** Roles/admin surface (support impersonation, ops tooling) and team/workspace
  accounts (multiple users per job search).
- **P2-4** Real-time dashboard updates over SSE/WebSocket.
- **P2-5** Digest/quiet-summary mode and per-company mute rules for notifications.
- **P2-6** Manual "merge applications" and "split application" tools; per-user matching
  thresholds instead of global constants.
- **P2-7** Attachment handling and full-text search across stored mail.
- **P2-8** Per-application timeline export (PDF/CSV) and analytics export.
- **P2-9** i18n/localisation, light theme toggle (`darkMode: class` is configured but no
  toggle exists), keyboard shortcuts.
- **P2-10** Tamper-evident (hash-chained) audit log; scheduled audit digest to the user.
- **P2-11** Auto-cleanup scheduling policy UI (currently off by default and manual),
  wildcard sender rules.
- **P2-12** Data-residency/region selection and a self-hosted/on-prem packaging path.
- **P2-13** Performance: `requireAuth` performs a user lookup per request; consider a
  short-TTL cache once traffic justifies it.

---

## F. Recommended implementation order

Ordered by risk-of-harm and by dependency (later items need earlier ones):

1. **P0-3** Remove published demo credentials; gate the seed on `NODE_ENV`.
   *Smallest change, highest immediate exposure.*
2. **P0-2 + P1-3** Password change, then password reset — requires the transactional
   email provider, which also unblocks verification.
3. **P0-1** Account deletion (with grace period, Gmail revocation, cascade, audit).
4. **P0-4** Email verification, reusing the transactional email infrastructure.
5. **P0-5** Move rate-limit state to Redis and add per-user limits on expensive
   endpoints (`/gmail/scan`, `/emails/:id/reprocess`, `/privacy/export`).
6. **P0-9** Move OAuth state to Redis (small, self-contained, removes a hard
   multi-instance failure).
7. **P0-6 + P0-7 + P0-8** Configure a real AI provider, add a production boot guard,
   add per-user token/cost accounting and caps, and add outbound redaction + disclosure.
   *This cluster is the difference between "a demo of an AI product" and an AI product.*
8. **P0-10** Production deployment baseline: TLS/reverse proxy, migration step in the
   release path, automated backups + a tested restore, then stage the app behind it.
9. **P1-25 (VCS/CI) + P1-17/18/19** Version control, CI running typecheck + the 177
   tests against an isolated test database with a frozen clock, plus a minimal
   cross-tenant isolation suite. Do this early — it is the safety net for everything
   above.
10. **P0-11 + P1-20** Frontend test pyramid (component tests + one E2E for
    login → connect → process → notification) and an error boundary.
11. **P1-4 + P1-5** Scheduler leader-election and queue observability/alerting.
12. **P1-1 + P1-2** Refresh reuse detection, session/device list, per-account lockout.
13. **P1-14** Verify Slack/WhatsApp/Voice against live providers; complete WhatsApp
    template approval.
14. **P1-6 + P1-7 + P1-15** Ingestion depth (backfill, push watch), disconnect hygiene,
    cleanup sender rules.
15. **P1-8/9/10** AI evaluation harness, injection tests, language coverage.
16. **P1-12 + P1-21 + P1-16 + P1-22/23/24** Analytics scale, onboarding, audit
    hardening, config/secrets/observability.
17. **P1-11 + P2-*** Billing/quota, then the P2 feature set.

## G. Files/modules involved for each P0 item

| P0 | Backend | Data | Frontend |
|---|---|---|---|
| P0-1 Account deletion | `services/auth/auth.service.ts`, `services/settings/settings.service.ts`, `controllers/settings.controller.ts`, `routes/settings.routes.ts`, `services/gmail/oauth.service.ts` (revoke before delete) | `User` + cascade relations (schema already `onDelete: Cascade` for owned rows) | `app/(app)/settings/page.tsx` (danger zone) |
| P0-2 Password reset/change | `services/auth/auth.service.ts`, `controllers/auth.controller.ts`, `routes/auth.routes.ts`, new token model use (link to `RefreshToken` pattern) | `User.passwordHash`; a reset-token record | `app/login/page.tsx`, `app/(app)/settings/page.tsx` |
| P0-3 Demo exposure | `prisma/seed.ts` (env guard) | demo `User.isDemo` | `app/login/page.tsx` (remove literal creds) |
| P0-4 Email verification | `services/auth/auth.service.ts`, `controllers/auth.controller.ts`, `routes/auth.routes.ts`, `services/notifications/channels/email.channel.ts` | `User` verification state, verification token | `app/login/page.tsx`, verification screen |
| P0-5 Rate limiting | `middleware/security.ts`, `config/redis.ts` (shared store), `routes/*.routes.ts` (per-route limits) | — (Redis state) | — |
| P0-6 Real AI provider | `config/env.ts`, `services/ai/provider.ts`, `providers/openai-compatible.provider.ts`, `services/ai/runner.ts` | `EmailAnalysis.provider/model` | `app/(app)/settings/page.tsx` (AI section) |
| P0-7 AI cost caps | `services/ai/runner.ts`, `services/ai/analysis.service.ts`, `services/analytics/analytics.service.ts` | `EmailAnalysis.tokenUsage` (exists) + quota record | `app/(app)/analytics/page.tsx`, settings |
| P0-8 Outbound redaction/consent | `services/ai/prompts.ts`, `services/ai/runner.ts`, `utils/redact.ts`, `services/settings/settings.service.ts` | `UserSettings` (processing consent, redaction level) | `app/(app)/settings/page.tsx` (Privacy) |
| P0-9 OAuth state to Redis | `services/gmail/oauth.service.ts`, `config/redis.ts` | — (Redis state) | — |
| P0-10 Deploy baseline | `backend/Dockerfile`, `docker-compose.yml`, `DEPLOYMENT.md`, new CI/CD + proxy + backup config | migration gate via `prisma migrate deploy` | — |
| P0-11 Frontend tests | — | — | new frontend test setup, `components/**`, `app/**` |

## H. Security risks discovered (ranked)

1. **Publicly documented working credentials** (P0-3) — anyone can authenticate as the
   demo account; read-only limits the blast radius but the account is real.
2. **No account-deletion / erasure path** (P0-1) — a compliance failure, and data
   outlives the user's relationship with the product.
3. **Unverified email addresses** (P0-4) — enables sending notifications to addresses the
   user does not control, and blocks account recovery.
4. **Rate limiting ineffective in multi-instance/restart scenarios** (P0-5) — the primary
   brute-force control on the login endpoint degrades silently.
5. **Email content transmitted to a third-party model without redaction, consent, or
   disclosure** (P0-8) — the highest-sensitivity data in the product leaves the trust
   boundary by design today.
6. **Unbounded third-party spend per user** (P0-7) — an economic denial-of-service risk.
7. **Gmail connection breaks in multi-instance deployment** (P0-9) — availability, and a
   partial-consent state can be created without a usable callback.
8. **No backups for derived mailbox history** (P0-10) — irreversible data loss.
9. **Refresh-token reuse is not detected** (P1-1) — a stolen token can be replayed once,
   and the legitimate session is not revoked in response.
10. **No per-account lockout** (P1-2) — credential stuffing from distributed IPs is not
    mitigated by an IP limit.

**Explicitly checked and found sound:** no IDOR in the HTTP surface (cross-user reads
404); CSRF is enforced on all state-changing routes including authenticated ones; OAuth
tokens and integration secrets are envelope-encrypted and never logged; the Gmail scope
set is minimal (`gmail.readonly` + `gmail.modify`, no `gmail.send`); production boot
refuses weak secrets; destructive cleanup re-validates protection at execution time, not
just at proposal time.
