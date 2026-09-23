import type { Channel } from "@prisma/client";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { describeError } from "../../utils/errors";
import { enqueueEscalationEvaluation } from "../../queues";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import { getChannel } from "./channels";
import { resolveChannelContext } from "./integration-resolver";
import { markNotificationSent, buildDedupeKey } from "./notification.service";
import { readPlan, scheduleEscalation } from "./escalation.service";
import type { ChannelPayload } from "./channels/types";

/**
 * Initial delivery of a notification across the channels the decision engine
 * selected, followed by arming the escalation ladder.
 *
 * Failure isolation is the point of this module: each channel is attempted
 * independently and recorded independently, so Slack being down never prevents
 * the dashboard entry, the email, or a later WhatsApp escalation.
 */

export interface DispatchOutcome {
  notificationId: string;
  delivered: Channel[];
  failed: Channel[];
  skipped: Channel[];
  escalationArmed: boolean;
}

export async function dispatchNotification(notificationId: string): Promise<DispatchOutcome> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!notification) {
    return { notificationId, delivered: [], failed: [], skipped: [], escalationArmed: false };
  }

  const plan = readPlan(notification);
  const metadata = (notification.metadata ?? {}) as { payload?: Omit<ChannelPayload, "notificationId">; requiredAction?: string };
  const stored = metadata.payload;

  const payload: ChannelPayload = {
    title: stored?.title ?? notification.title,
    body: stored?.body ?? notification.body ?? "",
    actionUrl: stored?.actionUrl ?? null,
    actionLabel: stored?.actionLabel ?? notification.actionLabel ?? "Open in MailOps",
    severity: notification.severity,
    company: stored?.company ?? null,
    role: stored?.role ?? null,
    status: stored?.status ?? null,
    deadline: stored?.deadline ?? null,
    notificationId: notification.id,
    metadata: { requiredAction: metadata.requiredAction ?? null },
  };

  const targets: Array<{ channel: Channel; integrationKind: "SLACK" | "WHATSAPP" | "VOICE" | "EMAIL" | "AI" }> = [
    { channel: "DASHBOARD", integrationKind: "AI" },
  ];

  if (plan?.channels.slack) targets.push({ channel: "SLACK", integrationKind: "SLACK" });
  if (plan?.channels.whatsapp) targets.push({ channel: "WHATSAPP", integrationKind: "WHATSAPP" });
  if (plan?.channels.email) targets.push({ channel: "EMAIL", integrationKind: "EMAIL" });

  const delivered: Channel[] = [];
  const failed: Channel[] = [];
  const skippedChannels: Channel[] = [];

  for (const target of targets) {
    const implementation = getChannel(target.channel);
    const context = await resolveChannelContext(notification.userId, target.integrationKind);

    // Dashboard delivery is implicit; everything else needs configuration.
    if (target.channel !== "DASHBOARD" && !implementation.isConfigured(context)) {
      skippedChannels.push(target.channel);
      await recordAttempt(notification.id, target.channel, {
        ok: false,
        skipped: true,
        provider: implementation.label,
        error: `${implementation.label} is not configured for this account`,
      });
      continue;
    }

    let result;
    try {
      result = await implementation.send(payload, context);
    } catch (error) {
      logger.error({ notificationId: notification.id, channel: target.channel, ...describeError(error) }, "channel delivery threw");
      result = { ok: false, skipped: false, provider: implementation.label, error: describeError(error).message };
    }

    await recordAttempt(notification.id, target.channel, result);

    if (result.ok) {
      delivered.push(target.channel);
      await recordAudit({
        userId: notification.userId,
        actor: "SYSTEM",
        action: AUDIT_ACTIONS.notificationSent,
        entityType: "Notification",
        entityId: notification.id,
        summary: `Delivered via ${implementation.label}`,
        metadata: { channel: target.channel, provider: result.provider },
      });
    } else if (result.skipped) {
      skippedChannels.push(target.channel);
    } else {
      failed.push(target.channel);
      await recordAudit({
        userId: notification.userId,
        actor: "SYSTEM",
        action: AUDIT_ACTIONS.notificationFailed,
        entityType: "Notification",
        entityId: notification.id,
        summary: `${implementation.label} delivery failed`,
        metadata: { channel: target.channel, error: result.error },
      });
    }
  }

  await markNotificationSent(notification.id);

  const escalated = await scheduleEscalation(notification);

  if (escalated.scheduled) {
    await recordAudit({
      userId: notification.userId,
      actor: "SYSTEM",
      action: AUDIT_ACTIONS.escalationTriggered,
      entityType: "Notification",
      entityId: notification.id,
      summary: "Escalation ladder armed",
      metadata: {
        firstStage: plan?.escalation.stages[0] ?? null,
        delaysMinutes: plan?.escalation.delaysMinutes ?? [],
        requiresAck: notification.requiresAck,
      },
    });
  }

  return {
    notificationId: notification.id,
    delivered,
    failed,
    skipped: skippedChannels,
    escalationArmed: escalated.scheduled,
  };
}

async function recordAttempt(
  notificationId: string,
  channel: Channel,
  result: { ok: boolean; skipped: boolean; provider: string; providerMessageId?: string | null; error?: string | null },
): Promise<void> {
  const attemptNo = await prisma.notificationAttempt.count({ where: { notificationId, channel } });
  await prisma.notificationAttempt.create({
    data: {
      notificationId,
      channel,
      status: result.ok ? "SENT" : result.skipped ? "SKIPPED" : "FAILED",
      stage: -1, // base delivery, before the escalation ladder
      provider: result.provider,
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ? result.error.slice(0, 500) : null,
      attemptNo: attemptNo + 1,
      sentAt: result.ok ? new Date() : null,
    },
  });
}

/**
 * Re-arms escalation for notifications created before the ladder existed (e.g.
 * after a settings change) and clears timers for acknowledged ones.
 */
export async function reconcileEscalations(userId: string): Promise<{ armed: number; cleared: number }> {
  const pending = await prisma.notification.findMany({
    where: { userId, requiresAck: true, acknowledgedAt: null, status: { in: ["PENDING", "SENT"] }, nextEscalationAt: null },
    take: 50,
  });

  let armed = 0;
  for (const notification of pending) {
    const plan = readPlan(notification);
    if (!plan?.escalation.enabled || plan.escalation.stages.length === 0) continue;
    const delay = Math.max(1, plan.escalation.delaysMinutes[0] ?? 30) * 60_000;
    await prisma.notification.update({
      where: { id: notification.id },
      data: { nextEscalationAt: new Date(Date.now() + delay) },
    });
    await enqueueEscalationEvaluation({ notificationId: notification.id, stage: 0 }, { delayMs: delay });
    armed += 1;
  }

  const cleared = await prisma.notification.updateMany({
    where: { userId, nextEscalationAt: { not: null }, OR: [{ acknowledgedAt: { not: null } }, { status: "RESOLVED" }] },
    data: { nextEscalationAt: null, escalationPaused: true },
  });

  return { armed, cleared: cleared.count };
}

export { buildDedupeKey };
