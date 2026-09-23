/**
 * API contract types.
 *
 * Kept in one place so the UI and the client agree on shapes, and so a change to
 * an enum surfaces as a TypeScript error rather than a runtime mismatch.
 */

export type EmailCategory =
  | "JOB"
  | "PROMOTIONAL"
  | "SPAM"
  | "NEWSLETTER"
  | "SOCIAL"
  | "PERSONAL"
  | "TRANSACTIONAL"
  | "OTHER";

export type JobSubCategory =
  | "APPLICATION_RECEIVED"
  | "APPLICATION_ACKNOWLEDGED"
  | "SHORTLISTED"
  | "ASSESSMENT"
  | "INTERVIEW"
  | "NEXT_ROUND"
  | "FINAL_ROUND"
  | "RECRUITER_CONTACT"
  | "OFFER"
  | "OFFER_ACCEPTED"
  | "REJECTION"
  | "WITHDRAWN"
  | "JOB_ALERT"
  | "OTHER_JOB";

export type ApplicationStatus =
  | "APPLIED"
  | "ACKNOWLEDGED"
  | "SHORTLISTED"
  | "ASSESSMENT"
  | "INTERVIEW"
  | "FINAL_ROUND"
  | "OFFER"
  | "ACCEPTED"
  | "REJECTED"
  | "WITHDRAWN"
  | "ON_HOLD"
  | "NO_RESPONSE";

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ChannelName = "DASHBOARD" | "SLACK" | "WHATSAPP" | "EMAIL" | "VOICE";

export type EmailProcessingState =
  | "PENDING"
  | "QUEUED"
  | "PROCESSING"
  | "PROCESSED"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "SKIPPED";

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  meta?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable: boolean;
    degraded: boolean;
    requestId: string;
  };
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
  isDemo: boolean;
}

export interface GmailAccountSummary {
  id: string;
  emailAddress: string;
  status: "CONNECTED" | "EXPIRED" | "DISCONNECTED" | "ERROR";
  grantedScopes: string[];
  lastSyncAt: string | null;
  lastError: string | null;
  scopeAudit?: { ok: boolean; missing: string[] };
}

export interface ScopeDescription {
  scope: string;
  title: string;
  why: string;
  required: boolean;
}

export interface UserSettings {
  scanIntervalMinutes: number;
  scanningEnabled: boolean;
  notifyDashboard: boolean;
  notifySlack: boolean;
  notifyWhatsapp: boolean;
  notifyEmail: boolean;
  notifyVoice: boolean;
  notifyMinSeverity: Severity;
  escalationEnabled: boolean;
  escalationDelaysMinutes: number[];
  escalationMaxStage: number;
  voiceEnabled: boolean;
  voiceMaxCallsPerDay: number;
  voiceQuietHoursStart: number;
  voiceQuietHoursEnd: number;
  voiceCriticalEvents: string[];
  voiceCallsToday: number;
  autoCleanupEnabled: boolean;
  cleanupCategories: string[];
  protectJobEmails: boolean;
  protectPersonal: boolean;
  protectFinancial: boolean;
  protectGovernment: boolean;
  storeEmailBody: boolean;
  dataRetentionDays: number;
  redactSensitiveLogs: boolean;
  updatedAt: string;
}

export interface MeResponse {
  user: User;
  settings: UserSettings;
  gmailAccounts: GmailAccountSummary[];
  csrfToken: string;
  defaults: { gmailConfigured: boolean; aiProvider: string };
}

export interface EmailAnalysis {
  id: string;
  category: EmailCategory;
  subCategory: JobSubCategory | null;
  priority: Priority;
  confidence: number;
  requiresAction: boolean;
  needsReview: boolean;
  reasoning: string | null;
  summary: string | null;
  isUnwanted: boolean;
  unwantedReason: string | null;
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number | null;
  createdAt: string;
}

