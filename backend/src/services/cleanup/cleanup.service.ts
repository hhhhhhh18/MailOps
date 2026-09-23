import type { CleanupAction, CleanupActionType, EmailCategory, Prisma, UserSettings } from "@prisma/client";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { CLEANUP_CATEGORIES, NEVER_CLEANUP_CATEGORIES } from "../../config/constants";
import { buildPageMeta, type PageMeta } from "../../utils/http";
import { describeError, NotFoundError, ProtectedResourceError, ValidationError } from "../../utils/errors";
import { sanitizeForAudit } from "../../utils/redact";
import { isProtectedSender } from "../ai/heuristics/signals";
import { GmailClient } from "../gmail/client";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";

/**
 * Inbox cleanup.
 *
 * Two absolute rules drive this module:
 *   1. MailOps never deletes anything silently. Every destructive action is
 *      preceded by an explicit, itemised user approval.
 *   2. Protection is enforced server-side at execution time, not just filtered in
 *      the UI. Even if a malicious or buggy client asks MailOps to delete a
 *      recruiter email, the executor refuses.
 */

const MLOPS_IGNORED_LABEL = "mailops-ignored";

export interface CleanupCandidateInput {
  userId: string;
  emailId: string;
  category: EmailCategory;
  subCategory?: string | null;
  isUnwanted: boolean;
  reason?: string | null;
  fromEmail?: string | null;
  applicationId?: string | null;
  labels?: string[];
}

export interface ProtectionCheck {
  protected: boolean;
  reason: string | null;
}

/**
 * The single source of truth for "may MailOps touch this message?".
 * Returns a human-readable reason when the message is protected.
 */
export function checkProtection(
  input: {
    category: EmailCategory;
    subCategory?: string | null;
    fromEmail?: string | null;
    applicationId?: string | null;
    labels?: string[];
  },
  settings: Pick<
    UserSettings,
    "protectJobEmails" | "protectPersonal" | "protectFinancial" | "protectGovernment" | "autoCleanupEnabled"
  > | null,
): ProtectionCheck {
  const protective = {
    job: settings?.protectJobEmails ?? true,
    personal: settings?.protectPersonal ?? true,
    financial: settings?.protectFinancial ?? true,
    government: settings?.protectGovernment ?? true,
  };

  // 1. Recruitment mail is never cleanup material, under any setting.
  if (input.category === "JOB") {
    return { protected: true, reason: "Job and recruitment emails are never deleted automatically." };
  }

  // 2. An email linked to an application is evidence for that application.
  if (input.applicationId) {
    return { protected: true, reason: "This email is linked to an application and is kept as supporting evidence." };
  }

  // 3. Categories that MailOps refuses to consider at all.
  if (NEVER_CLEANUP_CATEGORIES.includes(input.category)) {
    if (input.category === "PERSONAL" && protective.personal) {
      return { protected: true, reason: "Personal correspondence is protected." };
    }
    if (input.category === "TRANSACTIONAL" && (protective.financial || protective.government)) {
      return { protected: true, reason: "Financial, tax and government mail is protected." };
    }
    return { protected: true, reason: "This category is excluded from cleanup." };
  }

  // 4. Financial / government / bank senders, regardless of classification.
  if (isProtectedSender(input.fromEmail)) {
    return { protected: true, reason: "The sender looks like a bank, tax or government body." };
  }

  // 5. Gmail's own signals: starred or explicitly important mail stays.
  if (input.labels?.includes("STARRED")) {
    return { protected: true, reason: "You starred this message in Gmail." };
  }
  if (input.labels?.includes("IMPORTANT")) {
    return { protected: true, reason: "Gmail marked this message as important." };
  }

  return { protected: false, reason: null };
}

