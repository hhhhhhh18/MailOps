import type { EmailCategory, JobSubCategory, NotificationSeverity, NotificationType, UserSettings } from "@prisma/client";
import {
  ESCALATION_STAGES,
  HIGH_IMPORTANCE_JOB_SUBCATEGORIES,
  NEVER_CLEANUP_CATEGORIES,
  STATUS_LABELS,
  SUBCATEGORY_LABELS,
  SUBCATEGORY_TO_STATUS,
} from "../../config/constants";

/**
 * Decision engine.
 *
 * Sits between the probabilistic AI output and every side effect. Nothing in
 * MailOps sends a notification, escalates to a human-adjacent channel, or
 * proposes a deletion without passing through here.
 *
 *   AI -> Validation -> Confidence threshold -> Decision engine -> (user approval) -> Action
 *
 * All of it is pure and configuration-driven, which is what makes the escalation
 * behaviour testable and prevents "every user receives calls".
 */

export interface DecisionInput {
  category: EmailCategory;
  subCategory: JobSubCategory | null;
  priority: string;
  confidence: number;
  requiresAction: boolean;
  needsReview: boolean;
  isUnwanted: boolean;
  /** Present when the email has already been linked to an application. */
  hasApplication: boolean;
  /** Anything the extractor found that puts a clock on the user. */
  deadlineAt: Date | null;
  isProtectedSender: boolean;
  settings: Pick<
    UserSettings,
    | "notifyDashboard"
    | "notifySlack"
    | "notifyWhatsapp"
    | "notifyEmail"
    | "notifyVoice"
    | "notifyMinSeverity"
    | "escalationEnabled"
    | "escalationDelaysMinutes"
    | "escalationMaxStage"
    | "voiceEnabled"
    | "voiceCriticalEvents"
    | "cleanupCategories"
    | "autoCleanupEnabled"
  >;
  now?: Date;
}

export interface Decision {
  isImportant: boolean;
  shouldNotify: boolean;
  notificationType: NotificationType | null;
  severity: NotificationSeverity;
  requiresAck: boolean;
  channels: {
    dashboard: boolean;
    slack: boolean;
    whatsapp: boolean;
    email: boolean;
    /** Voice is never a first-channel notification; it is an escalation stage. */
    voice: false;
  };
  escalation: {
    enabled: boolean;
    delaysMinutes: number[];
    maxStage: number;
    stages: string[];
  };
  /** Whether this event is allowed to place a call once escalation reaches voice. */
  voiceEligible: boolean;
  voiceEventKey: string | null;
  voiceSuppressionReason: string | null;
  cleanupCandidate: boolean;
  cleanupReason: string | null;
  /** Human-readable, user-facing rationale. Never internal chain-of-thought. */
  explanation: string;
}

const SEVERITY_ORDER: NotificationSeverity[] = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function severityAtLeast(actual: NotificationSeverity, minimum: NotificationSeverity): boolean {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(minimum);
}

/** Maps a job sub-category to the severity of the event it represents. */
function severityForJobEvent(subCategory: JobSubCategory | null, requiresAction: boolean, deadlineAt: Date | null, now: Date): NotificationSeverity {
  const daysToDeadline = deadlineAt ? (deadlineAt.getTime() - now.getTime()) / 86_400_000 : null;
  const imminent = daysToDeadline !== null && daysToDeadline <= 7;

  switch (subCategory) {
    case "OFFER":
    case "OFFER_ACCEPTED":
      return "CRITICAL";
    case "INTERVIEW":
    case "FINAL_ROUND":
    case "NEXT_ROUND":
      return imminent || requiresAction ? "CRITICAL" : "HIGH";
    case "ASSESSMENT":
      return imminent || requiresAction ? "CRITICAL" : "HIGH";
    case "SHORTLISTED":
      return "HIGH";
    case "RECRUITER_CONTACT":
      return requiresAction ? "HIGH" : "MEDIUM";
    case "REJECTION":
    case "WITHDRAWN":
      // Noteworthy and always surfaced, but never treated as urgent.
      return "HIGH";
    case "APPLICATION_ACKNOWLEDGED":
    case "APPLICATION_RECEIVED":
      return "MEDIUM";
    case "JOB_ALERT":
    case "OTHER_JOB":
      return "LOW";
    default:
      return requiresAction ? "MEDIUM" : "LOW";
  }
}

