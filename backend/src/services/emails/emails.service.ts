import type { EmailCategory, EmailProcessingState, JobSubCategory, Prisma, Priority } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../config/prisma";
import { buildPageMeta, type PageMeta } from "../../utils/http";
import { NotFoundError, ValidationError } from "../../utils/errors";
import { enqueueProcessEmail } from "../../queues";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import { applyEmailToApplication } from "../applications/application.service";

/**
 * Email read model and the user-override surface.
 *
 * All the "what the AI decided" endpoints live here, including the review queue
 * that handles low-confidence classifications and ambiguous application matches.
 * Overrides always record an audit entry and never silently rewrite history.
 */

export const emailFiltersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(["receivedAt", "priority", "confidence"]).default("receivedAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  category: z.enum(["JOB", "PROMOTIONAL", "SPAM", "NEWSLETTER", "SOCIAL", "PERSONAL", "TRANSACTIONAL", "OTHER"]).optional(),
  subCategory: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  processingState: z.string().optional(),
  tab: z.enum(["all", "important", "jobs", "promotional", "spam", "newsletters", "rejected", "needs_review"]).default("all"),
  applicationId: z.string().optional(),
  search: z.string().trim().max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type EmailFilters = z.infer<typeof emailFiltersSchema>;

const PRIORITY_RANK: Record<Priority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export async function listEmails(userId: string, filters: EmailFilters) {
  const where: Prisma.EmailWhereInput = { userId };

  // Tab presets mirror the product spec's filter chips.
  switch (filters.tab) {
    case "important":
      where.isImportant = true;
      break;
    case "jobs":
      where.analysis = { is: { category: "JOB" } };
      break;
    case "promotional":
      where.analysis = { is: { category: "PROMOTIONAL" } };
      break;
    case "spam":
      where.analysis = { is: { category: "SPAM" } };
      break;
    case "newsletters":
      where.analysis = { is: { category: "NEWSLETTER" } };
      break;
    case "rejected":
      where.analysis = { is: { subCategory: "REJECTION" } };
      break;
    case "needs_review":
      where.needsReview = true;
      break;
    default:
      break;
  }

  if (filters.category) where.analysis = { is: { ...((where.analysis as { is?: object })?.is ?? {}), category: filters.category as EmailCategory } };
  if (filters.subCategory) where.analysis = { is: { ...((where.analysis as { is?: object })?.is ?? {}), subCategory: filters.subCategory as JobSubCategory } };
  if (filters.priority) where.analysis = { is: { ...((where.analysis as { is?: object })?.is ?? {}), priority: filters.priority as Priority } };
  if (filters.processingState) where.processingState = filters.processingState as EmailProcessingState;
  if (filters.applicationId) where.applicationId = filters.applicationId;

  if (filters.from || filters.to) {
    where.receivedAt = {
      ...(filters.from ? { gte: new Date(filters.from) } : {}),
      ...(filters.to ? { lte: new Date(filters.to) } : {}),
    };
  }

  if (filters.search) {
    where.OR = [
      { subject: { contains: filters.search, mode: "insensitive" } },
      { fromEmail: { contains: filters.search, mode: "insensitive" } },
      { fromName: { contains: filters.search, mode: "insensitive" } },
      { snippet: { contains: filters.search, mode: "insensitive" } },
      { analysis: { is: { summary: { contains: filters.search, mode: "insensitive" } } } },
    ];
  }

  // Priority/confidence sorting happens on the joined analysis row, so we sort in
  // memory for those cases and paginate afterwards.
  const sortInMemory = filters.sortBy !== "receivedAt";

  const orderBy: Prisma.EmailOrderByWithRelationInput = sortInMemory
    ? { receivedAt: "desc" }
    : { receivedAt: filters.sortDir };

  const include = {
    analysis: true,
    application: { select: { id: true, company: true, role: true, status: true } },
    _count: { select: { cleanupActions: true } },
  } as const;

  if (!sortInMemory) {
    const [items, total] = await Promise.all([
      prisma.email.findMany({
        where,
        orderBy,
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        include,
      }),
      prisma.email.count({ where }),
    ]);
    return { items, page: buildPageMeta(filters.page, filters.pageSize, total) as PageMeta };
  }

  const [all, total] = await Promise.all([
    prisma.email.findMany({ where, orderBy, include }),
    prisma.email.count({ where }),
  ]);

  const direction = filters.sortDir === "asc" ? 1 : -1;
  all.sort((a, b) => {
    if (filters.sortBy === "priority") {
      const rankA = a.analysis ? PRIORITY_RANK[a.analysis.priority] : -1;
      const rankB = b.analysis ? PRIORITY_RANK[b.analysis.priority] : -1;
      return (rankA - rankB) * direction;
    }
    const confA = a.analysis?.confidence ?? -1;
    const confB = b.analysis?.confidence ?? -1;
    return (confA - confB) * direction;
  });

  const start = (filters.page - 1) * filters.pageSize;
  const items = all.slice(start, start + filters.pageSize);

  return { items, page: buildPageMeta(filters.page, filters.pageSize, total) as PageMeta };
}

export async function getEmailDetail(userId: string, emailId: string) {
  const email = await prisma.email.findFirst({
    where: { id: emailId, userId },
    include: {
      analysis: true,
      application: {
        select: { id: true, company: true, role: true, status: true, jobId: true, appliedDate: true, lastUpdated: true },
      },
      gmailAccount: { select: { id: true, emailAddress: true, status: true } },
      cleanupActions: { orderBy: { createdAt: "desc" }, take: 5 },
      notifications: { orderBy: { createdAt: "desc" }, take: 10, include: { attempts: true } },
      applicationEvents: { orderBy: { occurredAt: "desc" }, take: 10 },
    },
  });

  if (!email) throw new NotFoundError("Email");
  return email;
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

export async function getEmailCounters(userId: string): Promise<EmailCounters> {
  const [all, important, jobs, promotional, spam, newsletters, rejected, needsReview] = await Promise.all([
    prisma.email.count({ where: { userId } }),
    prisma.email.count({ where: { userId, isImportant: true } }),
    prisma.email.count({ where: { userId, analysis: { is: { category: "JOB" } } } }),
    prisma.email.count({ where: { userId, analysis: { is: { category: "PROMOTIONAL" } } } }),
    prisma.email.count({ where: { userId, analysis: { is: { category: "SPAM" } } } }),
    prisma.email.count({ where: { userId, analysis: { is: { category: "NEWSLETTER" } } } }),
    prisma.email.count({ where: { userId, analysis: { is: { subCategory: "REJECTION" } } } }),
    prisma.email.count({ where: { userId, needsReview: true } }),
  ]);

  return { all, important, jobs, promotional, spam, newsletters, rejected, needsReview };
}

/** -------------------------------------------------------------------------- */
/** User overrides                                                               */
/** -------------------------------------------------------------------------- */

export const analysisOverrideSchema = z
  .object({
    category: z.enum(["JOB", "PROMOTIONAL", "SPAM", "NEWSLETTER", "SOCIAL", "PERSONAL", "TRANSACTIONAL", "OTHER"]).optional(),
    subCategory: z
      .enum([
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
        "JOB_ALERT",
        "OTHER_JOB",
      ])
      .nullable()
      .optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    requiresAction: z.boolean().optional(),
    companyOverride: z.string().trim().max(160).nullable().optional(),
    roleOverride: z.string().trim().max(160).nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type AnalysisOverride = z.infer<typeof analysisOverrideSchema>;

/**
 * Records a user override of an AI decision. The AI's original output is kept —
 * the override is additive, so the audit trail still shows what the model said
 * and what the human decided (product rule #5: the user can always override).
 */
export async function overrideEmailAnalysis(userId: string, emailId: string, override: AnalysisOverride) {
  const email = await prisma.email.findFirst({ where: { id: emailId, userId }, include: { analysis: true } });
  if (!email) throw new NotFoundError("Email");

  const analysisData: Prisma.EmailAnalysisUpdateInput = {};
  if (override.category) analysisData.category = override.category;
  if (override.subCategory !== undefined) analysisData.subCategory = override.subCategory;
  if (override.priority) analysisData.priority = override.priority;
  if (override.requiresAction !== undefined) analysisData.requiresAction = override.requiresAction;
  analysisData.needsReview = false;
  analysisData.confidence = 1;

  const existingExtracted = (email.analysis?.extracted ?? {}) as Record<string, unknown>;
  const nextExtracted = {
    ...existingExtracted,
    ...(override.companyOverride !== undefined ? { company: override.companyOverride } : {}),
    ...(override.roleOverride !== undefined ? { role: override.roleOverride } : {}),
    _overriddenByUser: {
      at: new Date().toISOString(),
      note: override.note ?? null,
      previous: email.analysis
        ? { category: email.analysis.category, subCategory: email.analysis.subCategory, priority: email.analysis.priority }
        : null,
    },
  };
  analysisData.extracted = nextExtracted as Prisma.InputJsonValue;

  if (email.analysis) {
    await prisma.emailAnalysis.update({ where: { emailId }, data: analysisData });
  } else {
    await prisma.emailAnalysis.create({
      data: {
        emailId,
        userId,
        category: override.category ?? "OTHER",
        subCategory: override.subCategory ?? null,
        priority: override.priority ?? "MEDIUM",
        confidence: 1,
        requiresAction: override.requiresAction ?? false,
        needsReview: false,
        extracted: nextExtracted,
        model: "user-override",
        provider: "user",
        promptVersion: "user@1.0.0",
      },
    });
  }

  await prisma.email.update({ where: { id: emailId }, data: { needsReview: false } });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.applicationUpdatedByUser,
    entityType: "EmailAnalysis",
    entityId: emailId,
    summary: override.note ?? "Classification overridden by the user",
    metadata: { override, previous: email.analysis ? { category: email.analysis.category, subCategory: email.analysis.subCategory } : null },
  });

  return prisma.email.findUnique({ where: { id: emailId }, include: { analysis: true } });
}

export const reviewDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("LINK"), applicationId: z.string().min(1) }),
  z.object({ action: z.literal("CREATE") }),
  z.object({ action: z.literal("IGNORE"), note: z.string().max(300).optional() }),
  z.object({ action: z.literal("NOT_JOB") }),
]);

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/**
 * Resolves a review-queue item.
 *
 * This is the human-in-the-loop boundary the product requires: low-confidence AI
 * output never creates or mutates an application until the user either confirms a
 * link or asks MailOps to create the record.
 */