/** Records a cleanup proposal for one analysed email (never executes anything). */
export async function proposeCleanupForEmail(
  userId: string,
  emailId: string,
  analysis: { category: EmailCategory; subCategory: string | null; isUnwanted: boolean; unwantedReason: string | null },
  options: { fromEmail?: string | null; applicationId?: string | null; labels?: string[]; batchId?: string } = {},
): Promise<CleanupAction | null> {
  const settings = await prisma.userSettings.findUnique({ where: { userId } });

  const eligible =
    (analysis.isUnwanted || CLEANUP_CATEGORIES.includes(analysis.category)) &&
    (settings?.cleanupCategories ?? ["PROMOTIONAL", "SPAM", "NEWSLETTER"]).includes(analysis.category) &&
    !NEVER_CLEANUP_CATEGORIES.includes(analysis.category);

  if (!eligible) return null;

  const protection = checkProtection(
    {
      category: analysis.category,
      subCategory: analysis.subCategory,
      fromEmail: options.fromEmail,
      applicationId: options.applicationId,
      labels: options.labels,
    },
    settings,
  );

  const existing = await prisma.cleanupAction.findFirst({
    where: { userId, emailId, status: { in: ["PROPOSED", "APPROVED"] } },
  });
  if (existing) return existing;

  const action = await prisma.cleanupAction.create({
    data: {
      userId,
      emailId,
      applicationId: options.applicationId ?? null,
      type: inferCleanupType(analysis.category),
      status: protection.protected ? "BLOCKED" : "PROPOSED",
      reason: analysis.unwantedReason ?? settings?.cleanupCategories ? `Classified as ${analysis.category.toLowerCase()}` : null,
      category: analysis.category,
      batchId: options.batchId ?? new Date().toISOString().slice(0, 10),
      senderEmail: options.fromEmail ?? null,
      protectedReason: protection.reason,
    },
  });

  if (protection.protected) {
    await recordAudit({
      userId,
      actor: "AI",
      action: AUDIT_ACTIONS.cleanupBlocked,
      entityType: "CleanupAction",
      entityId: action.id,
      summary: protection.reason ?? "Blocked by a protection rule",
      metadata: { emailId, category: analysis.category },
    });
  }

  return action;
}

function inferCleanupType(category: EmailCategory): CleanupActionType {
  if (category === "SPAM") return "DELETE";
  if (category === "PROMOTIONAL") return "ARCHIVE";
  return "ARCHIVE";
}

export interface CleanupSummary {
  totalProposed: number;
  byCategory: Record<string, number>;
  bySender: Array<{ sender: string | null; count: number }>;
  protectedCount: number;
  executedCount: number;
  lastProposalAt: Date | null;
  autoCleanupEnabled: boolean;
}

export async function getCleanupSummary(userId: string): Promise<CleanupSummary> {
  const [proposed, grouped, senders, protectedCount, executed, last, settings] = await Promise.all([
    prisma.cleanupAction.count({ where: { userId, status: "PROPOSED" } }),
    prisma.cleanupAction.groupBy({
      by: ["category"],
      where: { userId, status: { in: ["PROPOSED", "APPROVED"] } },
      _count: { _all: true },
    }),
    prisma.cleanupAction.groupBy({
      by: ["senderEmail"],
      where: { userId, status: "PROPOSED" },
      _count: { _all: true },
      orderBy: { _count: { senderEmail: "desc" } },
      take: 10,
    }),
    prisma.cleanupAction.count({ where: { userId, status: "BLOCKED" } }),
    prisma.cleanupAction.count({ where: { userId, status: "EXECUTED" } }),
    prisma.cleanupAction.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.userSettings.findUnique({ where: { userId } }),
  ]);

  const byCategory: Record<string, number> = {};
  for (const row of grouped) if (row.category) byCategory[row.category] = row._count._all;

  return {
    totalProposed: proposed,
    byCategory,
    bySender: senders.map((s) => ({ sender: s.senderEmail, count: s._count._all })),
    protectedCount,
    executedCount: executed,
    lastProposalAt: last?.createdAt ?? null,
    autoCleanupEnabled: settings?.autoCleanupEnabled ?? false,
  };
}

export interface CleanupListFilters {
  page: number;
  pageSize: number;
  status?: string;
  category?: EmailCategory;
  batchId?: string;
  sender?: string;
}

