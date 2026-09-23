# MailOps — Deployment

---

## 1. Target topology

```
                         Gmail
                           │  OAuth 2.0 (gmail.readonly, gmail.modify)
                           ▼
                    Gmail integration
                           │
                    ┌──────┴───────┐
                    ▼              ▼
              Backend API     Worker process(es)
              (N instances)   (M instances)
                    │              │
              ┌─────┴──────┬───────┘
              ▼            ▼
         PostgreSQL      Redis
        (managed)      (managed)
              │            │
              │       BullMQ queues
              │            │
              └─────┬──────┘
                    ▼
              AI services
        (heuristic engine, or an
         OpenAI-compatible provider)
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Slack     WhatsApp     Voice
        │           │           │
        └───────────┴───────────┘
                    ▼
               User
                    │
                    ▼
              Next.js app
```

Two stateless services (API, worker) plus PostgreSQL and Redis. Scale the API for
request throughput and the worker for processing throughput; they are independent.

---

## 2. Requirements

| Component | Minimum | Notes |
|---|---|---|
| Node.js | 20 LTS | 22 also verified |
| PostgreSQL | 14+ (16 recommended) | managed instance advised |
| Redis | 6+ (7 recommended) | must allow a connection with `maxRetriesPerRequest: null` |
| TLS | required | HTTPS terminates at the LB/proxy |
| Outbound HTTPS | required | Gmail API, the AI provider, Slack, WhatsApp, voice provider |

---

## 3. Environment

Production **validates and refuses to start** on insecure configuration
(`config/env.ts`):

```
JWT_SECRET      must be present and ≥ 32 characters
ENCRYPTION_KEY  must be present (32 bytes, base64)
COOKIE_SECURE   must be true
```

Boot fails with an explicit list of what is missing rather than starting quietly
insecure.

```ini
NODE_ENV=production
PORT=4000
API_BASE_URL=https://api.mailops.example.com
WEB_BASE_URL=https://app.mailops.example.com

DATABASE_URL=postgresql://user:pass@db-host:5432/mailops?schema=public&sslmode=require
REDIS_URL=rediss://:password@redis-host:6379

# openssl rand -base64 48  → JWT
JWT_SECRET=<48+ random chars>
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_DAYS=30
COOKIE_SECURE=true
COOKIE_DOMAIN=.mailops.example.com     # only if web and api share a parent domain

# openssl rand -base64 32  → 32 bytes for AES-256-GCM
ENCRYPTION_KEY=<32-byte base64>

GOOGLE_CLIENT_ID=<from Google Cloud>
GOOGLE_CLIENT_SECRET=<from Google Cloud>
GOOGLE_OAUTH_REDIRECT_URI=https://api.mailops.example.com/api/gmail/oauth/callback
GMAIL_SYNC_LOOKBACK_DAYS=120
GMAIL_MAX_MESSAGES_PER_SCAN=200

AI_PROVIDER=openai-compatible          # or `heuristic` for zero external AI cost
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=<provider key>
AI_MODEL=gpt-4o-mini
AI_REQUEST_TIMEOUT_MS=25000
AI_MIN_CONFIDENCE=0.7
AI_REVIEW_THRESHOLD=0.55

SLACK_WEBHOOK_URL=<optional server fallback>
WHATSAPP_PROVIDER=cloud-api
WHATSAPP_PHONE_NUMBER_ID=<id>
WHATSAPP_ACCESS_TOKEN=<token>
WHATSAPP_DEFAULT_TO=<E.164 default recipient>
VOICE_PROVIDER=twilio
VOICE_ACCOUNT_SID=<sid>
VOICE_AUTH_TOKEN=<token>
VOICE_FROM_NUMBER=<E.164 caller id>

EMAIL_CHANNEL_PROVIDER=console         # or `smtp` (requires the optional nodemailer package)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=<user>
SMTP_PASSWORD=<password>
SMTP_FROM=MailOps <no-reply@mailops.example.com>

RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
AUTH_RATE_LIMIT_MAX=10

WORKER_CONCURRENCY=4
SCHEDULER_ENABLED=true                 # true on exactly ONE worker replica
LOG_LEVEL=info
```

Secrets must come from a secret manager (AWS Secrets Manager, GCP Secret Manager,
Vault, Kubernetes Secrets with encryption at rest) — never from the image or the
repository.

The frontend needs one variable:

