import type { EmailAnalysis, EmailCategory, JobSubCategory, UserSettings } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { describeError, NotFoundError } from "../../utils/errors";
import { isProtectedSender } from "./heuristics/signals";
import { classifyEmail } from "./classifier";
import { extractEmail } from "./extractor";
import { summarizeEmail } from "./summarizer";
import type { ExtractorOutput } from "./schemas";
import { decide, type Decision } from "../decisions/decision.engine";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";

/**
 * Email analysis orchestrator — the "understand" step of the agent loop.
 *
 *   OBSERVE -> UNDERSTAND -> REMEMBER -> DECIDE -> ACT -> INFORM
 *
 * This service performs steps 2 and 4 (understand + decide) and persists the
 * structured result. It has no side effects beyond the analysis rows: creating
 * applications, notifying and cleaning up are separate, separately retryable
 * stages. That separation is what lets the pipeline resume after a partial
 * failure instead of reprocessing everything.
 */

export interface AnalysisOutcome {
  emailId: string;
  analysisId: string | null;
  skipped: boolean;
  category: EmailCategory | null;
  subCategory: JobSubCategory | null;
  priority: string | null;
  confidence: number | null;
  requiresAction: boolean;
  needsReview: boolean;
  summary: string | null;
  extraction: ExtractorOutput | null;
  decision: Decision | null;
  warnings: string[];
}

export interface AnalyzeOptions {
  force?: boolean;
}

export async function analyzeEmail(emailId: string, options: AnalyzeOptions = {}): Promise<AnalysisOutcome> {
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: { user: { include: { settings: true } }, analysis: true },
  });

  if (!email) throw new NotFoundError("Email");

  // Idempotency: a processed email is never re-analysed unless explicitly forced
  // (or unless a previous attempt failed / was queued for review and the user
  // asked for another pass).
  if (email.processingState === "PROCESSED" && email.analysis && !options.force) {
    return {
      emailId: email.id,
      analysisId: email.analysis.id,
      skipped: true,
      category: email.analysis.category,
      subCategory: email.analysis.subCategory,
      priority: email.analysis.priority,
      confidence: email.analysis.confidence,
      requiresAction: email.analysis.requiresAction,
      needsReview: email.analysis.needsReview,
      summary: email.analysis.summary,
      extraction: email.analysis.extracted as unknown as ExtractorOutput,
      decision: null,
      warnings: [],
    };
  }

  const settings = email.user.settings;
  await prisma.email.update({
    where: { id: email.id },
    data: { processingState: "PROCESSING", attempts: { increment: 1 }, processingError: null },
  });

  const warnings: string[] = [];

  try {
    const receivedAt = email.receivedAt.toISOString();

    // ---- 1. Classify -------------------------------------------------------
    const classification = await classifyEmail({
      subject: email.subject,
      fromEmail: email.fromEmail,
      fromName: email.fromName,
      body: email.bodyText,
      labels: email.labels,
      isImportant: email.isImportant,
      receivedAt,
    });
    warnings.push(...classification.meta.warnings);

    const isJob = classification.output.category === "JOB";

    // ---- 2. Extract (recruitment mail only) --------------------------------
    let extraction: ExtractorOutput | null = null;
    if (isJob) {
      const hints = await loadCompanyHints(email.userId);
      const extracted = await extractEmail({
        subject: email.subject,
        fromEmail: email.fromEmail,
        fromName: email.fromName,
        body: email.bodyText,
        receivedAt,
        companyHints: hints,
      });
      extraction = extracted.output;
      warnings.push(...extracted.meta.warnings);
    }

    // ---- 3. Summarize ------------------------------------------------------
    const summaryResult = await summarizeEmail({
      subject: email.subject,
      fromEmail: email.fromEmail,
      fromName: email.fromName,
      body: email.bodyText,
      receivedAt,
    });
    warnings.push(...summaryResult.meta.warnings);

    // ---- 4. Decide ---------------------------------------------------------
    const deadlineAt = pickDeadline(extraction);
    const needsReview = classification.needsReview || Boolean(extraction?.needsReview);

    const decision = decide({
      category: classification.output.category,
      subCategory: classification.output.subCategory,
      priority: classification.output.priority,
      confidence: classification.output.confidence,
      requiresAction: classification.output.requiresAction,
      needsReview,
      isUnwanted: classification.output.isUnwanted,
      hasApplication: Boolean(email.applicationId),
      deadlineAt,
      isProtectedSender: isProtectedSender(email.fromEmail),
      settings: settings ?? defaultSettingsShim(),
    });

    // ---- 5. Persist --------------------------------------------------------
    const analysis = await persistAnalysis({
      emailId: email.id,
      userId: email.userId,
      classification,
      extraction,
      summary: summaryResult.output.summary,
      needsReview,
      decision,
    });

    const nextState = needsReview ? "NEEDS_REVIEW" : "PROCESSED";
    await prisma.email.update({
      where: { id: email.id },
      data: {
        processingState: nextState,
        processedAt: new Date(),
        needsReview,
        isImportant: decision.isImportant,
        processingError: null,
      },
    });

    await recordAudit({
      userId: email.userId,
      actor: "AI",
      action: needsReview ? AUDIT_ACTIONS.emailNeedsReview : AUDIT_ACTIONS.emailClassified,
      entityType: "Email",
      entityId: email.id,
      summary: `${classification.output.category}${
        classification.output.subCategory ? ` / ${classification.output.subCategory}` : ""
      } at ${(classification.output.confidence * 100).toFixed(0)}% confidence`,
      metadata: {
        category: classification.output.category,
        subCategory: classification.output.subCategory,
        priority: classification.output.priority,
        confidence: classification.output.confidence,
        provider: classification.meta.provider,
        model: classification.meta.model,
        promptVersion: classification.meta.promptVersion,
        decision: {
          severity: decision.severity,
          shouldNotify: decision.shouldNotify,
          requiresAck: decision.requiresAck,
          voiceEligible: decision.voiceEligible,
        },
      },
    });

    return {
      emailId: email.id,
      analysisId: analysis.id,
      skipped: false,
      category: classification.output.category,
      subCategory: classification.output.subCategory,
      priority: classification.output.priority,
      confidence: classification.output.confidence,
      requiresAction: classification.output.requiresAction,
      needsReview,
      summary: summaryResult.output.summary,
      extraction,
      decision,
      warnings,
    };
  } catch (error) {
    const message = describeError(error).message;
    await prisma.email.update({
      where: { id: email.id },
      data: { processingState: "FAILED", processingError: message.slice(0, 500) },
    });
    logger.error({ emailId: email.id, ...describeError(error) }, "email analysis failed");
    throw error;
  }
}

