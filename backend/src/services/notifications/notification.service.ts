import type {
  Application,
  Channel,
  Email,
  EmailAnalysis,
  Notification,
  NotificationSeverity,
  NotificationStatus,
  NotificationType,
  Prisma,
} from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { NOTIFICATION_DEDUPE_WINDOW_MINUTES, STATUS_LABELS, SUBCATEGORY_LABELS } from "../../config/constants";
import { buildPageMeta, type PageMeta } from "../../utils/http";
import { maskEmail, safeEmailPreview } from "../../utils/redact";
import { NotFoundError } from "../../utils/errors";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import { absoluteActionUrl, type ChannelPayload } from "./channels/types";
import type { Decision } from "../decisions/decision.engine";

/**
 * Notification creation and read model.
 *
 * Escalation lives in escalation.service.ts; this module owns the notification
 * lifecycle (created -> sent -> acknowledged / escalated / resolved) and the
 * user-facing feed.
 */

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  actionLabel?: string | null;
  applicationId?: string | null;
  emailId?: string | null;
  requiresAck?: boolean;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
  isDemo?: boolean;
  /** Set when the decision engine determined the account should be pushed to. */
  decision?: Decision;
  createdAt?: Date;
}

export interface CreateNotificationResult {
  notification: Notification;
  created: boolean;
  /** True when an identical in-window notification already existed. */
  deduped: boolean;
}

export async function createNotification(input: CreateNotificationInput): Promise<CreateNotificationResult> {
  const existing = await prisma.notification.findUnique({
    where: { userId_dedupeKey: { userId: input.userId, dedupeKey: input.dedupeKey } },
  });

  if (existing) {
    const ageMinutes = (Date.now() - existing.createdAt.getTime()) / 60_000;
    const resolvedOrAcknowledged = ["ACKNOWLEDGED", "RESOLVED"].includes(existing.status);
    if (!resolvedOrAcknowledged && ageMinutes < NOTIFICATION_DEDUPE_WINDOW_MINUTES) {
      return { notification: existing, created: false, deduped: true };
    }
  }

  const notification = await prisma.notification.upsert({
    where: { userId_dedupeKey: { userId: input.userId, dedupeKey: input.dedupeKey } },
    create: {
      userId: input.userId,
      type: input.type,
      severity: input.severity,
      title: input.title,
      body: input.body ?? null,
      actionUrl: input.actionUrl ?? null,
      actionLabel: input.actionLabel ?? null,
      applicationId: input.applicationId ?? null,
      emailId: input.emailId ?? null,
      requiresAck: input.requiresAck ?? false,
      status: "PENDING",
      dedupeKey: input.dedupeKey,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      isDemo: input.isDemo ?? false,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
    update: {
      // Re-fire: refresh content and reopen, but keep acknowledgement history.
      title: input.title,
      body: input.body ?? null,
      severity: input.severity,
      actionUrl: input.actionUrl ?? null,
      actionLabel: input.actionLabel ?? null,
      status: "PENDING",
      requiresAck: input.requiresAck ?? false,
      acknowledgedAt: null,
      acknowledgedVia: null,
      resolvedAt: null,
      escalationStage: -1,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });

  await recordAudit({
    userId: input.userId,
    actor: "AI",
    action: AUDIT_ACTIONS.notificationCreated,
    entityType: "Notification",
    entityId: notification.id,
    summary: input.title,
    metadata: {
      type: input.type,
      severity: input.severity,
      requiresAck: input.requiresAck,
      dedupeKey: input.dedupeKey,
    },
  });

  logger.info(
    { notificationId: notification.id, type: input.type, severity: input.severity, requiresAck: input.requiresAck },
    "notification created",
  );

  return { notification, created: true, deduped: false };
}

/** -------------------------------------------------------------------------- */
/** Content builder                                                             */
/** -------------------------------------------------------------------------- */

export interface BuildContentInput {
  type: NotificationType;
  severity: NotificationSeverity;
  analysis: Pick<EmailAnalysis, "category" | "subCategory" | "summary" | "confidence" | "reasoning">;
  application: Pick<Application, "id" | "company" | "role" | "status"> | null;
  email: Pick<Email, "id" | "subject" | "fromName" | "fromEmail" | "receivedAt"> | null;
  deadline: Date | null;
  requiredAction: string | null;
}

export interface NotificationContent {
  title: string;
  body: string;
  actionUrl: string;
  actionLabel: string;
  channelPayload: Omit<ChannelPayload, "notificationId">;
}

/**
 * Builds the notification text.
 *
 * Rules honoured here:
 *  - never quote more than the subject line of the email
 *  - mask sender addresses
 *  - always link back into MailOps rather than summarising everything remotely
 */
export function buildNotificationContent(input: BuildContentInput): NotificationContent {
  const company = input.application?.company ?? null;
  const role = input.application?.role ?? null;
  const label = input.analysis.subCategory ? SUBCATEGORY_LABELS[input.analysis.subCategory] : "Recruitment update";

  let title: string;
  if (input.type === "REVIEW_REQUIRED") {
    title = input.email?.subject
      ? `Review needed: ${safeEmailPreview(input.email.subject, 90)}`
      : "An email needs your review";
  } else if (company && role) {
    title =
      input.type === "REJECTION_RECEIVED"
        ? `${company} — ${role}: application not selected`
        : input.type === "OFFER_RECEIVED"
          ? `${company} — ${role}: you have an offer`
          : `${company} — ${role}: ${label.toLowerCase()}`;
  } else if (company) {
    title = `${company}: ${label.toLowerCase()}`;
  } else {
    title = `MailOps alert: ${label.toLowerCase()}`;
  }

  const bodyLines: string[] = [];
  if (input.analysis.summary) bodyLines.push(input.analysis.summary);
  if (input.requiredAction) bodyLines.push(`Action required: ${input.requiredAction}`);
  if (input.deadline) bodyLines.push(`Deadline: ${input.deadline.toISOString().slice(0, 10)}`);
  if (input.analysis.reasoning) bodyLines.push(input.analysis.reasoning);
  if (input.email?.fromEmail) {
    bodyLines.push(`From: ${input.email.fromName ?? maskEmail(input.email.fromEmail)}`);
  }

  const actionUrl = input.application ? `/applications/${input.application.id}` : input.email ? `/emails?emailId=${input.email.id}` : "/dashboard";

  const statusLabel = input.application ? STATUS_LABELS[input.application.status] : null;

  return {
    title,
    body: bodyLines.join("\n"),
    actionUrl,
    actionLabel: input.application ? "Open in MailOps" : "Review email",
    channelPayload: {
      title,
      body: bodyLines.join("\n"),
      actionUrl: absoluteActionUrl(actionUrl, env.WEB_BASE_URL),
      actionLabel: input.application ? "Open in MailOps" : "Review email",
      severity: input.severity,
      company,
      role,
      status: statusLabel,
      deadline: input.deadline ? input.deadline.toISOString().slice(0, 10) : null,
    },
  };
}

/** Stable dedupe key so the same event never notifies twice. */
export function buildDedupeKey(parts: {
  type: NotificationType;
  emailId?: string | null;
  applicationId?: string | null;
  subCategory?: string | null;
  discriminator?: string;
}): string {
  const subject = parts.emailId ?? parts.applicationId ?? "global";
  const detail = parts.subCategory ?? parts.discriminator ?? "update";
  return `${parts.type}:${subject}:${detail}`.slice(0, 190);
}

/** -------------------------------------------------------------------------- */
/** Status transitions                                                          */
/** -------------------------------------------------------------------------- */

export async function markNotificationSent(notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, status: "PENDING" },
    data: { status: "SENT" },
  });
}

