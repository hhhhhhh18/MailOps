# MailOps — Database

PostgreSQL 16, accessed through Prisma 5. Schema: `backend/prisma/schema.prisma`.
Initial migration: `backend/prisma/migrations/20260921000000_init/migration.sql`.

---

## 1. Design principles encoded in the schema

1. **Structured history is independent of email content.** `Email → Application` is
   nullable with `onDelete: SetNull`. Deleting an email — from Gmail or from
   MailOps — cannot delete the application record or its timeline.
2. **Timelines are append-only.** `ApplicationEvent` has no update path in the
   service layer. The history is evidence.
3. **Every automated mutation is traceable.** `AuditLog` records actor
   (`AI`/`SYSTEM`/`USER`), action, entity and metadata.
4. **Ingestion is idempotent.** `@@unique([userId, gmailMessageId])` plus a
   processing state machine on `Email`.
5. **Credentials are never stored in the clear.** OAuth tokens and integration
   secrets are AES-256-GCM ciphertext in `*Enc` columns.
6. **Matching is indexable.** `companyKey` / `roleKey` are normalised
   (suffix-stripped) at write time so matching never needs `LIKE '%…%'` scans.

---

## 2. Entity relationships

```
User
 ├── UserSettings        1:1
 ├── RefreshToken        1:N
 ├── GmailAccount        1:N
 │    ├── Email          1:N
 │    └── ScanJob        1:N
 ├── Email               1:N
 │    ├── EmailAnalysis  1:1
 │    ├── CleanupAction  1:N
 │    └── ApplicationEvent (source email)  1:N
 ├── Application         1:N
 │    ├── ApplicationEvent  1:N   (append-only timeline)
 │    ├── Email             1:N   (optional link)
 │    ├── Notification      1:N
 │    └── CleanupAction     1:N
 ├── Notification        1:N
 │    └── NotificationAttempt 1:N
 ├── Integration         1:N   (unique per kind)
 ├── CleanupAction      1:N
 ├── ScanJob             1:N
 └── AuditLog            1:N
```

All user-owned relations cascade on user deletion, which is what makes the GDPR
"delete my account" path a single statement.

---

## 3. Models

### 3.1 `User`

| Field | Type | Notes |
|---|---|---|
| `id` | `String` PK | cuid |
| `email` | `String` `@unique` | lowercase, sign-in identity |
| `name` | `String?` | |
| `passwordHash` | `String?` | bcrypt cost 12 (4 under test) |
| `timezone` | `String` | IANA; drives quiet hours and the greeting |
| `isDemo` | `Boolean` | read-only seeded demo account |
| `createdAt` / `updatedAt` / `lastLoginAt` | `DateTime` | |

Index: `createdAt`.

### 3.2 `RefreshToken`

Hashed refresh tokens with rotation and revocation.

| Field | Notes |
|---|---|
| `tokenHash` `@unique` | HMAC-SHA256 of the raw token — a database leak is not replayable |
| `expiresAt`, `revokedAt` | rotation sets `revokedAt` on the presented token |
| `userAgent`, `ip` | session forensics |

Indexes: `userId`, `expiresAt`.

### 3.3 `UserSettings` (1:1 with User)

Everything the agent is allowed to do is here, editable in the app rather than by
whoever controls the server.

| Group | Fields | Default |
|---|---|---|
| Scanning | `scanIntervalMinutes`, `scanningEnabled` | `210` (3.5 h), `true` |
| Channels | `notifyDashboard`, `notifySlack`, `notifyWhatsapp`, `notifyEmail`, `notifyVoice` | dashboard on, everything else off |
| Threshold | `notifyMinSeverity` | `MEDIUM` |
| Escalation | `escalationEnabled`, `escalationDelaysMinutes[]`, `escalationMaxStage` | `true`, `[30,60,120]`, `2` |
| Voice | `voiceEnabled`, `voiceMaxCallsPerDay`, `voiceQuietHoursStart`, `voiceQuietHoursEnd`, `voiceCriticalEvents[]`, `voiceCallsToday`, `voiceCallsResetAt` | off, `2`, `22`–`07`, offer/interview/assessment/recruiter |
| Cleanup | `autoCleanupEnabled`, `cleanupCategories[]`, `protectJobEmails`, `protectPersonal`, `protectFinancial`, `protectGovernment` | manual, promo/spam/newsletter, all protections on |
| Privacy | `storeEmailBody`, `dataRetentionDays`, `redactSensitiveLogs` | `true`, `365`, `true` |

### 3.4 `GmailAccount`