```ini
NEXT_PUBLIC_API_URL=https://api.mailops.example.com
```

### Google OAuth in production

In the Google Cloud Console, add the production redirect URI to the OAuth client
and complete the consent-screen verification for the two Gmail scopes. Until an
app is verified, refresh tokens issued to *External/Testing* apps expire after
7 days — plan for verification before onboarding real users.

---

## 4. First deployment

```bash
# 1. Provision PostgreSQL and Redis; note the connection strings.

# 2. Deploy the API image (or the source tree).
cd backend
npm ci
npm run prisma:generate
npm run prisma:deploy        # applies prisma/migrations/*
npm run build

# 3. Start the API
NODE_ENV=production node dist/index.js

# 4. Start the worker (a separate process/service)
SCHEDULER_ENABLED=true node dist/workers/index.js

# 5. Build and start the web app
cd ../frontend
npm ci
NEXT_PUBLIC_API_URL=https://api.mailops.example.com npm run build
npm run start

# 6. Verify
curl -s https://api.mailops.example.com/health | jq
#   → status "ok", dependencies.database "ok", dependencies.redis "ok"
```

### With Docker Compose (single host)

```bash
cp backend/.env.example backend/.env      # then fill in production values
docker compose --profile app up -d --build
docker compose ps
```

For production on a single host, put TLS in front (Caddy, Traefik, nginx) — the
compose file deliberately does not terminate TLS.

---

## 5. Image and process model

Both images are multi-stage, run as a non-root user, and ship a healthcheck
(`backend/Dockerfile`, `frontend/Dockerfile`).

| Service | Command | Replicas | Notes |
|---|---|---|---|
| `api` | `node dist/index.js` | 1..N | Stateless |
| `worker` | `node dist/workers/index.js` | 1..M | `SCHEDULER_ENABLED=true` on exactly one |
| `web` | `npm run start` | 1..N | Stateless |
| `postgres` | managed | — | |
| `redis` | managed | — | persist with AOF or a managed service with a durable policy |

### Scaling the workers

Workers share queues, so replicas are interchangeable and BullMQ distributes jobs.

- Set `SCHEDULER_ENABLED=false` on every worker **except one**. Multiple schedulers
  would multiply scan ticks (idempotent, but wasteful).
- `email-scan` concurrency is intentionally capped at 2 inside the worker (Gmail
  quota); scale it by adding replicas rather than raising concurrency.
- `cleanup` concurrency is 1 to avoid lock contention on retention sweeps.
- `WORKER_CONCURRENCY` governs `email-processing` and `application-processing` —
  the throughput knobs that matter most, and the ones that spend AI tokens.

To split queues across dedicated pools, run the same entrypoint with a subset
enabled and give each pool its own `WORKER_CONCURRENCY`.

---

## 6. Migrations

`prisma/migrations/20260921000000_init/migration.sql` is committed, so no
schema-diff step is required at deploy time.

```bash
npm run prisma:deploy      # forward-only; safe in CI and on every boot
```

Rules:

- **Never** run `prisma migrate dev` in production (it can reset data).
- Migrations run as a pre-deploy job, not from the application start command, so N
  API replicas do not race.
- Take a snapshot before applying. The additive migrations in this schema are
  backwards-compatible, so a rolling deploy is safe; a destructive change needs a
  maintenance window.

### Rollback

Application rollback is an image rollback. Database rollback is a restore — Prisma
does not generate down-migrations. Because email and application rows are the only
irreplaceable data, schedule `pg_dump` before any migration:

```bash
pg_dump "$DATABASE_URL" -Fc -f mailops-$(date +%F).dump
pg_restore -d "$DATABASE_URL" --clean --if-exists mailops-2026-09-21.dump
```

---

## 7. Encryption key management

`ENCRYPTION_KEY` protects every stored OAuth token and integration secret.

- Generate once per environment: `openssl rand -base64 32`.
- Store it in a secret manager; never in the image, the repo, or CI logs.
- **Back it up separately from the database.** Losing it means every connected
  account must reconnect — a recoverable but disruptive incident.
- Rotating: see DATABASE.md §8 (decrypt with the old key, re-encrypt with the new).

---

## 8. Provider setup

### Slack

Create an app with an *Incoming Webhook*, pick the channel, and paste the URL into
Settings → Notifications → Slack integration. `Save & verify` performs a live test
post, so a bad webhook fails at configuration time rather than at 3am.