export interface EmailRecord {
  id: string;
  gmailMessageId: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  snippet: string | null;
  bodyText?: string | null;
  receivedAt: string;
  isImportant: boolean;
  processingState: EmailProcessingState;
  processingError: string | null;
  needsReview: boolean;
  deletedFromGmail: boolean;
  applicationId: string | null;
  labels: string[];
  hasAttachments: boolean;
  analysis: EmailAnalysis | null;
  application?: { id: string; company: string; role: string; status: ApplicationStatus } | null;
}

export interface EmailDetail extends EmailRecord {
  gmailAccount?: { id: string; emailAddress: string; status: string } | null;
  cleanupActions?: CleanupAction[];
  notifications?: NotificationRecord[];
  applicationEvents?: ApplicationEvent[];
  aiAnalysis: {
    category: EmailCategory;
    subCategory: JobSubCategory | null;
    priority: Priority;
    confidence: number;
    requiresAction: boolean;
    needsReview: boolean;
    summary: string | null;
    reasoning: string | null;
    provider: string;
    model: string;
    promptVersion: string;
    analysedAt: string;
  } | null;
}

export interface ApplicationListItem {
  id: string;
  company: string;
  role: string;
  jobId: string | null;
  location: string | null;
  status: ApplicationStatus;
  appliedDate: string | null;
  lastUpdated: string;
  lastEmailAt: string | null;
  needsReview: boolean;
  confidence: number | null;
  recruiterName: string | null;
  recruiterEmail: string | null;
  applicationUrl: string | null;
  salary: string | null;
  isDemo: boolean;
  _count?: { events: number; emails: number };
}

export interface ApplicationEvent {
  id: string;
  type: string;
  actor: "AI" | "USER" | "SYSTEM";
  title: string;
  description: string | null;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
  occurredAt: string;
  dueAt: string | null;
  emailId: string | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
}

export interface ApplicationDetail extends ApplicationListItem {
  applicationRefId: string | null;
  employmentType: string | null;
  source: string | null;
  jobUrl: string | null;
  notes: string | null;
  statusChangedAt: string;
  createdAt: string;
  events: ApplicationEvent[];
  emails: Array<{
    id: string;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
    receivedAt: string;
    snippet: string | null;
    processingState: EmailProcessingState;
    deletedFromGmail: boolean;
    deletedFromMailops: string | null;
    analysis: {
      category: EmailCategory;
      subCategory: JobSubCategory | null;
      priority: Priority;
      confidence: number;
      summary: string | null;
    } | null;
  }>;
  notifications: NotificationRecord[];
}

export interface RejectedApplication {
  id: string;
  company: string;
  role: string;
  jobId: string | null;
  appliedDate: string | null;
  rejectedDate: string;
  status: ApplicationStatus;
  location: string | null;
  originalEmail: {
    id: string;
    subject: string | null;
    fromEmail: string | null;
    receivedAt: string;
    snippet: string | null;
    bodyAvailable: boolean;
    deletedFromGmail: boolean;
  } | null;
  rejectionEvent: {
    id: string;
    title: string;
    description: string | null;
    occurredAt: string;
    confidence: number | null;
  } | null;
}

export interface ApplicationSummary {
  total: number;
  thisWeek: number;
  thisMonth: number;
  shortlisted: number;
  assessments: number;
  interviews: number;
  offers: number;
  rejected: number;
  withdrawn: number;
  active: number;
  needsReview: number;
  byStatus: Record<string, number>;
}

export interface NotificationAttempt {
  id: string;
  channel: ChannelName;
  status: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  stage: number;
  provider: string | null;
  error: string | null;
  attemptNo: number;
  sentAt: string | null;
  createdAt: string;
}

export interface NotificationRecord {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  body: string | null;
  actionUrl: string | null;
  actionLabel: string | null;
  requiresAck: boolean;
  acknowledgedAt: string | null;
  acknowledgedVia: ChannelName | null;
  status: string;
  escalationStage: number;
  nextEscalationAt: string | null;
  escalationPaused: boolean;
  applicationId: string | null;
  emailId: string | null;
  isDemo: boolean;
  createdAt: string;
  application?: { id: string; company: string; role: string } | null;
  attempts?: NotificationAttempt[];
  metadata?: {
    plan?: EscalationPlan;
    payload?: Record<string, unknown>;
    requiredAction?: string | null;
    explanation?: string;
    candidates?: Array<{ id: string; company: string; role: string; status: string }>;
    reason?: string;
  };
}