function notificationTypeFor(subCategory: JobSubCategory | null, requiresAction: boolean, needsReview: boolean): NotificationType {
  if (needsReview) return "REVIEW_REQUIRED";
  switch (subCategory) {
    case "OFFER":
    case "OFFER_ACCEPTED":
      return "OFFER_RECEIVED";
    case "REJECTION":
    case "WITHDRAWN":
      return "REJECTION_RECEIVED";
    case "RECRUITER_CONTACT":
      return "RECRUITER_ACTION";
    case "INTERVIEW":
    case "NEXT_ROUND":
    case "FINAL_ROUND":
    case "ASSESSMENT":
    case "SHORTLISTED":
      return requiresAction ? "RECRUITER_ACTION" : "JOB_STATUS_CHANGE";
    default:
      return "JOB_STATUS_CHANGE";
  }
}

/** Maps a job sub-category to the user-configurable voice event key. */
function voiceEventKeyFor(subCategory: JobSubCategory | null, daysToDeadline: number | null): string | null {
  if (subCategory === "OFFER" || subCategory === "OFFER_ACCEPTED") return "OFFER";
  if (subCategory === "INTERVIEW" || subCategory === "FINAL_ROUND" || subCategory === "NEXT_ROUND") return "INTERVIEW";
  if (subCategory === "ASSESSMENT") return "ASSESSMENT";
  if (subCategory === "RECRUITER_CONTACT") return "RECRUITER_ACTION";
  if (daysToDeadline !== null && daysToDeadline <= 3) return "DEADLINE_APPROACHING";
  return null;
}