interface PersistInput {
  emailId: string;
  userId: string;
  classification: Awaited<ReturnType<typeof classifyEmail>>;
  extraction: ExtractorOutput | null;
  summary: string | null;
  needsReview: boolean;
  decision: Decision;
}

async function persistAnalysis(input: PersistInput): Promise<EmailAnalysis> {
  const { classification } = input;
  const extractedPayload = {
    ...(input.extraction ?? {}),
    /** Decision-engine output is attached so the Email detail view can explain
     * why MailOps chose to notify (or not) without re-running the engine. */
    _decision: {
      severity: input.decision.severity,
      isImportant: input.decision.isImportant,
      shouldNotify: input.decision.shouldNotify,
      requiresAck: input.decision.requiresAck,
      channels: input.decision.channels,
      escalation: input.decision.escalation,
      voiceEligible: input.decision.voiceEligible,
      voiceSuppressionReason: input.decision.voiceSuppressionReason,
      cleanupCandidate: input.decision.cleanupCandidate,
      explanation: input.decision.explanation,
    },
  };

  const data = {
    userId: input.userId,
    category: classification.output.category,
    subCategory: classification.output.subCategory,
    priority: classification.output.priority as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    confidence: classification.output.confidence,
    requiresAction: classification.output.requiresAction,
    needsReview: input.needsReview,
    reasoning: classification.output.reasoning,
    summary: input.summary,
    extracted: extractedPayload as object,
    isUnwanted: input.decision.cleanupCandidate || classification.output.isUnwanted,
    unwantedReason: input.decision.cleanupReason ?? classification.output.unwantedReason,
    model: classification.meta.model,
    provider: classification.meta.provider,
    promptVersion: classification.meta.promptVersion,
    latencyMs: classification.meta.latencyMs,
    tokenUsage: (classification.meta.usage ?? {}) as object,
  };

  return prisma.emailAnalysis.upsert({
    where: { emailId: input.emailId },
    create: { emailId: input.emailId, ...data },
    update: data,
  });
}

/**
 * The earliest deadline the extractor actually found. Never synthesised — if the
 * email did not state a date, this returns null.
 */
export function pickDeadline(extraction: ExtractorOutput | null): Date | null {
  if (!extraction) return null;
  const candidates = [extraction.assessmentDeadline, extraction.responseDeadline, extraction.interviewDate]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()));

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0];
}

/** Company names the user already has applications with — used to ground extraction. */
async function loadCompanyHints(userId: string, limit = 30): Promise<string[]> {
  const rows = await prisma.application.findMany({
    where: { userId },
    select: { company: true },
    orderBy: { lastUpdated: "desc" },
    take: limit,
  });
  return Array.from(new Set(rows.map((r) => r.company))).slice(0, limit);
}

/**
 * Type-safe default when a user row has no settings yet (settings are created at
 * registration, but the pipeline must not crash if one is missing).
 */
function defaultSettingsShim(): UserSettings {
  return {
    id: "default",
    userId: "",
    scanIntervalMinutes: 210,
    scanningEnabled: true,
    notifyDashboard: true,
    notifySlack: false,
    notifyWhatsapp: false,
    notifyEmail: false,
    notifyVoice: false,
    notifyMinSeverity: "MEDIUM",
    escalationDelaysMinutes: [30, 60, 120],
    escalationEnabled: true,
    escalationMaxStage: 2,
    voiceEnabled: false,
    voiceMaxCallsPerDay: 2,
    voiceQuietHoursStart: 22,
    voiceQuietHoursEnd: 7,
    voiceCriticalEvents: ["OFFER", "INTERVIEW", "ASSESSMENT", "RECRUITER_ACTION"],
    voiceCallsToday: 0,
    voiceCallsResetAt: null,
    autoCleanupEnabled: false,
    cleanupCategories: ["PROMOTIONAL", "SPAM", "NEWSLETTER"],
    protectJobEmails: true,
    protectPersonal: true,
    protectFinancial: true,
    protectGovernment: true,
    storeEmailBody: true,
    dataRetentionDays: 365,
    redactSensitiveLogs: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
