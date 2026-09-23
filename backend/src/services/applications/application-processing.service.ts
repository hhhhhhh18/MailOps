import type { EmailAnalysis, Prisma } from "@prisma/client";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { describeError, NotFoundError } from "../../utils/errors";
import { isProtectedSender } from "../ai/heuristics/signals";
import { pickDeadline } from "../ai/analysis.service";
import type { ExtractorOutput } from "../ai/schemas";
import { matchEmailToApplication } from "../ai/application-matcher";
import { detectDuplicateApplication } from "../ai/duplicate-detector";
import { decide, type Decision } from "../decisions/decision.engine";
import { buildPlan } from "../notifications/escalation.service";
import { buildDedupeKey, buildNotificationContent, createNotification } from "../notifications/notification.service";
import { proposeCleanupForEmail } from "../cleanup/cleanup.service";
import { enqueueNotification } from "../../queues";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import {
  applyEmailToApplication,
  createApplication,
  findApplicationCandidates,
  findDuplicateCandidates,
  flagPossibleDuplicate,
  type CandidateRecord,
} from "./application.service";

/**
 * The REMEMBER -> DECIDE -> ACT -> INFORM stage of the agent loop.
 *
 * Takes an analysed email and decides:
 *   - which existing application it belongs to (or that it starts a new one)
 *   - whether it is a possible duplicate of an earlier application
 *   - whether the user must be interrupted about it, and via which channels
 *   - whether it should be proposed for cleanup instead
 *
 * Every branch is idempotent, so a retried job converges rather than duplicating.
 */

export interface ProcessEmailOutcome {
  emailId: string;
  outcome:
    | "LINKED_TO_APPLICATION"
    | "CREATED_APPLICATION"
    | "AWAITING_USER_MATCH"
    | "AWAITING_USER_REVIEW"
    | "CLEANUP_PROPOSED"
    | "NO_ACTION";
  applicationId: string | null;
  statusChanged: boolean;
  notificationId: string | null;
  duplicateApplicationId: string | null;
  cleanupActionId: string | null;
  notes: string[];
}