export function decide(input: DecisionInput): Decision {
  const now = input.now ?? new Date();
  const settings = input.settings;
  const daysToDeadline = input.deadlineAt ? (input.deadlineAt.getTime() - now.getTime()) / 86_400_000 : null;

  const isJob = input.category === "JOB";
  const isImportantJob =
    isJob && (input.subCategory ? HIGH_IMPORTANCE_JOB_SUBCATEGORIES.includes(input.subCategory) : false);
  const isTerminal = input.subCategory === "REJECTION" || input.subCategory === "WITHDRAWN";

  const severity: NotificationSeverity = isJob
    ? severityForJobEvent(input.subCategory, input.requiresAction, input.deadlineAt, now)
    : input.needsReview
      ? "MEDIUM"
      : "LOW";

  // An email whose analysis is uncertain notifies only to ask for confirmation.
  const notificationType: NotificationType | null = input.needsReview
    ? "REVIEW_REQUIRED"
    : isJob
      ? notificationTypeFor(input.subCategory, input.requiresAction, false)
      : null;

  const isImportant = isJob && (isImportantJob || isTerminal || input.requiresAction);

  const shouldNotify =
    Boolean(notificationType) &&
    settings.notifyDashboard &&
    (input.needsReview || severityAtLeast(severity, settings.notifyMinSeverity));

  const requiresAck =
    shouldNotify &&
    settings.escalationEnabled &&
    (severity === "CRITICAL" || (severity === "HIGH" && input.requiresAction)) &&
    !input.needsReview;

  // Escalation stages the user has actually enabled channels for. A user with
  // only the dashboard enabled never gets a WhatsApp message, let alone a call.
  const delays = settings.escalationDelaysMinutes?.length
    ? settings.escalationDelaysMinutes
    : [30, 60, 120];
  const maxStage = Math.max(0, Math.min(settings.escalationMaxStage, ESCALATION_STAGES.length - 1));
  const stages = ESCALATION_STAGES.slice(0, maxStage + 1).filter((stage) => {
    if (stage === "SLACK") return settings.notifySlack;
    if (stage === "WHATSAPP") return settings.notifyWhatsapp;
    if (stage === "VOICE") return settings.notifyVoice && settings.voiceEnabled;
    return false;
  });

  const escalationEnabled = requiresAck && settings.escalationEnabled && stages.length > 0;

  const voiceEventKey = voiceEventKeyFor(input.subCategory, daysToDeadline);
  let voiceEligible = false;
  let voiceSuppressionReason: string | null = null;

  if (!settings.voiceEnabled) {
    voiceSuppressionReason = "Voice escalation is disabled for this account.";
  } else if (!settings.notifyVoice) {
    voiceSuppressionReason = "The voice notification channel is switched off.";
  } else if (!stages.includes("VOICE")) {
    voiceSuppressionReason = "Voice is not part of this account's escalation ladder.";
  } else if (!voiceEventKey) {
    voiceSuppressionReason = "This event type is not eligible for a call.";
  } else if (!(settings.voiceCriticalEvents ?? []).includes(voiceEventKey)) {
    voiceSuppressionReason = `Calls for ${voiceEventKey.toLowerCase().replace(/_/g, " ")} events are switched off.`;
  } else if (isTerminal || input.subCategory === "JOB_ALERT") {
    voiceSuppressionReason = "Rejections and job alerts never trigger a call.";
  } else if (!severityAtLeast(severity, "HIGH")) {
    voiceSuppressionReason = "Only high-severity events can trigger a call.";
  } else {
    voiceEligible = true;
  }

  // Cleanup candidacy. Protected categories are excluded here as well as in the
  // cleanup executor — two independent guards for a destructive path.
  const categoryAllowed =
    settings.cleanupCategories?.includes(input.category) ?? ["PROMOTIONAL", "SPAM", "NEWSLETTER"].includes(input.category);
  const cleanupCandidate =
    (input.isUnwanted || ["PROMOTIONAL", "SPAM", "NEWSLETTER"].includes(input.category)) &&
    categoryAllowed &&
    !NEVER_CLEANUP_CATEGORIES.includes(input.category) &&
    !isJob &&
    !input.isProtectedSender;

  const cleanupReason = cleanupCandidate
    ? input.category === "SPAM"
      ? "Identified as spam by the classifier"
      : input.category === "NEWSLETTER"
        ? "Recurring newsletter"
        : "Promotional bulk mail"
    : null;

  return {
    isImportant,
    shouldNotify,
    notificationType,
    severity,
    requiresAck,
    channels: {
      dashboard: settings.notifyDashboard,
      slack: settings.notifySlack && severityAtLeast(severity, "HIGH"),
      whatsapp: settings.notifyWhatsapp && severityAtLeast(severity, "HIGH"),
      email: settings.notifyEmail && severityAtLeast(severity, "MEDIUM"),
      voice: false,
    },
    escalation: {
      enabled: escalationEnabled,
      delaysMinutes: delays,
      maxStage,
      stages,
    },
    voiceEligible,
    voiceEventKey,
    voiceSuppressionReason,
    cleanupCandidate,
    cleanupReason,
    explanation: buildExplanation(input, severity, daysToDeadline),
  };
}

function buildExplanation(input: DecisionInput, severity: NotificationSeverity, daysToDeadline: number | null): string {
  const parts: string[] = [];
  if (!input.category || input.category === "OTHER") {
    parts.push("No strong recruitment signals were detected.");
  } else if (input.category === "JOB" && input.subCategory) {
    parts.push(`${SUBCATEGORY_LABELS[input.subCategory]} detected.`);
    const mapped = SUBCATEGORY_TO_STATUS[input.subCategory];
    if (mapped) parts.push(`Mapped to application status ${STATUS_LABELS[mapped]}.`);
    if (daysToDeadline !== null && daysToDeadline >= 0) {
      parts.push(`Deadline is ${Math.max(0, Math.round(daysToDeadline))} day(s) away.`);
    } else if (input.deadlineAt) {
      parts.push("The stated deadline has already passed.");
    }
  } else {
    parts.push(`${input.category} mail.`);
  }
  parts.push(`Severity ${severity} at ${(input.confidence * 100).toFixed(0)}% confidence.`);
  if (input.needsReview) parts.push("Queued for your confirmation because confidence was low.");
  return parts.join(" ");
}

/** Convenience: is this event loud enough to consider a call at all? */
export function isVoiceCandidate(decision: Decision): boolean {
  return decision.voiceEligible && decision.escalation.enabled;
}