export async function resolveReviewDecision(userId: string, emailId: string, decision: ReviewDecision) {
  const email = await prisma.email.findFirst({
    where: { id: emailId, userId },
    include: { analysis: true, application: true },
  });
  if (!email) throw new NotFoundError("Email");
  if (!email.analysis) throw new ValidationError("This email has not been analysed yet");

  const extracted = (email.analysis.extracted ?? {}) as Record<string, string | null>;

  if (decision.action === "IGNORE") {
    await prisma.email.update({ where: { id: emailId }, data: { needsReview: false, processingState: "SKIPPED" } });
    await recordAudit({
      userId,
      actor: "USER",
      action: AUDIT_ACTIONS.emailReprocessed,
      entityType: "Email",
      entityId: emailId,
      summary: decision.note ?? "Review dismissed without action",
    });
    return { resolved: true, outcome: "IGNORED" as const };
  }

  if (decision.action === "NOT_JOB") {
    await prisma.emailAnalysis.update({
      where: { emailId },
      data: { category: "OTHER", subCategory: null, priority: "LOW", requiresAction: false, needsReview: false, confidence: 1 },
    });
    await prisma.email.update({ where: { id: emailId }, data: { needsReview: false, processingState: "PROCESSED", isImportant: false } });
    return { resolved: true, outcome: "RECLASSIFIED" as const };
  }

  const company = extracted.company ?? null;
  const role = extracted.role ?? null;

  if (!company || !role) {
    throw new ValidationError(
      "MailOps still cannot determine the company and role for this email. Edit the email analysis first, then confirm.",
    );
  }

  if (decision.action === "LINK") {
    const application = await prisma.application.findFirst({ where: { id: decision.applicationId, userId } });
    if (!application) throw new NotFoundError("Application");

    const result = await applyEmailToApplication({
      userId,
      emailId,
      applicationId: application.id,
      subCategory: email.analysis.subCategory,
      category: email.analysis.category,
      priority: email.analysis.priority,
      confidence: 1,
      requiresAction: email.analysis.requiresAction,
      summary: email.analysis.summary,
      occurredAt: email.receivedAt,
      extracted: extracted as unknown as Record<string, unknown>,
    });

    await prisma.email.update({ where: { id: emailId }, data: { needsReview: false, applicationId: application.id } });

    return { resolved: true, outcome: "LINKED" as const, applicationId: result.application.id, statusChanged: result.statusChanged };
  }

  // action === "CREATE"
  const { createApplication } = await import("../applications/application.service");
  const application = await createApplication(
    userId,
    {
      company,
      role,
      jobId: extracted.jobId ?? null,
      location: extracted.location ?? null,
      employmentType: extracted.employmentType ?? null,
      salary: extracted.salary ?? null,
      applicationUrl: extracted.applicationUrl ?? null,
      jobUrl: extracted.jobUrl ?? null,
      recruiterName: extracted.recruiterName ?? null,
      recruiterEmail: extracted.recruiterEmail ?? null,
      appliedDate: extracted.appliedDate ? new Date(extracted.appliedDate) : email.receivedAt,
      confidence: 1,
      source: "user-confirmed",
    },
    { emailId, occurredAt: email.receivedAt, actor: "USER" },
  );

  await applyEmailToApplication({
    userId,
    emailId,
    applicationId: application.id,
    subCategory: email.analysis.subCategory,
    category: email.analysis.category,
    priority: email.analysis.priority,
    confidence: 1,
    requiresAction: email.analysis.requiresAction,
    summary: email.analysis.summary,
    occurredAt: email.receivedAt,
    extracted: extracted as unknown as Record<string, unknown>,
  });

  await prisma.email.update({ where: { id: emailId }, data: { needsReview: false, applicationId: application.id } });

  return { resolved: true, outcome: "CREATED" as const, applicationId: application.id };
}

/** Re-runs the AI pipeline for an email (used after a provider outage). */
export async function reprocessEmail(userId: string, emailId: string): Promise<{ jobId: string | null }> {
  const email = await prisma.email.findFirst({ where: { id: emailId, userId } });
  if (!email) throw new NotFoundError("Email");

  await prisma.email.update({
    where: { id: emailId },
    data: { processingState: "QUEUED", processingError: null, needsReview: false },
  });

  const jobId = await enqueueProcessEmail({ emailId, userId, force: true }, { required: true });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.emailReprocessed,
    entityType: "Email",
    entityId: emailId,
    summary: "Reprocessing requested by the user",
  });

  return { jobId };
}

export async function listReviewQueue(userId: string, limit = 25) {
  return prisma.email.findMany({
    where: { userId, OR: [{ needsReview: true }, { processingState: "NEEDS_REVIEW" }, { processingState: "FAILED" }] },
    orderBy: { receivedAt: "desc" },
    take: limit,
    include: {
      analysis: true,
      application: { select: { id: true, company: true, role: true, status: true } },
    },
  });
}
