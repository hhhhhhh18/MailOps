import type { ApplicationStatus, JobSubCategory, EmailCategory } from "@prisma/client";

/** BullMQ queue names. Keep in sync with src/queues/*. */
export const QUEUES = {
  emailScan: "email-scan",
  emailProcessing: "email-processing",
  applicationProcessing: "application-processing",
  notification: "notification",
  cleanup: "cleanup",
  escalation: "escalation",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Job names per queue. */
export const JOBS = {
  scanAccount: "scan-account",
  scanAllAccounts: "scan-all-accounts",
  processEmail: "process-email",
  updateApplication: "update-application",
  sendNotification: "send-notification",
  dispatchChannel: "dispatch-channel",
  executeCleanup: "execute-cleanup",
  proposeCleanup: "propose-cleanup",
  evaluateEscalation: "evaluate-escalation",
  retentionSweep: "retention-sweep",
} as const;

/** AI prompt versions. Bump when a prompt changes so stored analyses stay traceable. */
export const PROMPT_VERSIONS = {
  classifier: "classifier@1.3.0",
  extractor: "extractor@1.2.0",
  summarizer: "summarizer@1.0.0",
  duplicateDetector: "duplicate-detector@1.1.0",
  applicationMatcher: "application-matcher@1.1.0",
  voiceScript: "voice-script@1.0.0",
} as const;

export const DEFAULT_SCAN_INTERVAL_MINUTES = 210; // 3.5 hours

export const DEFAULT_ESCALATION_DELAYS_MINUTES = [30, 60, 120];

/** Ordered escalation stages. Index === Notification.escalationStage. */
export const ESCALATION_STAGES = ["SLACK", "WHATSAPP", "VOICE"] as const;
export type EscalationStage = (typeof ESCALATION_STAGES)[number];

/** Job sub-categories that always warrant the user's attention. */
export const HIGH_IMPORTANCE_JOB_SUBCATEGORIES: JobSubCategory[] = [
  "SHORTLISTED",
  "ASSESSMENT",
  "INTERVIEW",
  "NEXT_ROUND",
  "FINAL_ROUND",
  "OFFER",
  "OFFER_ACCEPTED",
  "RECRUITER_CONTACT",
];

/** Job sub-categories that may trigger a voice call (also user-configurable). */
export const VOICE_ELIGIBLE_EVENTS = [
  "OFFER",
  "INTERVIEW",
  "ASSESSMENT",
  "RECRUITER_ACTION",
  "DEADLINE_APPROACHING",
] as const;

/** Categories that create/update structured application records. */
export const APPLICATION_MUTATING_SUBCATEGORIES: JobSubCategory[] = [
  "APPLICATION_RECEIVED",
  "APPLICATION_ACKNOWLEDGED",
  "SHORTLISTED",
  "ASSESSMENT",
  "INTERVIEW",
  "NEXT_ROUND",
  "FINAL_ROUND",
  "RECRUITER_CONTACT",
  "OFFER",
  "OFFER_ACCEPTED",
  "REJECTION",
  "WITHDRAWN",
];

/** Categories MailOps may propose for cleanup. */
export const CLEANUP_CATEGORIES: EmailCategory[] = [
  "PROMOTIONAL",
  "SPAM",
  "NEWSLETTER",
  "OTHER",
];

/**
 * Categories that are never proposed for cleanup, regardless of user settings.
 * Financial / government / personal mail is treated as protected by default.
 */
export const NEVER_CLEANUP_CATEGORIES: EmailCategory[] = [
  "JOB",
  "PERSONAL",
  "TRANSACTIONAL",
];

/**
 * Status ranking used by the application matcher: an incoming email may only
 * move an application forward, never silently backward. Rejection/withdrawal are
 * the only backward transitions and are handled explicitly.
 */
export const STATUS_RANK: Record<ApplicationStatus, number> = {
  NO_RESPONSE: 0,
  APPLIED: 1,
  ACKNOWLEDGED: 2,
  SHORTLISTED: 3,
  ASSESSMENT: 4,
  INTERVIEW: 5,
  FINAL_ROUND: 6,
  ON_HOLD: 6,
  OFFER: 7,
  ACCEPTED: 8,
  REJECTED: 9,
  WITHDRAWN: 9,
};

/** Job sub-category -> application status. */
export const SUBCATEGORY_TO_STATUS: Partial<Record<JobSubCategory, ApplicationStatus>> = {
  APPLICATION_RECEIVED: "APPLIED",
  APPLICATION_ACKNOWLEDGED: "ACKNOWLEDGED",
  SHORTLISTED: "SHORTLISTED",
  ASSESSMENT: "ASSESSMENT",
  INTERVIEW: "INTERVIEW",
  NEXT_ROUND: "INTERVIEW",
  FINAL_ROUND: "FINAL_ROUND",
  RECRUITER_CONTACT: "ACKNOWLEDGED",
  OFFER: "OFFER",
  OFFER_ACCEPTED: "ACCEPTED",
  REJECTION: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
};

/** Human-readable labels for job sub-categories (used by UI + notifications). */
export const SUBCATEGORY_LABELS: Record<JobSubCategory, string> = {
  APPLICATION_RECEIVED: "Application received",
  APPLICATION_ACKNOWLEDGED: "Application acknowledged",
  SHORTLISTED: "Shortlisted",
  ASSESSMENT: "Assessment",
  INTERVIEW: "Interview invitation",
  NEXT_ROUND: "Next round",
  FINAL_ROUND: "Final round",
  RECRUITER_CONTACT: "Recruiter message",
  OFFER: "Offer",
  OFFER_ACCEPTED: "Offer accepted",
  REJECTION: "Rejection",
  WITHDRAWN: "Withdrawn",
  JOB_ALERT: "Job alert",
  OTHER_JOB: "Job-related",
};

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  APPLIED: "Applied",
  ACKNOWLEDGED: "Acknowledged",
  SHORTLISTED: "Shortlisted",
  ASSESSMENT: "Assessment",
  INTERVIEW: "Interview",
  FINAL_ROUND: "Final round",
  OFFER: "Offer",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
  ON_HOLD: "On hold",
  NO_RESPONSE: "No response",
};

/** Canonical demo company list used by the seed script. */
export const DEMO_COMPANIES = [
  "Microsoft",
  "Google",
  "Amazon",
  "Deloitte",
  "TCS",
  "Infosys",
  "Accenture",
  "Wipro",
  "Cognizant",
  "Salesforce",
] as const;

/** Default page size for list endpoints. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Notification dedupe window: identical events within this window collapse. */
export const NOTIFICATION_DEDUPE_WINDOW_MINUTES = 180;

/** BullMQ retry policy for transient failures. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};
