# MailOps

**An AI job-application operations agent.** MailOps connects to Gmail, understands
incoming mail, turns recruitment emails into a persistent application timeline, keeps
unwanted mail out of the way with explicit approval, and escalates the things that
actually matter until you acknowledge them.

> MailOps does not manage email. It manages the job-search lifecycle.

The agent loop it implements:

```
OBSERVE  →  UNDERSTAND  →  REMEMBER  →  DECIDE  →  ACT  →  INFORM
   │            │             │           │         │        │
 Gmail      classify +     application  decision  notify   tell the user
 scan       extract        history +    engine    /clean   what happened
            + summarise    timeline               /escalate
```

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture at a glance](#architecture-at-a-glance)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment setup](#environment-setup)
- [Docker startup](#docker-startup)
- [Database migration](#database-migration)
- [Seed data](#seed-data)
- [Development](#development)
- [Testing](#testing)
- [Production build](#production-build)
- [Deployment](#deployment)
- [Configuration reference](#configuration-reference)
- [Product rules enforced by the code](#product-rules-enforced-by-the-code)
- [Troubleshooting](#troubleshooting)
- [Documentation index](#documentation-index)

---

## What it does

| Capability | How it works | Where it lives |
|---|---|---|
| **Gmail integration** | Google OAuth 2.0, minimal scopes, refresh tokens encrypted with AES-256-GCM | `backend/src/services/gmail/` |
| **Background scanning** | BullMQ worker, per-user interval (default 3.5 h), Gmail `historyId` cursor with full-rescan fallback | `backend/src/services/gmail/sync.service.ts`, `backend/src/workers/scheduler.ts` |
| **Email classification** | 8 primary categories + 14 job sub-categories, structured JSON, validated against a Zod schema | `backend/src/services/ai/classifier.ts` |
| **Information extraction** | 19 grounded fields; unverifiable values are `null`, never invented | `backend/src/services/ai/extractor.ts` |
| **Application intelligence** | One `Application` row per application cycle, append-only `ApplicationEvent` timeline | `backend/src/services/applications/` |
| **Rejection tracking** | Status set to `REJECTED`, event recorded, history survives deletion of the email | `application-processing.service.ts` |
| **Duplicate detection** | Blended company/role similarity + AI adjudication; advisory only, never blocks the user | `backend/src/services/ai/duplicate-detector.ts` |
| **Application matching** | Exact job-id / URL match wins; otherwise company+role similarity with a review band | `backend/src/services/ai/application-matcher.ts` |
| **Notifications** | Dashboard → Slack → WhatsApp → AI voice call, acknowledgement-driven | `backend/src/services/notifications/` |
| **Escalation engine** | Per-user ladder stored on the notification, delayed BullMQ jobs, ACK cancels the rest | `escalation.service.ts` |
| **Inbox cleanup** | Proposals only; execution requires explicit per-batch approval and passes a server-side protection guard | `backend/src/services/cleanup/cleanup.service.ts` |
| **Analytics** | Rates, funnel, timings, per-company responses, inbox composition | `backend/src/services/analytics/analytics.service.ts` |
| **Audit trail** | Append-only log of every automated action, with actor and confidence | `backend/src/services/audit/audit.service.ts` |
| **Privacy controls** | Data inventory, JSON export, retention sweep, "delete my email data" flow | `backend/src/services/settings/settings.service.ts` |

---

## Architecture at a glance

```
                            Gmail
                              │  (OAuth 2.0, read + modify only)
                              ▼
                     Gmail integration
                              │
                              ▼
   ┌──────────────────  Backend API (Express)  ──────────────────┐
   │                       /api/*                                │
   └───────────────┬─────────────────────────────┬──────────────┘
                   │                             │
             PostgreSQL                       Redis
         (Prisma, 14 models)               (BullMQ transport)
                   │                             │
                   │        ┌────────────────────┴───────────────┐
                   │        │            Workers                 │
                   │        │  email-scan → email-processing →   │
                   │        │  application-processing →          │
                   │        │  notification → escalation         │
                   │        │  cleanup · scheduler               │
                   │        └────────────────────┬───────────────┘
                   └────────────┬────────────────┘
                                │
                          AI services
                  (classifier · extractor · summarizer ·
                   duplicate detector · application matcher ·
                   voice scriptwriter)
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
           Slack           WhatsApp         Voice (opt-in)
              │                 │                 │
              └─────────────────┴─────────────────┘
                                │
                                ▼
                       Next.js app (App Router)
```

Details, diagrams and rationale: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Repository layout

```
mailops/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma            # 14 models, all indexes
│   │   ├── migrations/              # initial migration (generated, deployable)
│   │   └── seed.ts                  # deterministic demo dataset
│   ├── src/
│   │   ├── config/                  # env, logger (with redaction), prisma, redis, constants
│   │   ├── controllers/             # HTTP layer only — no business logic
│   │   ├── middleware/              # auth, validation, error handling, security, CSRF
│   │   ├── routes/                  # route → controller wiring
│   │   ├── services/
│   │   │   ├── ai/                  # classifier, extractor, summarizer, matcher, duplicate, voice
│   │   │   │   ├── heuristics/      # deterministic engine (default provider)
│   │   │   │   └── providers/       # openai-compatible + heuristic
│   │   │   ├── gmail/               # OAuth, client, normaliser, sync
│   │   │   ├── applications/        # application intelligence + timeline
│   │   │   ├── notifications/       # channels, dispatcher, escalation
│   │   │   ├── decisions/           # decision engine
│   │   │   ├── cleanup/             # proposals, protection, execution, retention
│   │   │   ├── analytics/
│   │   │   ├── audit/
│   │   │   ├── dashboard/
│   │   │   ├── emails/
│   │   │   ├── settings/
│   │   │   └── auth/
│   │   ├── queues/                  # BullMQ queue registry + typed producers
│   │   ├── workers/                 # one worker per queue + scheduler
│   │   ├── utils/                   # crypto, redaction, similarity, dates, text, errors
│   │   ├── app.ts                   # Express assembly
│   │   ├── index.ts                 # API entrypoint
│   │   └── workers/index.ts         # worker entrypoint
│   ├── tests/
│   │   ├── unit/                    # classification, extraction, matching, escalation, channels, crypto
│   │   └── integration/             # API contract + (gated) database pipeline tests
│   ├── .env.example
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── app/                         # App Router pages
│   ├── components/
│   │   ├── ui/                      # primitives, tables, feedback
│   │   ├── layout/                  # app shell (sidebar / drawer / bottom nav)
│   │   └── domain/                  # badges, tables, timeline, charts, cleanup, notifications
│   ├── lib/                         # api client, hooks, types, utils
│   ├── .env.example
│   ├── Dockerfile
│   └── package.json
├── scripts/
│   ├── check-imports.mjs            # static import-resolution check
│   └── check-exports.mjs            # static named-export check
├── docker-compose.yml
└── docs: ARCHITECTURE · DATABASE · API · SECURITY · AI_PIPELINE · DEPLOYMENT
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 or 22 LTS | `node --version` |
| npm | 10+ | ships with Node |
| Docker + Compose | any recent | for PostgreSQL and Redis |
| Google Cloud project | — | only needed to connect a real Gmail account |

> **No AI API key is required.** MailOps ships with a deterministic, rule-based
> analysis engine (`AI_PROVIDER=heuristic`, the default). It classifies, extracts,
> matches and summarises a realistic inbox without any external service. Set
> `AI_PROVIDER=openai-compatible` plus an API key to use an LLM instead; the
> heuristic engine then becomes the fallback if the provider fails.

---

## Installation

```bash
git clone <your-repo-url> mailops
cd mailops

# install both workspaces
npm run install:all
# or individually:
#   npm install --workspace backend
#   npm install --workspace frontend
```

---

## Environment setup

Two files. Neither is committed (`.gitignore` excludes `.env` and `.env.*` except
the `.example` files).

```bash
# backend
cp backend/.env.example backend/.env

# frontend
cp frontend/.env.example frontend/.env.local
```

Generate the two secrets the backend requires:

```bash
# JWT signing secret (48 random bytes)
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# AES-256-GCM encryption key for OAuth tokens and integration secrets (32 bytes, base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put them in `backend/.env`:

```ini
JWT_SECRET=<first value>
ENCRYPTION_KEY=<second value>
```

Everything else in `backend/.env.example` works with local defaults, except the
Gmail OAuth client id/secret (see below).

### Gmail OAuth (only needed to connect a real account)

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Gmail API**.
3. Configure the OAuth consent screen (External, testing is fine) and add yourself
   as a test user.
4. Create an **OAuth client ID** of type *Web application*.
5. Add the authorised redirect URI:

   ```
   http://localhost:4000/api/gmail/oauth/callback
   ```

6. Put the credentials in `backend/.env`:

   ```ini
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4000/api/gmail/oauth/callback
   ```

MailOps requests exactly four scopes and cannot be configured to request more —
see [SECURITY.md](SECURITY.md#gmail-permissions).

---

## Docker startup

Start the datastores (fast, and all you need for local development):

```bash
docker compose up -d postgres redis
docker compose ps          # both should be "healthy"
```

Start the full stack in containers instead (API + worker + web build too):

```bash
# the app services sit behind a profile so they don't collide with `npm run dev`
docker compose --profile app up -d --build
```

Stop everything:

```bash
docker compose down            # keep volumes
docker compose down -v         # also delete the database and queue data
```

---

## Database migration

```bash
cd backend

# generate the Prisma client (required after install and after schema changes)
npm run prisma:generate

# apply the committed migration (no interactive prompts; CI/production safe)
npm run prisma:deploy

# during schema development, create + apply a new migration
npm run prisma:migrate -- --name add_something

# inspect data in a browser UI
npm run prisma:studio
```

The repository ships `prisma/migrations/20260921000000_init/migration.sql`
(14 models, all enums and indexes), so `prisma migrate deploy` works on a fresh
database with no schema-diff step.

---

## Seed data

Populates a full, realistic job search — 18 applications, their timelines,
~60 analysed emails across every category, notifications with escalation history,
cleanup proposals, scan jobs and an audit trail. **Every row is flagged
`isDemo: true`** and the UI badges it as demo data.

```bash
cd backend

npm run seed
# or, to wipe the demo account's rows first:
SEED_RESET=true npm run seed          # bash
$env:SEED_RESET="true"; npm run seed  # PowerShell
```

Demo credentials:

```
demo@mailops.local / MailOpsDemo123
```

Override with `SEED_EMAIL` / `SEED_PASSWORD` if you prefer.

---

## Development

Three processes. Run each in its own terminal.

```bash
# terminal 1 — datastores
docker compose up -d postgres redis

# terminal 2 — API (http://localhost:4000)
cd backend && npm run dev

# terminal 3 — workers + scheduler (background scanning, AI, notifications, escalation)
cd backend && npm run dev:worker

# terminal 4 — web (http://localhost:3000)
cd frontend && npm run dev
```

From the repository root you can also use the workspace shortcuts:

```bash
npm run infra:up     # docker compose up -d postgres redis
npm run dev:api
npm run dev:worker
npm run dev:web
```

Useful endpoints while developing:

```bash
curl http://localhost:4000/health          # readiness, incl. per-dependency status
curl http://localhost:4000/health/live     # liveness (never touches a dependency)
```

### Static checks

Two dependency-free scripts catch the most common monorepo breakages without
installing anything:

```bash
node scripts/check-imports.mjs   # every relative import resolves to a real file
node scripts/check-exports.mjs   # every named import is actually exported
```

---

## Testing

```bash
cd backend

npm test                 # full suite (unit + API contract; DB tests skip)
npm run test:watch       # watch mode
npm run test:coverage    # coverage report
npm run typecheck        # tsc --noEmit
```

What runs by default:

- **Unit tests** — classification, extraction + grounding guards, similarity and
  matching, duplicate detection, decision engine, escalation/voice gates, cleanup
  protection rules, channel degradation, crypto/redaction, Gmail normalisation.
- **API contract tests** — envelope shape, auth boundary, CSRF, validation,
  security headers, CORS, rate-limit headers, taxonomy. These need **no database
  and no Redis**, so they run on every commit.

Database-backed pipeline tests are gated, because they must never run against a
personal Gmail account or an unmanaged database:

```bash
# with postgres up and migrated
cd backend
$env:RUN_INTEGRATION_TESTS="true"; npm test        # PowerShell
RUN_INTEGRATION_TESTS=true npm test                # bash
```

They cover: Gmail-shaped message → database, email → application creation,
follow-up email → existing application (no duplicate row), status never rewinds,
rejection survives email deletion, promotional mail → cleanup proposal (and job
mail never), protected email blocked at execution, retention sweep, and pipeline
idempotency.

---

## Production build

```bash
# from the repository root
npm run build

# or per workspace
cd backend  && npm run build      # tsc → dist/
cd frontend && npm run build      # next build → .next/
```

Start the built artefacts:

```bash
# API
cd backend && npm run start

# workers
cd backend && npm run start:worker

# web
cd frontend && npm run start
```

Container images (multi-stage, non-root, health-checked) are in
`backend/Dockerfile` and `frontend/Dockerfile`.

---

## Deployment

Short version:

```bash
export NODE_ENV=production
# required in production: JWT_SECRET (32+ chars), ENCRYPTION_KEY (32 bytes),
# COOKIE_SECURE=true, DATABASE_URL, REDIS_URL   — the process refuses to boot otherwise

cd backend
npm ci
npm run prisma:deploy
npm run build
npm run start          # separate process: npm run start:worker
```

Full topology, TLS, migration strategy, scaling the workers, token rotation and
rollback: [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Configuration reference

All backend configuration is environment-driven and validated at boot
(`backend/src/config/env.ts`). An invalid configuration fails fast rather than
starting half-configured. The most important variables:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local Postgres | Prisma connection |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ transport |
| `JWT_SECRET` | dev fallback | access-token signing; **required** in production |
| `ENCRYPTION_KEY` | dev fallback | AES-256-GCM key for stored credentials |
| `COOKIE_SECURE` | `false` | must be `true` in production |
| `GOOGLE_CLIENT_ID` / `_SECRET` | — | enables the Gmail connect flow |
| `AI_PROVIDER` | `heuristic` | `heuristic` or `openai-compatible` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | — | LLM provider configuration |
| `AI_MIN_CONFIDENCE` | `0.7` | below this, an analysis is flagged for review |
| `AI_REVIEW_THRESHOLD` | `0.55` | below this, it always requires human confirmation |
| `GMAIL_SYNC_LOOKBACK_DAYS` | `120` | how far back the first scan reads |
| `GMAIL_MAX_MESSAGES_PER_SCAN` | `200` | per-scan ceiling |
| `SLACK_WEBHOOK_URL` | — | server-level Slack fallback |
| `WHATSAPP_ACCESS_TOKEN` / `_PHONE_NUMBER_ID` | — | WhatsApp Cloud API |
| `VOICE_ACCOUNT_SID` / `_AUTH_TOKEN` / `_FROM_NUMBER` | — | voice provider |
| `SCHEDULER_ENABLED` | `true` | run the scan/escalation scheduler in the worker |
| `WORKER_CONCURRENCY` | `4` | jobs processed per worker process |
| `LOG_LEVEL` | `info` | pino level |

Per-user behaviour (scan interval, channels, escalation delays, quiet hours, call
caps, cleanup categories, retention) is **not** environment configuration — it is
user settings in the database, editable in the app. That distinction is
deliberate: an agent that can phone someone must not be configurable only by
whoever controls the server.

---

## Product rules enforced by the code

These are not conventions — each is enforced by a guard with a test behind it.

| Rule | Enforcement |
|---|---|
| Never delete important email automatically | `checkProtection()` re-runs server-side for every item of every approved batch; job/personal/financial/government mail is excluded from cleanup entirely |
| Never invent job or application information | Extraction fields default to `null`; `applyExtractionGuards()` clears implausible dates and unproven statuses |
| Never fabricate deadlines | Deadlines require a verifiable sentence (`findDatedSentence`) and are dropped if implausible |
| Never claim a status without evidence | A `REJECTED` assertion with no `evidence` string is discarded |
| Always let the user override AI decisions | `PATCH /api/emails/:id/analysis`, `POST /api/applications/:id/status`; both write to the timeline and audit log |
| Voice calls must be opt-in | `voiceEnabled` defaults to `false`; `checkVoiceGate()` blocks calls unless enabled, in-ladder, in-window, under the daily cap and an enabled event type |
| Provide quiet hours and call caps | Enforced in `checkVoiceGate()`, in the user's own timezone, with a Redis counter and a database fallback |
| Preserve history when emails are deleted | Emails are an optional relation; the retention and purge paths detach events before deleting content |
| Every automated action has an audit trail | `recordAudit()` on every mutation, actor-labelled (`AI`/`SYSTEM`/`USER`) |
| AI confidence is tracked and low confidence goes to review | `needsReview` gates application creation, status changes and destructive proposals |
| No chain-of-thought exposure | Only a one-sentence `reasoning` field is stored or displayed |
| Minimise stored email content | Plain-text, salient-text extraction only; `storeEmailBody=false` keeps snippets and headers only |
| Never expose OAuth credentials | Tokens are encrypted at rest, never serialised to the client, and redacted from logs |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `502`/`503` on scan or scan does nothing | Redis is down | `docker compose up -d redis`; the dashboard keeps working, queue-backed actions return a clear 503 |
| `Gmail access has expired` banner | Refresh token revoked or expired | Settings → Gmail → Reconnect |
| `Missing required scopes` | User declined a permission | Reconnect and accept all requested scopes |
| Emails are queued but never analysed | Workers are not running | `cd backend && npm run dev:worker` |
| `/health` reports `degraded` | Redis unreachable | Expected behaviour: reads work, background work does not |
| Slack/WhatsApp notifications never arrive | Channel not configured, or disabled in Settings | Settings → Notifications; watch the per-attempt status on the Notifications page |
| Voice never calls | By design unless opted in | Settings → Voice: enable calls, pick event types, check quiet hours and the daily cap |
| Login redirects in a loop | API unreachable from the browser, or `NEXT_PUBLIC_API_URL` wrong | Check `frontend/.env.local` and that the API is on `:4000` |
| `Environment variable not found: DATABASE_URL` | No `backend/.env` | `cp backend/.env.example backend/.env` |

---

## Documentation index

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layering, request lifecycle, workers and queues, decision engine, escalation, failure isolation |
| [DATABASE.md](DATABASE.md) | Every model and field, relationships, indexes, enums, idempotency and retention semantics |
| [API.md](API.md) | Every endpoint, request/response shapes, error codes, auth, rate limits |
| [SECURITY.md](SECURITY.md) | Threat model, OAuth and scopes, token storage, CSRF, redaction, audit, data minimisation |
| [AI_PIPELINE.md](AI_PIPELINE.md) | Task separation, prompts, schemas, validation guards, confidence gates, provider fallback |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Topology, environment, migrations, scaling, monitoring, runbooks, rollback |

---

## Verification status

Checked in this repository:

```text
✓ prisma validate                     schema is valid
✓ backend tsc --noEmit                clean (src + prisma/seed.ts + tests)
✓ frontend tsc --noEmit               clean
✓ backend build (tsc)                 succeeds
✓ frontend build (next build)         succeeds — 13 routes
✓ npm test (backend)                  167 passed, 10 skipped (gated DB tests)
✓ scripts/check-imports.mjs           557 relative imports resolve
✓ scripts/check-exports.mjs           1210 named imports are exported
```

The gated integration tests require `RUN_INTEGRATION_TESTS=true` and a running
PostgreSQL; see [Testing](#testing).

---

## License

Provided as-is for the project it was built for. Add a license file before
distributing.