| Field | Notes |
|---|---|
| `emailAddress` | with `userId` forms `@@unique([userId, emailAddress])` |
| `status` | `CONNECTED` / `EXPIRED` / `DISCONNECTED` / `ERROR` |
| `accessTokenEnc`, `refreshTokenEnc` | AES-256-GCM ciphertext (`v1.<iv>.<tag>.<ciphertext>`) |
| `tokenExpiresAt` | refreshed 60 s before expiry |
| `grantedScopes[]` | audited against the required minimum at connect time |
| `historyId` | incremental sync cursor, advanced only after a successful scan |
| `lastSyncAt`, `lastError`, `lastErrorAt` | surfaced in Settings |

Indexes: `userId`, `status`.

### 3.5 `Email`

The normalised message. Body text is minimised before it ever reaches this table.

| Field | Notes |
|---|---|
| `gmailMessageId` | with `userId` forms the idempotency key |
| `gmailThreadId`, `threadKey` | conversation grouping |
| `fromName`, `fromEmail`, `toEmail`, `subject`, `snippet` | headers/preview |
| `bodyText` | salient plain text only; `null` when body storage is off or after retention |
| `receivedAt` | scan ordering |
| `labels[]`, `hasAttachments`, `sizeEstimate`, `isImportant`, `isUnread` | Gmail signals, also used by the protection guard |
| `processingState` | `PENDING` → `QUEUED` → `PROCESSING` → `PROCESSED` / `NEEDS_REVIEW` / `FAILED` / `SKIPPED` |
| `attempts`, `processingError`, `processedAt`, `needsReview` | retry + review queue |
| `deletedFromGmail`, `deletedFromMailops` | deletion is separate from keeping the record |
| `applicationId` | nullable link |

Indexes: `(userId, receivedAt)`, `(userId, processingState)`, `applicationId`,
`gmailThreadId`, `createdAt`.

### 3.6 `EmailAnalysis` (1:1 with Email)

