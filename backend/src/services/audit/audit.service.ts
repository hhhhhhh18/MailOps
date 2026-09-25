import type { AuditActor, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { sanitizeForAudit } from "../../utils/redact";
import { buildPageMeta, type PageMeta } from "../../utils/http";

/**
 * Audit trail (product rule #10: every automated action should be traceable).
 *
 * Audit records are append-only and are never deleted when the related email is
 * deleted — the whole point is that the user can see what MailOps did even after
 * the underlying Gmail message is gone.
 */

export interface AuditInput {
  userId: string;
  actor: AuditActor;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string | null;
  metadata?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId,
        actor: input.actor,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        summary: input.summary ? sanitizeForAudit(input.summary) as string : null,
        metadata: (sanitizeForAudit(input.metadata ?? {}) ?? {}) as Prisma.InputJsonValue,
        ip: input.ip ?? null,
        userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
      },
    });
  } catch (error) {
    // An audit failure must never break the action it is describing, but it must
    // be visible to operators.
    logger.error({ action: input.action, err: (error as Error).message }, "failed to write audit log");
  }
}

export interface AuditListOptions {
  page: number;
  pageSize: number;
  action?: string;
  actor?: AuditActor;
  entityType?: string;
  from?: Date;
  to?: Date;
}

export async function listAuditLogs(
  userId: string,
  options: AuditListOptions,
): Promise<{ items: Prisma.AuditLogGetPayload<object>[]; page: PageMeta }> {
  const where: Prisma.AuditLogWhereInput = {
    userId,
    ...(options.action ? { action: { contains: options.action, mode: "insensitive" } } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.entityType ? { entityType: options.entityType } : {}),
    ...(options.from || options.to
      ? {
          createdAt: {
            ...(options.from ? { gte: options.from } : {}),
            ...(options.to ? { lte: options.to } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { items, page: buildPageMeta(options.page, options.pageSize, total) };
}

/**
 * Canonical audit action names. Centralised so the UI can group and translate
 * them consistently and so tests can assert on stable strings.
 */
export const AUDIT_ACTIONS = {
  userLogin: "user.login",
  userLogout: "user.logout",
  userRegistered: "user.registered",
  passwordChanged: "user.password_changed",
  passwordResetRequested: "user.password_reset_requested",
  passwordResetCompleted: "user.password_reset_completed",
  passwordResetRejected: "user.password_reset_rejected",
  emailVerificationRequested: "user.email_verification_requested",
  emailVerificationCompleted: "user.email_verification_completed",
  emailVerificationRejected: "user.email_verification_rejected",
  settingsUpdated: "settings.updated",
  gmailConnected: "gmail.connected",
  gmailDisconnected: "gmail.disconnected",
  gmailScanStarted: "gmail.scan_started",
  gmailScanCompleted: "gmail.scan_completed",
  gmailScanFailed: "gmail.scan_failed",
  emailStored: "email.stored",
  emailClassified: "email.classified",
  emailNeedsReview: "email.needs_review",
  emailReprocessed: "email.reprocessed",
  emailDataDeleted: "email.data_deleted",
  applicationCreated: "application.created",
  applicationStatusChanged: "application.status_changed",
  applicationUpdatedByUser: "application.updated_by_user",
  applicationLinkedEmail: "application.linked_email",
  duplicateDetected: "application.duplicate_detected",
  notificationCreated: "notification.created",
  notificationAcknowledged: "notification.acknowledged",
  notificationSent: "notification.channel_sent",
  notificationFailed: "notification.channel_failed",
  escalationTriggered: "notification.escalated",
  voiceCallPlaced: "notification.voice_call_placed",
  voiceCallSuppressed: "notification.voice_call_suppressed",
  cleanupProposed: "cleanup.proposed",
  cleanupApproved: "cleanup.approved",
  cleanupExecuted: "cleanup.executed",
  cleanupBlocked: "cleanup.blocked",
  cleanupFailed: "cleanup.failed",
  integrationUpdated: "integration.updated",
  dataPurged: "privacy.data_purged",
  retentionSweep: "privacy.retention_sweep",
  accountDeleted: "user.account_deleted",
  accountDeletionRejected: "user.account_deletion_rejected",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