export interface EscalationPlan {
  channels: { dashboard: boolean; slack: boolean; whatsapp: boolean; email: boolean };
  escalation: { enabled: boolean; delaysMinutes: number[]; maxStage: number; stages: ChannelName[] };
  voiceEligible: boolean;
  voiceEventKey: string | null;
  voiceSuppressionReason: string | null;
}

export interface CleanupAction {
  id: string;
  type: "DELETE" | "ARCHIVE" | "KEEP" | "IGNORE_SENDER" | "UNSUBSCRIBE";
  status: "PROPOSED" | "APPROVED" | "EXECUTED" | "FAILED" | "SKIPPED" | "REVERTED" | "BLOCKED";
  reason: string | null;
  category: EmailCategory | null;
  batchId: string | null;
  senderEmail: string | null;
  protectedReason: string | null;
  executedAt: string | null;
  error: string | null;
  createdAt: string;
  email?: {
    id: string;
    subject: string | null;
    fromName: string | null;
    fromEmail: string | null;
    receivedAt: string;
    snippet: string | null;
    deletedFromGmail: boolean;
    analysis: { category: EmailCategory; confidence: number; summary: string | null; reasoning: string | null } | null;
  } | null;
}

export interface CleanupSummary {
  totalProposed: number;
  byCategory: Record<string, number>;
  bySender: Array<{ sender: string | null; count: number }>;
  protectedCount: number;
  executedCount: number;
  lastProposalAt: string | null;
  autoCleanupEnabled: boolean;
}

export interface CleanupExecutionResult {
  batchId: string;
  requested: number;
  executed: number;
  blocked: Array<{ emailId: string; reason: string }>;
  failed: Array<{ emailId: string; error: string }>;
  skipped: number;
  message: string;
}

export interface ScanSchedule {
  lastScanAt: string | null;
  lastScanStatus: string | null;
  lastScanDurationMs: number | null;
  lastScanError: string | null;
  nextScanAt: string | null;
  intervalMinutes: number;
  scanningEnabled: boolean;
  scannedMessagesLast24h: number;
}

export interface ScanJobRecord {
  id: string;
  type: "INITIAL" | "SCHEDULED" | "MANUAL";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "PARTIAL";
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  messagesScanned: number;
  messagesNew: number;
  messagesQueued: number;
  messagesSkipped: number;
  error: string | null;
  triggeredBy: string;
  createdAt: string;
}

export interface EmailCounters {
  all: number;
  important: number;
  jobs: number;
  promotional: number;
  spam: number;
  newsletters: number;
  rejected: number;
  needsReview: number;
}

export interface AttentionItem {
  kind: "ACTION_REQUIRED" | "DEADLINE" | "IMPORTANT_UPDATE" | "REJECTION" | "REVIEW" | "SYNC_PROBLEM";
  severity: Severity;
  applicationId: string | null;
  emailId: string | null;
  notificationId: string | null;
  company: string | null;
  role: string | null;
  headline: string;
  detail: string | null;
  deadline: string | null;
  actionLabel: string | null;
  actionUrl: string | null;
  occurredAt: string;
}

