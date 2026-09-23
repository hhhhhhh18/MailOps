-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('JOB', 'PROMOTIONAL', 'SPAM', 'NEWSLETTER', 'SOCIAL', 'PERSONAL', 'TRANSACTIONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "JobSubCategory" AS ENUM ('APPLICATION_RECEIVED', 'APPLICATION_ACKNOWLEDGED', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'NEXT_ROUND', 'FINAL_ROUND', 'RECRUITER_CONTACT', 'OFFER', 'OFFER_ACCEPTED', 'REJECTION', 'WITHDRAWN', 'JOB_ALERT', 'OTHER_JOB');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EmailProcessingState" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'PROCESSED', 'NEEDS_REVIEW', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('APPLIED', 'ACKNOWLEDGED', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'FINAL_ROUND', 'OFFER', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'ON_HOLD', 'NO_RESPONSE');

-- CreateEnum
CREATE TYPE "ApplicationEventType" AS ENUM ('APPLICATION_CREATED', 'STATUS_CHANGED', 'EMAIL_LINKED', 'NOTE_ADDED', 'DEADLINE_SET', 'ACTION_REQUIRED', 'RECRUITER_CONTACT', 'INTERVIEW_SCHEDULED', 'ASSESSMENT_ASSIGNED', 'OFFER_ISSUED', 'REJECTION_RECEIVED', 'WITHDRAWN', 'DUPLICATE_FLAGGED', 'USER_OVERRIDE');

-- CreateEnum
CREATE TYPE "EventActor" AS ENUM ('AI', 'USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('JOB_IMPORTANT', 'JOB_STATUS_CHANGE', 'DEADLINE_APPROACHING', 'OFFER_RECEIVED', 'REJECTION_RECEIVED', 'RECRUITER_ACTION', 'CLEANUP_PROPOSAL', 'REVIEW_REQUIRED', 'SYNC_FAILURE', 'INTEGRATION_FAILURE', 'DIGEST');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'ESCALATED', 'RESOLVED', 'FAILED', 'CANCELLED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('DASHBOARD', 'SLACK', 'WHATSAPP', 'EMAIL', 'VOICE');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('SLACK', 'WHATSAPP', 'VOICE', 'EMAIL', 'AI');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR', 'PENDING');

-- CreateEnum
CREATE TYPE "CleanupActionType" AS ENUM ('DELETE', 'ARCHIVE', 'KEEP', 'IGNORE_SENDER', 'UNSUBSCRIBE');

-- CreateEnum
CREATE TYPE "CleanupActionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'EXECUTED', 'FAILED', 'SKIPPED', 'REVERTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ScanType" AS ENUM ('INITIAL', 'SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('AI', 'SYSTEM', 'USER');

-- CreateEnum
CREATE TYPE "GmailAccountStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'DISCONNECTED', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "avatarUrl" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scanIntervalMinutes" INTEGER NOT NULL DEFAULT 210,
    "scanningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "notifyDashboard" BOOLEAN NOT NULL DEFAULT true,
    "notifySlack" BOOLEAN NOT NULL DEFAULT false,
    "notifyWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
    "notifyVoice" BOOLEAN NOT NULL DEFAULT false,
    "notifyMinSeverity" "NotificationSeverity" NOT NULL DEFAULT 'MEDIUM',
    "escalationDelaysMinutes" INTEGER[] DEFAULT ARRAY[30, 60, 120]::INTEGER[],
    "escalationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "escalationMaxStage" INTEGER NOT NULL DEFAULT 2,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "voiceMaxCallsPerDay" INTEGER NOT NULL DEFAULT 2,
    "voiceQuietHoursStart" INTEGER NOT NULL DEFAULT 22,
    "voiceQuietHoursEnd" INTEGER NOT NULL DEFAULT 7,
    "voiceCriticalEvents" TEXT[] DEFAULT ARRAY['OFFER', 'INTERVIEW', 'ASSESSMENT', 'RECRUITER_ACTION']::TEXT[],
    "voiceCallsToday" INTEGER NOT NULL DEFAULT 0,
    "voiceCallsResetAt" TIMESTAMP(3),
    "autoCleanupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cleanupCategories" TEXT[] DEFAULT ARRAY['PROMOTIONAL', 'SPAM', 'NEWSLETTER']::TEXT[],
    "protectJobEmails" BOOLEAN NOT NULL DEFAULT true,
    "protectPersonal" BOOLEAN NOT NULL DEFAULT true,
    "protectFinancial" BOOLEAN NOT NULL DEFAULT true,
    "protectGovernment" BOOLEAN NOT NULL DEFAULT true,
    "storeEmailBody" BOOLEAN NOT NULL DEFAULT true,
    "dataRetentionDays" INTEGER NOT NULL DEFAULT 365,
    "redactSensitiveLogs" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "status" "GmailAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT[],
    "historyId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Email" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gmailAccountId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "gmailThreadId" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "toEmail" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "bodyText" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "sizeEstimate" INTEGER,
    "isImportant" BOOLEAN NOT NULL DEFAULT false,
    "isUnread" BOOLEAN NOT NULL DEFAULT true,
    "processingState" "EmailProcessingState" NOT NULL DEFAULT 'PENDING',
    "processingError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "deletedFromGmail" BOOLEAN NOT NULL DEFAULT false,
    "deletedFromMailops" TIMESTAMP(3),
    "applicationId" TEXT,
    "threadKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAnalysis" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "EmailCategory" NOT NULL,
    "subCategory" "JobSubCategory",
    "priority" "Priority" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "requiresAction" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" TEXT,
    "summary" TEXT,
    "extracted" JSONB NOT NULL DEFAULT '{}',
    "isUnwanted" BOOLEAN NOT NULL DEFAULT false,
    "unwantedReason" TEXT,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "tokenUsage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "jobId" TEXT,
    "applicationRefId" TEXT,
    "location" TEXT,
    "employmentType" TEXT,
    "salary" TEXT,
    "source" TEXT,
    "applicationUrl" TEXT,
    "jobUrl" TEXT,
    "recruiterName" TEXT,
    "recruiterEmail" TEXT,
    "appliedDate" TIMESTAMP(3),
    "status" "ApplicationStatus" NOT NULL DEFAULT 'APPLIED',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "lastEmailAt" TIMESTAMP(3),
    "companyKey" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "notes" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationEvent" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ApplicationEventType" NOT NULL,
    "actor" "EventActor" NOT NULL DEFAULT 'AI',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fromStatus" "ApplicationStatus",
    "toStatus" "ApplicationStatus",
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "emailId" TEXT,
    "confidence" DOUBLE PRECISION,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT,
    "emailId" TEXT,
    "type" "NotificationType" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "actionUrl" TEXT,
    "actionLabel" TEXT,
    "requiresAck" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedVia" "Channel",
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "escalationStage" INTEGER NOT NULL DEFAULT -1,
    "nextEscalationAt" TIMESTAMP(3),
    "escalationPaused" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationAttempt" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'PENDING',
    "stage" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "displayName" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretsEnc" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleanupAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailId" TEXT,
    "applicationId" TEXT,
    "type" "CleanupActionType" NOT NULL,
    "status" "CleanupActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "reason" TEXT,
    "category" "EmailCategory",
    "batchId" TEXT,
    "senderEmail" TEXT,
    "protectedReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "error" TEXT,
    "audit" JSONB NOT NULL DEFAULT '{}',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleanupAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gmailAccountId" TEXT NOT NULL,
    "type" "ScanType" NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "messagesScanned" INTEGER NOT NULL DEFAULT 0,
    "messagesNew" INTEGER NOT NULL DEFAULT 0,
    "messagesQueued" INTEGER NOT NULL DEFAULT 0,
    "messagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "error" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "triggeredBy" TEXT NOT NULL DEFAULT 'scheduler',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScanJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actor" "AuditActor" NOT NULL DEFAULT 'SYSTEM',
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE INDEX "GmailAccount_userId_idx" ON "GmailAccount"("userId");

-- CreateIndex
CREATE INDEX "GmailAccount_status_idx" ON "GmailAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_userId_emailAddress_key" ON "GmailAccount"("userId", "emailAddress");

-- CreateIndex
CREATE INDEX "Email_userId_receivedAt_idx" ON "Email"("userId", "receivedAt");

-- CreateIndex
CREATE INDEX "Email_userId_processingState_idx" ON "Email"("userId", "processingState");

-- CreateIndex
CREATE INDEX "Email_applicationId_idx" ON "Email"("applicationId");

-- CreateIndex
CREATE INDEX "Email_gmailThreadId_idx" ON "Email"("gmailThreadId");

-- CreateIndex
CREATE INDEX "Email_createdAt_idx" ON "Email"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Email_userId_gmailMessageId_key" ON "Email"("userId", "gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAnalysis_emailId_key" ON "EmailAnalysis"("emailId");

-- CreateIndex
CREATE INDEX "EmailAnalysis_userId_category_idx" ON "EmailAnalysis"("userId", "category");

-- CreateIndex
CREATE INDEX "EmailAnalysis_userId_subCategory_idx" ON "EmailAnalysis"("userId", "subCategory");

-- CreateIndex
CREATE INDEX "EmailAnalysis_userId_needsReview_idx" ON "EmailAnalysis"("userId", "needsReview");

-- CreateIndex
CREATE INDEX "Application_userId_status_idx" ON "Application"("userId", "status");

-- CreateIndex
CREATE INDEX "Application_userId_companyKey_idx" ON "Application"("userId", "companyKey");

-- CreateIndex
CREATE INDEX "Application_userId_roleKey_idx" ON "Application"("userId", "roleKey");

-- CreateIndex
CREATE INDEX "Application_userId_jobId_idx" ON "Application"("userId", "jobId");

-- CreateIndex
CREATE INDEX "Application_userId_lastUpdated_idx" ON "Application"("userId", "lastUpdated");

-- CreateIndex
CREATE INDEX "Application_createdAt_idx" ON "Application"("createdAt");

-- CreateIndex
CREATE INDEX "ApplicationEvent_applicationId_occurredAt_idx" ON "ApplicationEvent"("applicationId", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationEvent_userId_occurredAt_idx" ON "ApplicationEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationEvent_userId_dueAt_idx" ON "ApplicationEvent"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "ApplicationEvent_emailId_idx" ON "ApplicationEvent"("emailId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_status_idx" ON "Notification"("userId", "status");

-- CreateIndex
CREATE INDEX "Notification_nextEscalationAt_idx" ON "Notification"("nextEscalationAt");

-- CreateIndex
CREATE INDEX "Notification_applicationId_idx" ON "Notification"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationAttempt_notificationId_createdAt_idx" ON "NotificationAttempt"("notificationId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationAttempt_status_idx" ON "NotificationAttempt"("status");

-- CreateIndex
CREATE INDEX "Integration_userId_idx" ON "Integration"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_userId_kind_key" ON "Integration"("userId", "kind");

-- CreateIndex
CREATE INDEX "CleanupAction_userId_status_idx" ON "CleanupAction"("userId", "status");

-- CreateIndex
CREATE INDEX "CleanupAction_userId_batchId_idx" ON "CleanupAction"("userId", "batchId");

-- CreateIndex
CREATE INDEX "CleanupAction_emailId_idx" ON "CleanupAction"("emailId");

-- CreateIndex
CREATE INDEX "ScanJob_userId_createdAt_idx" ON "ScanJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanJob_gmailAccountId_status_idx" ON "ScanJob"("gmailAccountId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_action_idx" ON "AuditLog"("userId", "action");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "GmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAnalysis" ADD CONSTRAINT "EmailAnalysis_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAnalysis" ADD CONSTRAINT "EmailAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationAttempt" ADD CONSTRAINT "NotificationAttempt_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanupAction" ADD CONSTRAINT "CleanupAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanupAction" ADD CONSTRAINT "CleanupAction_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanupAction" ADD CONSTRAINT "CleanupAction_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanJob" ADD CONSTRAINT "ScanJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanJob" ADD CONSTRAINT "ScanJob_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "GmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