export async function processApplicationFromEmail(params: {
  userId: string;
  emailId: string;
  analysisId: string;
}): Promise<ProcessEmailOutcome> {
  const email = await prisma.email.findFirst({
    where: { id: params.emailId, userId: params.userId },
    include: { analysis: true, user: { include: { settings: true } } },
  });

  if (!email) throw new NotFoundError("Email");
  const analysis = email.analysis;
  if (!analysis) throw new NotFoundError("Email analysis");

  const notes: string[] = [];
  const settings = email.user.settings;
  const extraction = (analysis.extracted ?? {}) as ExtractorOutput & { _decision?: Record<string, unknown> };
  const deadlineAt = pickDeadline(extraction);

  // Recompute the decision against *current* settings. Using live settings (rather
  // than a stored snapshot) means a settings change between analysis and dispatch
  // is respected rather than bypassed.
  const decision: Decision = decide({
    category: analysis.category,
    subCategory: analysis.subCategory,
    priority: analysis.priority,
    confidence: analysis.confidence,
    requiresAction: analysis.requiresAction,
    needsReview: analysis.needsReview,
    isUnwanted: analysis.isUnwanted,
    hasApplication: Boolean(email.applicationId),
    deadlineAt,
    isProtectedSender: isProtectedSender(email.fromEmail),
    settings: settings ?? fallbackSettings(),
  });

  // ---------------------------------------------------------------------------
  // 1. Uncertain analysis -> ask the user, change nothing else.
  // ---------------------------------------------------------------------------
  if (analysis.needsReview && !email.applicationId) {
    const notificationId = await raiseReviewNotification({
      userId: params.userId,
      emailId: email.id,
      analysis,
      decision,
      reason: "MailOps was not confident enough to file this email automatically.",
    });

    notes.push("Queued for user confirmation because the analysis confidence was below the threshold.");
    return {
      emailId: email.id,
      outcome: "AWAITING_USER_REVIEW",
      applicationId: null,
      statusChanged: false,
      notificationId,
      duplicateApplicationId: null,
      cleanupActionId: null,
      notes,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Non-job mail -> cleanup intelligence, never application logic.
  // ---------------------------------------------------------------------------
  if (analysis.category !== "JOB") {
    const cleanupAction = await proposeCleanupForEmail(
      params.userId,
      email.id,
      {
        category: analysis.category,
        subCategory: analysis.subCategory,
        isUnwanted: analysis.isUnwanted,
        unwantedReason: analysis.unwantedReason,
      },
      { fromEmail: email.fromEmail, applicationId: email.applicationId, labels: email.labels },
    );

    if (cleanupAction) {
      notes.push(
        cleanupAction.status === "BLOCKED"
          ? `Cleanup blocked by a protection rule: ${cleanupAction.protectedReason}`
          : "Added to the cleanup review queue (nothing is deleted until you approve it).",
      );
    }

    return {
      emailId: email.id,
      outcome: cleanupAction ? "CLEANUP_PROPOSED" : "NO_ACTION",
      applicationId: email.applicationId,
      statusChanged: false,
      notificationId: null,
      duplicateApplicationId: null,
      cleanupActionId: cleanupAction?.id ?? null,
      notes,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Already linked -> just apply the update.
  // ---------------------------------------------------------------------------
  if (email.applicationId) {
    const result = await applyEmailToApplication({
      userId: params.userId,
      emailId: email.id,
      applicationId: email.applicationId,
      subCategory: analysis.subCategory,
      category: analysis.category,
      priority: analysis.priority,
      confidence: analysis.confidence,
      requiresAction: analysis.requiresAction,
      summary: analysis.summary,
      occurredAt: email.receivedAt,
      dueAt: deadlineAt,
      extracted: extraction as unknown as Record<string, unknown>,
    });

    const notificationId = await maybeNotify({
      userId: params.userId,
      emailId: email.id,
      applicationId: result.application.id,
      analysis,
      decision,
      extraction,
      deadlineAt,
      company: result.application.company,
      role: result.application.role,
      status: result.toStatus,
    });

    return {
      emailId: email.id,
      outcome: "LINKED_TO_APPLICATION",
      applicationId: result.application.id,
      statusChanged: result.statusChanged,
      notificationId,
      duplicateApplicationId: null,
      cleanupActionId: null,
      notes,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Job mail without enough identity to file -> ask the user.
  // ---------------------------------------------------------------------------
  const company = extraction.company?.trim() || null;
  const role = extraction.role?.trim() || null;

  if (!company || !role) {
    const notificationId = await raiseReviewNotification({
      userId: params.userId,
      emailId: email.id,
      analysis,
      decision,
      reason: !company
        ? "MailOps could not confidently identify the hiring company."
        : "MailOps could not confidently identify the role title.",
    });
    notes.push("Company or role is missing; the user must confirm before MailOps creates a record (never invents data).");
    return {
      emailId: email.id,
      outcome: "AWAITING_USER_REVIEW",
      applicationId: null,
      statusChanged: false,
      notificationId,
      duplicateApplicationId: null,
      cleanupActionId: null,
      notes,
    };
  }

  /**
   * Identity of this email, used by the matcher and the duplicate detector.
   * It must be passed explicitly: the deterministic engine reads `incoming`
   * straight from the provider payload, and without it every candidate scores 0.
   */
  const incomingIdentity = {
    company,
    role,
    jobId: extraction.jobId ?? null,
    applicationUrl: extraction.applicationUrl ?? null,
  };

  // ---------------------------------------------------------------------------
  // 5. Match against existing applications.
  // ---------------------------------------------------------------------------
  const candidates = await findApplicationCandidates(params.userId, {
    company,
    role,
    jobId: extraction.jobId,
    applicationUrl: extraction.applicationUrl,
  });

  let matched: CandidateRecord | null = null;
  let matchConfidence = 0;

  if (candidates.length) {
    const match = await matchEmailToApplication({
      subject: email.subject,
      fromEmail: email.fromEmail,
      fromName: email.fromName,
      body: email.bodyText,
      receivedAt: email.receivedAt.toISOString(),
      incoming: incomingIdentity,
      candidates,
    });

    if (match.decision === "AUTO_LINK" && match.matchedApplicationId) {
      matched = candidates.find((c) => c.id === match.matchedApplicationId) ?? null;
      matchConfidence = match.confidence;
    } else if (match.decision === "REVIEW") {
      const notificationId = await raiseReviewNotification({
        userId: params.userId,
        emailId: email.id,
        analysis,
        decision,
        reason: `This email looks like it belongs to an existing application (${Math.round(
          match.confidence * 100,
        )}% match), but not confidently enough to file it automatically.`,
        candidates,
      });
      notes.push("Match confidence was in the review band; the user decides whether to link or create.");
      return {
        emailId: email.id,
        outcome: "AWAITING_USER_MATCH",
        applicationId: null,
        statusChanged: false,
        notificationId,
        duplicateApplicationId: null,
        cleanupActionId: null,
        notes,
      };
    }
  }

  if (matched) {
    const result = await applyEmailToApplication({
      userId: params.userId,
      emailId: email.id,
      applicationId: matched.id,
      subCategory: analysis.subCategory,
      category: analysis.category,
      priority: analysis.priority,
      confidence: analysis.confidence,
      requiresAction: analysis.requiresAction,
      summary: analysis.summary,
      occurredAt: email.receivedAt,
      dueAt: deadlineAt,
      extracted: extraction as unknown as Record<string, unknown>,
    });

    notes.push(`Linked to the existing ${matched.company} — ${matched.role} application at ${Math.round(matchConfidence * 100)}% confidence.`);

    const notificationId = await maybeNotify({
      userId: params.userId,
      emailId: email.id,
      applicationId: result.application.id,
      analysis,
      decision,
      extraction,
      deadlineAt,
      company: result.application.company,
      role: result.application.role,
      status: result.toStatus,
    });

    return {
      emailId: email.id,
      outcome: "LINKED_TO_APPLICATION",
      applicationId: result.application.id,
      statusChanged: result.statusChanged,
      notificationId,
      duplicateApplicationId: null,
      cleanupActionId: null,
      notes,
    };
  }

  // ---------------------------------------------------------------------------
  // 6. New application. Check for a previous application first (advisory only).
  // ---------------------------------------------------------------------------
  let duplicateApplicationId: string | null = null;
  const duplicateCandidates = await findDuplicateCandidates(params.userId, {
    company,
    role,
    jobId: extraction.jobId,
    applicationUrl: extraction.applicationUrl,
  });

  if (duplicateCandidates.length) {
    const duplicate = await detectDuplicateApplication({
      subject: email.subject,
      fromEmail: email.fromEmail,
      fromName: email.fromName,
      body: email.bodyText,
      receivedAt: email.receivedAt.toISOString(),
      incoming: incomingIdentity,
      candidates: duplicateCandidates,
    });
    if (duplicate.isDuplicate && duplicate.previous) {
      duplicateApplicationId = duplicate.previous.id ?? null;
      notes.push(duplicate.rationale ?? "Possible duplicate application detected.");
    }
  }

  const application = await createApplication(
    params.userId,
    {
      company,
      role,
      jobId: extraction.jobId,
      applicationRefId: extraction.applicationId,
      location: extraction.location,
      employmentType: extraction.employmentType,
      salary: extraction.salary,
      source: email.fromEmail ? `email:${email.fromEmail}` : "email",
      applicationUrl: extraction.applicationUrl,
      jobUrl: extraction.jobUrl,
      recruiterName: extraction.recruiterName,
      recruiterEmail: extraction.recruiterEmail,
      appliedDate: extraction.appliedDate ? new Date(extraction.appliedDate) : email.receivedAt,
      status: undefined,
      confidence: extraction.confidence,
    },
    { emailId: email.id, occurredAt: email.receivedAt, actor: "AI" },
  );

  await prisma.email.update({ where: { id: email.id }, data: { applicationId: application.id } });

  // Apply the email's own status/stage information to the brand-new record.
  const applied = await applyEmailToApplication({
    userId: params.userId,
    emailId: email.id,
    applicationId: application.id,
    subCategory: analysis.subCategory,
    category: analysis.category,
    priority: analysis.priority,
    confidence: analysis.confidence,
    requiresAction: analysis.requiresAction,
    summary: analysis.summary,
    occurredAt: email.receivedAt,
    dueAt: deadlineAt,
    extracted: extraction as unknown as Record<string, unknown>,
  });

  let flagged = false;
  if (duplicateApplicationId) {
    const previous = duplicateCandidates.find((c) => c.id === duplicateApplicationId);
    if (previous) {
      await flagPossibleDuplicate(params.userId, application.id, previous, 0.9);
      flagged = true;
    }
  }

  const notificationId = await maybeNotify({
    userId: params.userId,
    emailId: email.id,
    applicationId: application.id,
    analysis,
    decision,
    extraction,
    deadlineAt,
    company: application.company,
    role: application.role,
    status: applied.toStatus,
  });

  notes.push(`Created a new application for ${company} — ${role}.`);
  if (flagged) notes.push("Flagged as a possible duplicate for user review.");

  return {
    emailId: email.id,
    outcome: "CREATED_APPLICATION",
    applicationId: application.id,
    statusChanged: applied.statusChanged,
    notificationId,
    duplicateApplicationId: duplicateApplicationId ?? null,
    cleanupActionId: null,
    notes,
  };
}

/** -------------------------------------------------------------------------- */
/** Notification helpers                                                        */
/** -------------------------------------------------------------------------- */

interface MaybeNotifyInput {
  userId: string;
  emailId: string;
  applicationId: string;
  analysis: EmailAnalysis;
  decision: Decision;
  extraction: ExtractorOutput;
  deadlineAt: Date | null;
  company: string;
  role: string;
  status: import("@prisma/client").ApplicationStatus;
}

async function maybeNotify(input: MaybeNotifyInput): Promise<string | null> {
  if (!input.decision.shouldNotify || !input.decision.notificationType) return null;

  const content = buildNotificationContent({
    type: input.decision.notificationType,
    severity: input.decision.severity,
    analysis: {
      category: input.analysis.category,
      subCategory: input.analysis.subCategory,
      summary: input.analysis.summary,
      confidence: input.analysis.confidence,
      reasoning: input.analysis.reasoning,
    },
    application: { id: input.applicationId, company: input.company, role: input.role, status: input.status },
    email: null,
    deadline: input.deadlineAt,
    requiredAction: input.extraction.requiredAction ?? null,
  });

  const dedupeKey = buildDedupeKey({
    type: input.decision.notificationType,
    emailId: input.emailId,
    applicationId: input.applicationId,
    subCategory: input.analysis.subCategory,
    discriminator: input.status,
  });

  const result = await createNotification({
    userId: input.userId,
    type: input.decision.notificationType,
    severity: input.decision.severity,
    title: content.title,
    body: content.body,
    actionUrl: content.actionUrl,
    actionLabel: content.actionLabel,
    applicationId: input.applicationId,
    emailId: input.emailId,
    requiresAck: input.decision.requiresAck,
    dedupeKey,
    metadata: {
      plan: buildPlan(input.decision),
      payload: content.channelPayload,
      requiredAction: input.extraction.requiredAction ?? null,
      explanation: input.decision.explanation,
    },
  });

  if (result.created) {
    // Delivery happens asynchronously so a slow Slack/WhatsApp provider can never
    // block email processing (which may be processing a batch of hundreds).
    await enqueueNotification({ notificationId: result.notification.id });
    logger.info(
      { notificationId: result.notification.id, applicationId: input.applicationId, severity: input.decision.severity },
      "notification queued for delivery",
    );
  }

  return result.notification.id;
}

interface ReviewNotificationInput {
  userId: string;
  emailId: string;
  analysis: EmailAnalysis;
  decision: Decision;
  reason: string;
  candidates?: CandidateRecord[];
}

async function raiseReviewNotification(input: ReviewNotificationInput): Promise<string | null> {
  const content = buildNotificationContent({
    type: "REVIEW_REQUIRED",
    severity: "MEDIUM",
    analysis: {
      category: input.analysis.category,
      subCategory: input.analysis.subCategory,
      summary: input.analysis.summary,
      confidence: input.analysis.confidence,
      reasoning: input.reason,
    },
    application: null,
    email: { id: input.emailId, subject: null, fromName: null, fromEmail: null, receivedAt: new Date() },
    deadline: null,
    requiredAction: null,
  });

  const result = await createNotification({
    userId: input.userId,
    type: "REVIEW_REQUIRED",
    severity: "MEDIUM",
    title: content.title,
    body: `${input.reason}\n${content.body}`.trim(),
    actionUrl: `/emails?emailId=${input.emailId}`,
    actionLabel: "Review email",
    emailId: input.emailId,
    requiresAck: false,
    dedupeKey: `REVIEW_REQUIRED:${input.emailId}`,
    metadata: {
      plan: buildPlan({ ...input.decision, escalation: { ...input.decision.escalation, enabled: false, stages: [] }, requiresAck: false }),
      payload: content.channelPayload,
      reason: input.reason,
      candidates: (input.candidates ?? []).slice(0, 5).map((c) => ({
        id: c.id,
        company: c.company,
        role: c.role,
        status: c.status,
      })),
      explanation: input.reason,
    },
  });

  if (result.created) {
    await enqueueNotification({ notificationId: result.notification.id });
  }

  await recordAudit({
    userId: input.userId,
    actor: "AI",
    action: AUDIT_ACTIONS.emailNeedsReview,
    entityType: "Email",
    entityId: input.emailId,
    summary: input.reason,
    metadata: { confidence: input.analysis.confidence, candidates: input.candidates?.length ?? 0 },
  });

  return result.notification.id;
}

/** Minimal settings shim mirroring the schema defaults when no row exists. */
function fallbackSettings() {
  return {
    notifyDashboard: true,
    notifySlack: false,
    notifyWhatsapp: false,
    notifyEmail: false,
    notifyVoice: false,
    notifyMinSeverity: "MEDIUM" as const,
    escalationEnabled: true,
    escalationDelaysMinutes: [30, 60, 120],
    escalationMaxStage: 2,
    voiceEnabled: false,
    voiceCriticalEvents: [],
    cleanupCategories: ["PROMOTIONAL", "SPAM", "NEWSLETTER"],
    autoCleanupEnabled: false,
  };
}

/** Wraps the whole stage so a queue retry records why it failed. */
export async function processApplicationFromEmailSafe(params: {
  userId: string;
  emailId: string;
  analysisId: string;
}): Promise<ProcessEmailOutcome | null> {
  try {
    return await processApplicationFromEmail(params);
  } catch (error) {
    logger.error({ emailId: params.emailId, ...describeError(error) }, "application processing failed");
    throw error;
  }
}