export async function acknowledgeNotification(
  userId: string,
  notificationId: string,
  via: Channel = "DASHBOARD",
): Promise<Notification> {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!notification) throw new NotFoundError("Notification");

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: {
      acknowledgedAt: new Date(),
      acknowledgedVia: via,
      status: "ACKNOWLEDGED",
      nextEscalationAt: null,
      escalationPaused: true,
    },
  });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.notificationAcknowledged,
    entityType: "Notification",
    entityId: notification.id,
    summary: `Acknowledged via ${via}`,
    metadata: { stage: notification.escalationStage },
  });

  logger.info({ notificationId: notification.id, via, stage: notification.escalationStage }, "notification acknowledged");
  return updated;
}

export async function resolveNotification(userId: string, notificationId: string): Promise<Notification> {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!notification) throw new NotFoundError("Notification");
  return prisma.notification.update({
    where: { id: notification.id },
    data: { status: "RESOLVED", resolvedAt: new Date(), nextEscalationAt: null, escalationPaused: true },
  });
}

export async function pauseEscalation(userId: string, notificationId: string, paused: boolean): Promise<Notification> {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!notification) throw new NotFoundError("Notification");
  return prisma.notification.update({
    where: { id: notification.id },
    data: { escalationPaused: paused },
  });
}

/** -------------------------------------------------------------------------- */
/** Reads                                                                       */
/** -------------------------------------------------------------------------- */

export interface NotificationListFilters {
  page: number;
  pageSize: number;
  status?: NotificationStatus | NotificationStatus[];
  severity?: NotificationSeverity;
  type?: NotificationType;
  requiresAck?: boolean;
  unacknowledgedOnly?: boolean;
  applicationId?: string;
}

export async function listNotifications(
  userId: string,
  filters: NotificationListFilters,
): Promise<{ items: Array<Notification & { application: { id: string; company: string; role: string } | null; attempts: unknown[] }>; page: PageMeta }> {
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(filters.status ? { status: Array.isArray(filters.status) ? { in: filters.status } : filters.status } : {}),
    ...(filters.severity ? { severity: filters.severity } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.requiresAck !== undefined ? { requiresAck: filters.requiresAck } : {}),
    ...(filters.applicationId ? { applicationId: filters.applicationId } : {}),
    ...(filters.unacknowledgedOnly ? { acknowledgedAt: null, status: { notIn: ["CANCELLED", "RESOLVED"] } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: {
        application: { select: { id: true, company: true, role: true } },
        attempts: { orderBy: { createdAt: "desc" }, take: 6 },
      },
    }),
    prisma.notification.count({ where }),
  ]);

  return { items, page: buildPageMeta(filters.page, filters.pageSize, total) };
}

export async function getNotificationFeed(userId: string, limit = 8) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { application: { select: { id: true, company: true, role: true } } },
  });
}

export async function getNotificationCounts(userId: string) {
  const [unread, pendingAck, escalatedToday] = await Promise.all([
    prisma.notification.count({ where: { userId, status: { in: ["PENDING", "SENT", "ESCALATED"] } } }),
    prisma.notification.count({ where: { userId, requiresAck: true, acknowledgedAt: null, status: { notIn: ["CANCELLED"] } } }),
    prisma.notification.count({
      where: { userId, escalationStage: { gte: 0 }, updatedAt: { gte: new Date(Date.now() - 86_400_000) } },
    }),
  ]);
  return { unread, pendingAck, escalatedToday };
}