export interface DashboardPayload {
  greeting: string;
  headline: string;
  generatedAt: string;
  user: { name: string | null; timezone: string; isDemo: boolean };
  summary: ApplicationSummary;
  counters: EmailCounters;
  scan: ScanSchedule;
  cleanup: CleanupSummary;
  notifications: { unread: number; pendingAck: number; escalatedToday: number; recent: NotificationRecord[] };
  attention: AttentionItem[];
  recentApplications: Array<{
    id: string;
    company: string;
    role: string;
    status: ApplicationStatus;
    statusLabel: string;
    appliedDate: string | null;
    lastUpdated: string;
    needsReview: boolean;
  }>;
  importantEmails: Array<{
    id: string;
    subject: string | null;
    fromName: string | null;
    fromEmail: string | null;
    receivedAt: string;
    subCategory: JobSubCategory | null;
    subCategoryLabel: string | null;
    priority: Priority;
    confidence: number;
    summary: string | null;
    applicationId: string | null;
  }>;
  upcomingDeadlines: Array<{
    id: string;
    applicationId: string;
    company: string;
    role: string;
    title: string;
    dueAt: string;
    daysRemaining: number;
    isOverdue: boolean;
  }>;
  activity: { last7Days: Array<{ date: string; applications: number; events: number }> };
}

export interface AnalyticsOverview {
  totals: { applications: number; thisWeek: number; thisMonth: number; responses: number; needsReview: number };
  funnel: Array<{ status: ApplicationStatus; label: string; count: number }>;
  rates: {
    responseRate: number;
    shortlistRate: number;
    interviewRate: number;
    offerRate: number;
    rejectionRate: number;
    assessmentRate: number;
  };
  timings: {
    averageResponseDays: number | null;
    averageApplicationToInterviewDays: number | null;
    medianResponseDays: number | null;
  };
  byCompany: Array<{ company: string; total: number; interviews: number; offers: number; rejections: number }>;
  byRole: Array<{ role: string; total: number }>;
  weeklyActivity: Array<{
    bucket: string;
    label: string;
    applications: number;
    responses: number;
    interviews: number;
    offers: number;
    rejections: number;
  }>;
  monthlyActivity: Array<{
    bucket: string;
    label: string;
    applications: number;
    responses: number;
    interviews: number;
    offers: number;
    rejections: number;
  }>;
  inboxBreakdown: Array<{ category: EmailCategory; count: number }>;
  cleanupImpact: { proposed: number; executed: number };
  notificationStats: { sent: number; acknowledged: number; escalated: number; avgAcknowledgementMinutes: number | null };
  responseTimeByCompany: Array<{ company: string; samples: number; averageDays: number | null; fastestDays: number }>;
}

export interface IntegrationStatus {
  kind: "SLACK" | "WHATSAPP" | "VOICE" | "EMAIL" | "AI";
  status: "CONNECTED" | "DISCONNECTED" | "ERROR" | "PENDING";
  displayName: string | null;
  hasCredentials: boolean;
  config: Record<string, unknown>;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface AuditLogRecord {
  id: string;
  actor: "AI" | "SYSTEM" | "USER";
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PrivacySummary {
  gmailAccounts: Array<{
    id: string;
    emailAddress: string;
    status: string;
    scopes: string[];
    lastSyncAt: string | null;
  }>;
  dataStored: {
    emails: number;
    emailBodiesStored: number;
    analyses: number;
    applications: number;
    applicationEvents: number;
    notifications: number;
    cleanupActions: number;
    auditLogs: number;
  };
  retention: { storeEmailBody: boolean; dataRetentionDays: number; oldestEmailAt: string | null };
  controls: Array<{ id: string; label: string; description: string; endpoint: string; method: string }>;
  aiProcessing: { provider: string; sendsEmailContent: boolean; retainsPromptData: boolean };
}

export interface SettingsResponse {
  account: User & { createdAt: string };
  settings: UserSettings;
  integrations: IntegrationStatus[];
  capabilities: {
    gmailConfigured: boolean;
    slackConfigured: boolean;
    whatsappConfigured: boolean;
    voiceConfigured: boolean;
    aiProvider: string;
    voiceOptInRequired: boolean;
  };
  limits: {
    scanIntervalMinutes: { min: number; max: number };
    voiceMaxCallsPerDay: { min: number; max: number };
    dataRetentionDays: { min: number; max: number };
    escalationDelaysMinutes: { min: number; max: number; maxStages: number };
  };
}