### WhatsApp

Use a compliant Business/Cloud API provider. Register a message template named
`MAILOPS_ALERT` (business-initiated messages outside a 24-hour customer window
require an approved template) with body parameters for company, role, status,
deadline and link. Configure `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`
and the user's number.

### Voice

Twilio (or any provider with an equivalent Calls API). Provide
`VOICE_ACCOUNT_SID`, `VOICE_AUTH_TOKEN` and a validated caller ID in
`VOICE_FROM_NUMBER`. Voice stays disabled until each user opts in, and the caller
script always discloses that it is automated.

### AI provider

Any OpenAI-compatible `/chat/completions` endpoint. `AI_PROVIDER=heuristic`
requires no key at all — a legitimate production choice: lower accuracy, zero cost,
zero third-party data exposure, fully deterministic.

---

## 9. Monitoring

### Health

- `GET /health/live` — liveness. Never touches a dependency; safe as a container
  liveness probe.
- `GET /health` — readiness. Bounded dependency checks (~2.5 s worst case), so it
  responds even when both datastores are down. `degraded` means background work is
  impaired but reads still work.

### Metrics worth alerting on

| Signal | Source | Alert when |
|---|---|---|
| `/health` not 200 | LB | 2 consecutive checks |
| `/health` status `degraded` | LB | 10 minutes |
| `ScanJob.status = FAILED` rate | database | > 3 in 15 minutes |
| `GmailAccount.status = EXPIRED` count | database | increases by > 5% — tokens are being revoked |
| Email queue depth (`email-processing`) | `/api/dashboard/system` | > 500 for 15 minutes |
| Escalation queue delayed count | `/api/dashboard/system` | drops to 0 while unacknowledged notifications exist |
| `NotificationAttempt.status = FAILED` rate | database | > 20% over 30 minutes — a channel is broken |
| `Notification.stuck in PENDING` | database | `createdAt` older than 10 min |
| AI fallback rate (`analysis.provider = heuristic` while `AI_PROVIDER=openai-compatible`) | database | > 10% — the LLM is failing |
| `Email.processingState = FAILED` count | database | increasing |
| p99 latency on `/api/dashboard` | LB | > 2 s |

### Logs

Structured JSON via pino, with mandatory redaction of tokens, cookies, passwords,
API keys and email bodies. Correlate with the `requestId` returned in every error
response and `x-request-id` header.

Ship to a log platform; **do not** enable debug logging in production (it is
redacted, but verbose).

### Audit trail

`GET /api/settings/audit` is the user-facing record. For operators, query
`AuditLog` directly — it is append-only and safe to retain long-term.

---

## 10. Background jobs and the scheduler

The scheduler tick runs every 5 minutes inside the worker process and does three
things:

1. Enqueues scans for accounts whose per-user interval has elapsed.
2. Sweeps overdue escalations whose delayed job was lost.
3. Once a day (guarded by a Redis key), runs retention and cleanup proposals.

If `SCHEDULER_ENABLED=false` everywhere, scans never start automatically — MailOps
still works, but only via manual *Scan now*. Keep exactly one scheduler running.

Redis durability matters: with AOF off or a non-durable managed instance, delayed
escalation jobs can be lost on restart. The sweeper re-queues them from the
database, which is why escalation state lives in `Notification.nextEscalationAt`
and not only in Redis.

---

## 11. Backups

| Data | Method | Retention |
|---|---|---|
| PostgreSQL | `pg_dump -Fc` daily + WAL archiving for PITR | 30 days minimum |
| `ENCRYPTION_KEY` | secret manager + offline escrow | indefinite |
| `JWT_SECRET` | secret manager | indefinite |
| Redis | not backed up deliberately | — |

Redis holds only transport state. BullMQ delayed escalation jobs are mirrored by
`Notification.nextEscalationAt`, so a Redis loss costs at most one 5-minute sweeper
cycle rather than a missed escalation.

Restore test: restore the dump into a staging database, point a staging worker at
it with `SCHEDULER_ENABLED=false`, and confirm the dashboard renders.

---

## 12. Runbooks

### All scans failing