| Field | Notes |
|---|---|
| `category` | one of the 8 primary categories |
| `subCategory` | one of the 14 job sub-categories, or `null` |
| `priority`, `confidence`, `requiresAction`, `needsReview` | decision inputs |
| `reasoning` | one short user-facing sentence — never chain-of-thought |
| `summary` | dashboard one-liner |
| `extracted` (JSON) | validated structured extraction **plus** `_decision` (the engine's verdict) |
| `isUnwanted`, `unwantedReason` | cleanup signal |
| `provider`, `model`, `promptVersion`, `latencyMs`, `tokenUsage` | traceability of how the analysis was produced |

Indexes: `(userId, category)`, `(userId, subCategory)`, `(userId, needsReview)`,
`emailId` unique.

### 3.7 `Application`

The durable record.

| Field | Notes |
|---|---|
| `company`, `role`, `jobId`, `applicationRefId` | identity |
| `companyKey`, `roleKey` | normalised, indexed, used for matching |
| `location`, `employmentType`, `salary`, `source`, `applicationUrl`, `jobUrl` | context |
| `recruiterName`, `recruiterEmail` | from extraction or the user |
| `appliedDate` | falls back to the email date |
| `status`, `statusChangedAt` | pipeline stage; transitions are forward-only except terminal states |
| `lastEmailAt`, `lastUpdated` | activity ordering |
| `notes`, `isDemo`, `needsReview`, `confidence` | review + provenance |

Indexes: `(userId, status)`, `(userId, companyKey)`, `(userId, roleKey)`,
`(userId, jobId)`, `(userId, lastUpdated)`, `createdAt`.

### 3.8 `ApplicationEvent` (append-only timeline)

| Field | Notes |
|---|---|
| `type` | 14 event types (`APPLICATION_CREATED`, `STATUS_CHANGED`, `INTERVIEW_SCHEDULED`, `REJECTION_RECEIVED`, `DUPLICATE_FLAGGED`, `USER_OVERRIDE`, …) |
| `actor` | `AI` / `USER` / `SYSTEM` — who decided this |
| `title`, `description` | dashboard copy |
| `fromStatus`, `toStatus` | transition record |
| `occurredAt`, `dueAt` | `dueAt` powers "upcoming deadlines" |
| `emailId` | nullable; set to null when the email is purged |
| `confidence`, `metadata` | provenance |

Indexes: `(applicationId, occurredAt)`, `(userId, occurredAt)`,
`(userId, dueAt)`, `emailId`.

### 3.9 `Notification` and `NotificationAttempt`

| Field | Notes |
|---|---|
| `type`, `severity`, `title`, `body`, `actionUrl`, `actionLabel` | content |
| `requiresAck`, `acknowledgedAt`, `acknowledgedVia` | acknowledgement controls the ladder |
| `status` | `PENDING` / `SENT` / `ACKNOWLEDGED` / `ESCALATED` / `RESOLVED` / `FAILED` / `CANCELLED` / `SUPPRESSED` |
| `escalationStage` | `-1` = base delivery; `0..n` = ladder position |
| `nextEscalationAt`, `escalationPaused`, `resolvedAt` | timer state |
| `dedupeKey` | with `userId` forms `@@unique` so a re-fire updates rather than duplicates |
| `metadata` | stores `plan` (the frozen escalation ladder) and `payload` (channel-ready content) |

`NotificationAttempt` records every delivery: `channel`, `status`
(`PENDING`/`SENT`/`FAILED`/`SKIPPED`), `stage`, `provider`,
`providerMessageId`, `error`, `attemptNo`, `sentAt`. Indexed on
`(notificationId, createdAt)` and `status`.

### 3.10 `Integration`

One row per `(user, kind)` where kind ∈ `SLACK`/`WHATSAPP`/`VOICE`/`EMAIL`/`AI`.

`config` (JSON) holds non-secret settings (channel name, phone number,
recipient). `secretsEnc` holds encrypted credentials. `status`, `lastVerifiedAt`,
`lastError` drive the Settings UI. The API never returns secrets — only
`hasCredentials`.

### 3.11 `CleanupAction`

| Field | Notes |
|---|---|
| `type` | `DELETE` / `ARCHIVE` / `KEEP` / `IGNORE_SENDER` / `UNSUBSCRIBE` |
| `status` | `PROPOSED` / `APPROVED` / `EXECUTED` / `FAILED` / `SKIPPED` / `REVERTED` / `BLOCKED` |
| `category`, `reason`, `senderEmail`, `batchId` | grouping and review |
| `protectedReason` | set when a protection rule blocked the action |
| `approvedAt`, `executedAt`, `error`, `audit` | execution record |

Indexes: `(userId, status)`, `(userId, batchId)`, `emailId`.

### 3.12 `ScanJob`

One row per scan: `type` (`INITIAL`/`SCHEDULED`/`MANUAL`), `status`, timing,
counters (`messagesScanned`, `messagesNew`, `messagesQueued`, `messagesSkipped`),
`cursor`, `error`, `triggeredBy`. Indexes: `(userId, createdAt)`,
`(gmailAccountId, status)`.

### 3.13 `AuditLog`

Append-only: `actor`, `action` (dotted, stable — `email.classified`,
`application.status_changed`, `cleanup.executed`, …), `entityType`, `entityId`,
`summary`, `metadata` (sanitised and truncated), `ip`, `userAgent`. Indexes:
`(userId, createdAt)`, `(userId, action)`.

---

## 4. Enums

| Enum | Values |
|---|---|
| `EmailCategory` | `JOB`, `PROMOTIONAL`, `SPAM`, `NEWSLETTER`, `SOCIAL`, `PERSONAL`, `TRANSACTIONAL`, `OTHER` |
| `JobSubCategory` | `APPLICATION_RECEIVED`, `APPLICATION_ACKNOWLEDGED`, `SHORTLISTED`, `ASSESSMENT`, `INTERVIEW`, `NEXT_ROUND`, `FINAL_ROUND`, `RECRUITER_CONTACT`, `OFFER`, `OFFER_ACCEPTED`, `REJECTION`, `WITHDRAWN`, `JOB_ALERT`, `OTHER_JOB` |
| `ApplicationStatus` | `APPLIED`, `ACKNOWLEDGED`, `SHORTLISTED`, `ASSESSMENT`, `INTERVIEW`, `FINAL_ROUND`, `OFFER`, `ACCEPTED`, `REJECTED`, `WITHDRAWN`, `ON_HOLD`, `NO_RESPONSE` |
| `Priority` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `NotificationSeverity` | `INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `NotificationStatus` | `PENDING`, `SENT`, `ACKNOWLEDGED`, `ESCALATED`, `RESOLVED`, `FAILED`, `CANCELLED`, `SUPPRESSED` |
| `Channel` | `DASHBOARD`, `SLACK`, `WHATSAPP`, `EMAIL`, `VOICE` |
| `AttemptStatus` | `PENDING`, `SENT`, `FAILED`, `SKIPPED` |
| `IntegrationKind` / `IntegrationStatus` | `SLACK`/`WHATSAPP`/`VOICE`/`EMAIL`/`AI` · `CONNECTED`/`DISCONNECTED`/`ERROR`/`PENDING` |
| `CleanupActionType` / `CleanupActionStatus` | see §3.11 |
| `ScanType` / `ScanStatus` | `INITIAL`/`SCHEDULED`/`MANUAL` · `QUEUED`/`RUNNING`/`COMPLETED`/`FAILED`/`PARTIAL` |
| `AuditActor` | `AI`, `SYSTEM`, `USER` |
| `EmailProcessingState` | `PENDING`, `QUEUED`, `PROCESSING`, `PROCESSED`, `NEEDS_REVIEW`, `FAILED`, `SKIPPED` |
| `GmailAccountStatus` | `CONNECTED`, `EXPIRED`, `DISCONNECTED`, `ERROR` |

---

## 5. Status semantics

`SUBCATEGORY_TO_STATUS` (`config/constants.ts`) maps a job sub-category to an
application status. `STATUS_RANK` orders the pipeline:

```
NO_RESPONSE 0 < APPLIED 1 < ACKNOWLEDGED 2 < SHORTLISTED 3 < ASSESSMENT 4
             < INTERVIEW 5 < FINAL_ROUND 6 = ON_HOLD 6 < OFFER 7 < ACCEPTED 8
             < REJECTED 9 = WITHDRAWN 9
```

Transition rule (`applyEmailToApplication`):

- `REJECTED` / `WITHDRAWN` always apply (terminal).
- Everything else applies only when its rank exceeds the current rank.
- `OFFER_ACCEPTED` may re-assert an existing `ACCEPTED` status.

---

## 6. Retention and deletion semantics

Three distinct operations, deliberately not conflated:

| Operation | Effect on emails | Effect on history |
|---|---|---|
| **Cleanup (approved)** | Archive or move to Trash in Gmail; `deletedFromGmail = true` | None — the event stays, `emailId` is retained |
| **Retention sweep** (daily, `dataRetentionDays`) | Bodies older than the window set to `null`; unlinked emails past the window deleted; `emailId` on events/notifications/cleanup detached first | **Application and ApplicationEvent rows are never touched** |
| **Delete my email data** (user-initiated) | All `Email` + `EmailAnalysis` + `ScanJob` rows deleted; references detached | Preserved when `keepApplicationHistory = true` (the default), otherwise deleted too |

---

## 7. Common queries

```ts
// Idempotent ingestion — a racing scan cannot create a duplicate
await prisma.email.create({ data: { ..., gmailMessageId } });   // P2002 = already stored

// Candidate retrieval for matching (indexed, no table scan)
await prisma.application.findMany({
  where: { userId, OR: [{ companyKey: { contains: companyKey } }, { jobId: { equals: jobId } }] },
  orderBy: { lastEmailAt: "desc" },
});

// Upcoming deadlines
await prisma.applicationEvent.findMany({
  where: { userId, dueAt: { not: null, gte: new Date() } },
  orderBy: { dueAt: "asc" },
});

// Escalations that are due, for the safety-net sweep
await prisma.notification.findMany({
  where: {
    requiresAck: true, acknowledgedAt: null, escalationPaused: false,
    status: { in: ["PENDING", "SENT", "ESCALATED"] },
    nextEscalationAt: { lte: new Date() },
  },
});

// Emails awaiting human confirmation
await prisma.email.count({ where: { userId, needsReview: true } });
```

---

## 8. Migrations

```bash
cd backend

npm run prisma:generate                              # after any schema change
npm run prisma:deploy                                # apply committed migrations
npm run prisma:migrate -- --name add_field           # create + apply a new one (dev)
npm run prisma:studio                                # browse data
```

The initial migration was produced with:

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

so a fresh database can be provisioned without an interactive `migrate dev`.

### Changing the encryption key

`ENCRYPTION_KEY` protects `*Enc` columns. Rotating it requires re-encrypting
existing rows — there is no dual-read window (a wrong key produces a decryption
error, not silent corruption, because GCM authenticates). Procedure:

1. Add the new key as `ENCRYPTION_KEY_NEXT`.
2. Run a one-off script that decrypts with the old key and re-encrypts with the new.
3. Swap the values and restart.

Store the old key in a secret manager until the migration is verified.

---

## 9. Seed data

`backend/prisma/seed.ts` is deterministic (seeded PRNG) and writes through Prisma
directly, so it needs no Redis, no AI provider and no Google credentials. It
creates: 1 demo user + settings, 5 integrations, 1 (disconnected) Gmail account,
18 applications with timelines, ~60 emails + analyses across every category,
notifications with escalation attempts, cleanup proposals, 8 scan jobs and an
audit trail. Every row carries `isDemo: true`.

```bash
cd backend
npm run seed
SEED_RESET=true npm run seed     # reset the demo account first
```