export async function listCleanupProposals(userId: string, filters: CleanupListFilters) {
  const where: Prisma.CleanupActionWhereInput = {
    userId,
    ...(filters.status ? { status: filters.status as Prisma.EnumCleanupActionStatusFilter["equals"] } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.batchId ? { batchId: filters.batchId } : {}),
    ...(filters.sender ? { senderEmail: { contains: filters.sender, mode: "insensitive" } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.cleanupAction.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: {
        email: {
          select: {
            id: true,
            subject: true,
            fromName: true,
            fromEmail: true,
            receivedAt: true,
            snippet: true,
            deletedFromGmail: true,
            analysis: { select: { category: true, confidence: true, summary: true, reasoning: true } },
          },
        },
      },
    }),
    prisma.cleanupAction.count({ where }),
  ]);

  return { items, page: buildPageMeta(filters.page, filters.pageSize, total) as PageMeta };
}

export interface ApproveCleanupInput {
  userId: string;
  emailIds: string[];
  action: Extract<CleanupActionType, "DELETE" | "ARCHIVE" | "KEEP" | "IGNORE_SENDER">;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CleanupExecutionResult {
  batchId: string;
  requested: number;
  executed: number;
  blocked: Array<{ emailId: string; reason: string }>;
  failed: Array<{ emailId: string; error: string }>;
  skipped: number;
}

/**
 * Executes a user-approved cleanup batch.
 *
 * Every item is re-validated against the protection rules immediately before the
 * Gmail call. Approval is per batch and is not standing permission: the user must
 * approve again for a new batch.
 */
export async function executeCleanupBatch(input: ApproveCleanupInput): Promise<CleanupExecutionResult> {
  if (!input.emailIds.length) throw new ValidationError("Select at least one email to clean up");
  if (input.emailIds.length > 500) throw new ValidationError("Cleanup batches are limited to 500 emails at a time");

  const batchId = `batch_${Date.now().toString(36)}`;
  const settings = await prisma.userSettings.findUnique({ where: { userId: input.userId } });

  const emails = await prisma.email.findMany({
    where: { id: { in: input.emailIds }, userId: input.userId },
    include: { analysis: true },
  });

  const blocked: Array<{ emailId: string; reason: string }> = [];
  const failed: Array<{ emailId: string; error: string }> = [];
  const actionable: typeof emails = [];

  for (const email of emails) {
    const protection = checkProtection(
      {
        category: email.analysis?.category ?? "OTHER",
        subCategory: email.analysis?.subCategory ?? null,
        fromEmail: email.fromEmail,
        applicationId: email.applicationId,
        labels: email.labels,
      },
      settings,
    );

    if (protection.protected) {
      blocked.push({ emailId: email.id, reason: protection.reason ?? "Protected by policy" });
      await upsertBlockedAction(input.userId, email.id, email.analysis?.category ?? null, protection.reason, batchId);
      await recordAudit({
        userId: input.userId,
        actor: "SYSTEM",
        action: AUDIT_ACTIONS.cleanupBlocked,
        entityType: "Email",
        entityId: email.id,
        summary: protection.reason ?? "Blocked by protection rule",
        metadata: { batchId, requestedAction: input.action },
      });
    } else {
      actionable.push(email);
    }
  }

  const missing = input.emailIds.filter((id) => !emails.some((e) => e.id === id));

  // "Keep" is a no-op that clears the proposal — no Gmail call, no risk.
  if (input.action === "KEEP") {
    await prisma.cleanupAction.updateMany({
      where: { userId: input.userId, emailId: { in: actionable.map((e) => e.id) }, status: "PROPOSED" },
      data: { status: "SKIPPED", approvedAt: new Date(), batchId, reason: "Kept by user" },
    });

    await prisma.cleanupAction.updateMany({
      where: { userId: input.userId, emailId: { in: actionable.map((e) => e.id) } },
      data: { status: "SKIPPED", approvedAt: new Date(), batchId },
    });

    await recordAudit({
      userId: input.userId,
      actor: "USER",
      action: AUDIT_ACTIONS.cleanupApproved,
      entityType: "CleanupAction",
      entityId: batchId,
      summary: `Kept ${actionable.length} email(s)`,
      metadata: { batchId, count: actionable.length },
    });

    return { batchId, requested: input.emailIds.length, executed: 0, blocked, failed, skipped: actionable.length + missing.length };
  }

  // Resolve the Gmail account for the actual mutation.
  const account = await prisma.gmailAccount.findFirst({
    where: { userId: input.userId, status: { in: ["CONNECTED", "ERROR"] } },
    orderBy: { createdAt: "desc" },
  });

  if (!account) {
    for (const email of actionable) {
      failed.push({ emailId: email.id, error: "No connected Gmail account to apply this action to" });
      await upsertAction(input.userId, email.id, input.action, "FAILED", batchId, "No connected Gmail account");
    }
    return {
      batchId,
      requested: input.emailIds.length,
      executed: 0,
      blocked,
      failed,
      skipped: missing.length,
    };
  }

  let client: GmailClient | null = null;
  try {
    client = await GmailClient.forAccount(account);
  } catch (error) {
    const message = describeError(error).message;
    for (const email of actionable) {
      failed.push({ emailId: email.id, error: message });
      await upsertAction(input.userId, email.id, input.action, "FAILED", batchId, message);
    }
    await recordAudit({
      userId: input.userId,
      actor: "SYSTEM",
      action: AUDIT_ACTIONS.cleanupFailed,
      entityType: "CleanupAction",
      entityId: batchId,
      summary: "Could not authenticate with Gmail",
      metadata: { error: message },
    });
    return { batchId, requested: input.emailIds.length, executed: 0, blocked, failed, skipped: missing.length };
  }

  let executed = 0;

  for (const email of actionable) {
    try {
      if (input.action === "ARCHIVE") {
        await client.archiveMessage(email.gmailMessageId);
      } else if (input.action === "DELETE") {
        // Trash, not permanent delete — recoverable for 30 days in Gmail.
        await client.trashMessage(email.gmailMessageId);
      } else if (input.action === "IGNORE_SENDER") {
        // Label rather than delete: future mail from this sender is recognised
        // and skipped by the scanner's query (-label:mailops-ignored).
        await client.addLabel(email.gmailMessageId, MLOPS_IGNORED_LABEL);
        await prisma.email.update({ where: { id: email.id }, data: { processingState: "SKIPPED" } });
      }

      if (input.action === "DELETE") {
        await prisma.email.update({
          where: { id: email.id },
          data: { deletedFromGmail: true, deletedFromMailops: new Date() },
        });
      }

      await upsertAction(input.userId, email.id, input.action, "EXECUTED", batchId, null);
      executed += 1;

      await recordAudit({
        userId: input.userId,
        actor: "USER",
        action: AUDIT_ACTIONS.cleanupExecuted,
        entityType: "Email",
        entityId: email.id,
        summary: `${input.action} applied to "${(email.subject ?? "(no subject)").slice(0, 80)}"`,
        metadata: {
          batchId,
          action: input.action,
          sender: email.fromEmail,
          category: email.analysis?.category,
          gmailMessageId: email.gmailMessageId,
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
    } catch (error) {
      const message = describeError(error).message;
      failed.push({ emailId: email.id, error: message });
      await upsertAction(input.userId, email.id, input.action, "FAILED", batchId, message);
      await recordAudit({
        userId: input.userId,
        actor: "SYSTEM",
        action: AUDIT_ACTIONS.cleanupFailed,
        entityType: "Email",
        entityId: email.id,
        summary: message,
        metadata: { batchId, action: input.action },
      });
    }
  }

  await recordAudit({
    userId: input.userId,
    actor: "USER",
    action: AUDIT_ACTIONS.cleanupApproved,
    entityType: "CleanupAction",
    entityId: batchId,
    summary: `Approved ${input.action} for ${input.emailIds.length} email(s): ${executed} executed, ${blocked.length} blocked`,
    metadata: { batchId, action: input.action, executed, blocked: blocked.length, failed: failed.length },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  logger.info({ userId: input.userId, batchId, action: input.action, executed, blocked: blocked.length }, "cleanup batch executed");

  return { batchId, requested: input.emailIds.length, executed, blocked, failed, skipped: missing.length };
}

async function upsertAction(
  userId: string,
  emailId: string,
  type: CleanupActionType,
  status: "EXECUTED" | "FAILED" | "BLOCKED" | "SKIPPED",
  batchId: string,
  error: string | null,
): Promise<void> {
  const existing = await prisma.cleanupAction.findFirst({ where: { userId, emailId }, orderBy: { createdAt: "desc" } });

  const data = {
    type,
    status,
    batchId,
    approvedAt: new Date(),
    executedAt: status === "EXECUTED" ? new Date() : null,
    error: error ? error.slice(0, 500) : null,
    audit: sanitizeForAudit({ status, batchId, error }) as Prisma.InputJsonValue,
  };

  if (existing) {
    await prisma.cleanupAction.update({ where: { id: existing.id }, data });
  } else {
    await prisma.cleanupAction.create({ data: { userId, emailId, ...data } });
  }
}

async function upsertBlockedAction(
  userId: string,
  emailId: string,
  category: EmailCategory | null,
  reason: string | null,
  batchId: string,
): Promise<void> {
  const existing = await prisma.cleanupAction.findFirst({ where: { userId, emailId }, orderBy: { createdAt: "desc" } });
  const data = {
    status: "BLOCKED" as const,
    protectedReason: reason,
    category,
    batchId,
  };
  if (existing) await prisma.cleanupAction.update({ where: { id: existing.id }, data });
  else await prisma.cleanupAction.create({ data: { userId, emailId, type: "KEEP", ...data } });
}

/**
 * Undeletes a trashed message (Gmail keeps trashed mail for 30 days) and marks
 * the audit record reverted. Archive actions are reversed by restoring INBOX.
 */
export async function revertCleanupAction(userId: string, cleanupActionId: string): Promise<{ reverted: boolean }> {
  const action = await prisma.cleanupAction.findFirst({
    where: { id: cleanupActionId, userId },
    include: { email: true },
  });
  if (!action) throw new NotFoundError("Cleanup action");
  if (action.status !== "EXECUTED") {
    throw new ValidationError("Only executed cleanup actions can be reverted");
  }
  if (!action.email) {
    throw new ProtectedResourceError("The underlying email record is no longer available, so this cannot be reverted.");
  }

  const account = await prisma.gmailAccount.findFirst({ where: { userId, status: "CONNECTED" } });
  if (!account) {
    throw new ProtectedResourceError("Connect Gmail to revert this action.");
  }

  const client = await GmailClient.forAccount(account);

  if (action.type === "DELETE") {
    // Gmail exposes untrash through the trash endpoint, which is not part of the
    // minimal scope set if the message is already purged; surface the failure.
    await client.addLabel(action.email.gmailMessageId, "INBOX");
    await prisma.email.update({
      where: { id: action.email.id },
      data: { deletedFromGmail: false, deletedFromMailops: null },
    });
  } else if (action.type === "ARCHIVE") {
    await client.addLabel(action.email.gmailMessageId, "INBOX");
  } else {
    throw new ValidationError(`A ${action.type} action cannot be reverted`);
  }

  await prisma.cleanupAction.update({
    where: { id: action.id },
    data: { status: "REVERTED", error: null },
  });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.cleanupExecuted,
    entityType: "CleanupAction",
    entityId: action.id,
    summary: `Reverted ${action.type} for "${(action.email.subject ?? "(no subject)").slice(0, 80)}"`,
    metadata: { reverted: true },
  });

  return { reverted: true };
}

/** -------------------------------------------------------------------------- */
/** Retention                                                                    */
/** -------------------------------------------------------------------------- */

/**
 * Enforces the retention policy.
 *
 * Critically, this removes *email content*, not application history: Application
 * and ApplicationEvent rows (and their audit trail) are preserved indefinitely.
 * Deleting email from Gmail therefore cannot erase the user's career timeline.
 */
export async function runRetentionSweep(userId?: string): Promise<{ emailsPurged: number; bodiesTrimmed: number }> {
  const now = new Date();
  let emailsPurged = 0;
  let bodiesTrimmed = 0;

  const users = userId
    ? await prisma.userSettings.findMany({ where: { userId } })
    : await prisma.userSettings.findMany();

  for (const settings of users) {
    const cutoff = new Date(now.getTime() - Math.max(1, settings.dataRetentionDays) * 86_400_000);

    // 1. Trim bodies that exceeded the retention window but keep the row so the
    //    timeline keeps its link.
    const trimmed = await prisma.email.updateMany({
      where: {
        userId: settings.userId,
        receivedAt: { lt: cutoff },
        bodyText: { not: null },
      },
      data: { bodyText: null },
    });
    bodiesTrimmed += trimmed.count;

    // 2. Purge email rows that are past retention and are not linked to an
    //    application. Linked emails are retained because they are evidence.
    const purgeable = await prisma.email.findMany({
      where: {
        userId: settings.userId,
        receivedAt: { lt: cutoff },
        applicationId: null,
        processingState: { in: ["PROCESSED", "SKIPPED", "FAILED"] },
      },
      select: { id: true },
      take: 1000,
    });

    if (purgeable.length) {
      const ids = purgeable.map((e) => e.id);
      await prisma.$transaction([
        prisma.cleanupAction.updateMany({ where: { emailId: { in: ids } }, data: { emailId: null } }),
        prisma.applicationEvent.updateMany({ where: { emailId: { in: ids } }, data: { emailId: null } }),
        prisma.email.deleteMany({ where: { id: { in: ids } } }),
      ]);
      emailsPurged += ids.length;

      await recordAudit({
        userId: settings.userId,
        actor: "SYSTEM",
        action: AUDIT_ACTIONS.retentionSweep,
        entityType: "Email",
        entityId: null,
        summary: `Purged ${ids.length} email(s) older than ${settings.dataRetentionDays} days`,
        metadata: { retentionDays: settings.dataRetentionDays, purged: ids.length, trimmedBodies: trimmed.count },
      });
    }
  }

  return { emailsPurged, bodiesTrimmed };
}

/**
 * "Delete my MailOps data" — the user-facing destructive flow.
 * Optionally preserves the structured application history, which is the whole
 * point of the product (product rule #9).
 */
export async function purgeUserEmailData(
  userId: string,
  options: { keepApplicationHistory: boolean },
): Promise<{ emailsDeleted: number; applicationsDeleted: number; notes: string[] }> {
  const notes: string[] = [];
  const emails = await prisma.email.count({ where: { userId } });

  await prisma.$transaction(async (tx) => {
    // Detach email references from history so nothing dangles.
    await tx.applicationEvent.updateMany({ where: { userId }, data: { emailId: null } });
    await tx.notification.updateMany({ where: { userId }, data: { emailId: null } });
    await tx.cleanupAction.updateMany({ where: { userId }, data: { emailId: null } });
    await tx.emailAnalysis.deleteMany({ where: { userId } });
    await tx.email.deleteMany({ where: { userId } });
    await tx.scanJob.deleteMany({ where: { userId } });
  });

  notes.push(`${emails} stored email(s) and their analyses were deleted.`);

  let applicationsDeleted = 0;
  if (!options.keepApplicationHistory) {
    const applications = await prisma.application.count({ where: { userId } });
    await prisma.$transaction([
      prisma.notification.updateMany({ where: { userId }, data: { applicationId: null } }),
      prisma.application.deleteMany({ where: { userId } }),
    ]);
    applicationsDeleted = applications;
    notes.push(`${applications} application record(s) and their timelines were deleted.`);
  } else {
    notes.push("Application history and timelines were preserved, as requested.");
  }

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.dataPurged,
    entityType: "User",
    entityId: userId,
    summary: "User deleted MailOps-stored email data",
    metadata: { keepApplicationHistory: options.keepApplicationHistory, emailsDeleted: emails, applicationsDeleted },
  });

  return { emailsDeleted: emails, applicationsDeleted, notes };
}