1. `curl /health` — is Redis `ok`? If not, fix Redis; the API still works.
2. Is a worker process running? Check for recent `email-scan` jobs.
3. `SELECT status, error, "startedAt" FROM "ScanJob" ORDER BY "createdAt" DESC LIMIT 10;`
4. `GMAIL_CONNECTION_EXPIRED` → users must reconnect (Settings → Gmail).
5. `GMAIL_API_UNAVAILABLE` with 403 → Google quota; reduce
   `GMAIL_MAX_MESSAGES_PER_SCAN` or raise the scan interval for affected accounts.

### Escalations not firing

1. `SELECT id, "escalationStage", "nextEscalationAt", status FROM "Notification"
   WHERE "requiresAck" AND "acknowledgedAt" IS NULL AND "nextEscalationAt" < now();`
2. Row with `nextEscalationAt = null` → `POST /api/notifications/reconcile` for
   that user.
3. Row with a past `nextEscalationAt` → `POST /api/notifications/sweep`.
4. Nothing at all → check the account's channel settings and the stored
   `metadata.plan`; a user with only the dashboard enabled has no ladder by design.

### A channel is broken

1. `SELECT channel, status, count(*) FROM "NotificationAttempt"
   WHERE "createdAt" > now() - interval '1 hour' GROUP BY 1,2;`
2. Failed Slack → re-save the webhook in Settings with `Save & verify`.
3. Failed WhatsApp → check token expiry and the approved template name.
4. Failures are isolated: the dashboard and later stages are unaffected.

### Users report wrong classifications

This is working as designed rather than failing: low-confidence results go to the
review queue and never change history. Triage with:

```sql
SELECT category, "subCategory", priority, count(*)
FROM "EmailAnalysis"
WHERE "needsReview" = true AND "createdAt" > now() - interval '7 days'
GROUP BY 1,2,3 ORDER BY 4 DESC;
```

Then either adjust `AI_MIN_CONFIDENCE` / `AI_REVIEW_THRESHOLD`, or bump the prompt
version — see AI_PIPELINE.md §13.

### Emergency: stop all AI and external traffic

```bash
# stop scanning
UPDATE "UserSettings" SET "scanningEnabled" = false;

# stop escalation (dashboard notifications continue)
UPDATE "UserSettings" SET "escalationEnabled" = false;

# stop voice calls immediately
UPDATE "UserSettings" SET "voiceEnabled" = false, "notifyVoice" = false;
```

---

## 13. Security checklist before going live

- [ ] `JWT_SECRET` and `ENCRYPTION_KEY` generated randomly and stored in a secret manager
- [ ] `ENCRYPTION_KEY` backed up separately from the database
- [ ] `COOKIE_SECURE=true`, HTTPS enforced end to end
- [ ] `NODE_ENV=production` (enables CSP, HSTS, generic error messages)
- [ ] `WEB_BASE_URL` set correctly (drives the CORS allow-list and notification links)
- [ ] Only the four documented Gmail scopes requested; consent screen reviewed
- [ ] OAuth redirect URI registered for the production host
- [ ] `/health` wired to the platform's readiness probe
- [ ] Rate limits sized for real traffic
- [ ] Logs confirmed free of tokens and email bodies (open a scan, inspect output)
- [ ] Backups scheduled **and a restore rehearsed**
- [ ] Exactly one worker replica has `SCHEDULER_ENABLED=true`
- [ ] Voice left disabled by default; per-user opt-in verified
- [ ] Slack/WhatsApp webhooks belong to the deploying organisation, not a personal workspace

---

## 14. Post-deploy verification

```bash
API=https://api.mailops.example.com

# 1. Health
curl -s $API/health | jq '.status, .dependencies'

# 2. Taxonomy (proves routing and the app are wired)
curl -s $API/api/meta/taxonomy | jq '.data.escalationStages'

# 3. Unauthenticated access is refused
curl -s -o /dev/null -w '%{http_code}\n' $API/api/applications      # → 401

# 4. CSRF is enforced
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/auth/login \
  -H 'Content-Type: application/json' -d '{}'                       # → 403

# 5. Security headers
curl -sI $API/health | grep -iE 'x-frame|nosniff|referrer'

# 6. Web app reachable and redirecting to sign-in
curl -s -o /dev/null -w '%{http_code}\n' https://app.mailops.example.com/dashboard
```

Then, signed in: connect a test Gmail account, run *Scan now*, confirm emails
appear and are analysed, open one and confirm the AI analysis panel renders, and
check `Audit log` for the corresponding entries.
