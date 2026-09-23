import type { Channel, Notification, NotificationSeverity } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { redis, REDIS_OP_TIMEOUT_MS, withTimeout } from "../../config/redis";
import { isWithinQuietHours, minutesSince } from "../../utils/dates";
import { describeError } from "../../utils/errors";
import { maskPhone } from "../../utils/redact";
import { enqueueEscalationEvaluation, enqueueNotification } from "../../queues";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import type { Decision } from "../decisions/decision.engine";
import { buildVoiceScript } from "../ai/voice-script";
import { getChannel } from "./channels";
import { resolveChannelContext } from "./integration-resolver";
import type { ChannelPayload } from "./channels/types";
import { buildNotificationContent, buildDedupeKey } from "./notification.service";

/**
 * Acknowledgement-driven escalation.
 *
 *   important email
 *        -> dashboard
 *        -> (unacknowledged after N minutes) Slack
 *        -> (unacknowledged) WhatsApp
 *        -> (unacknowledged, opt-in, allowed) AI voice call
 *
 * The ladder is data, not code: the plan is computed once from the user's
 * settings and stored on the notification, so the worker that wakes up 30 (or
 * 60, or 120) minutes later needs no re-derivation and cannot disagree with what
 * the user was promised.
 *
 * Escalation stops the moment the user acknowledges — from any surface.
 */

export interface NotificationPlan {
  channels: { dashboard: boolean; slack: boolean; whatsapp: boolean; email: boolean };
  escalation: { enabled: boolean; delaysMinutes: number[]; maxStage: number; stages: Channel[] };
  voiceEligible: boolean;
  voiceEventKey: string | null;
  voiceSuppressionReason: string | null;
}

export function buildPlan(decision: Decision): NotificationPlan {
  return {
    channels: {
      dashboard: decision.channels.dashboard,
      slack: decision.channels.slack,
      whatsapp: decision.channels.whatsapp,
      email: decision.channels.email,
    },
    escalation: {
      enabled: decision.escalation.enabled,
      delaysMinutes: decision.escalation.delaysMinutes,
      maxStage: decision.escalation.maxStage,
      stages: decision.escalation.stages as Channel[],
    },
    voiceEligible: decision.voiceEligible,
    voiceEventKey: decision.voiceEventKey,
    voiceSuppressionReason: decision.voiceSuppressionReason,
  };
}

export function readPlan(notification: Notification): NotificationPlan | null {
  const metadata = (notification.metadata ?? {}) as { plan?: NotificationPlan };
  return metadata.plan ?? null;
}

/** Delay before escalating to `stage`, clamped to a sane range. */
function delayForStage(plan: NotificationPlan, stage: number): number {
  const minutes = plan.escalation.delaysMinutes[stage] ?? plan.escalation.delaysMinutes.at(-1) ?? 30;
  return Math.max(1, minutes) * 60_000;
}

/**
 * Arms the escalation ladder for a notification. Called once, right after the
 * initial dashboard delivery.
 */
export async function scheduleEscalation(notification: Notification): Promise<{ scheduled: boolean; stage: number | null }> {
  const plan = readPlan(notification);
  if (!notification.requiresAck || !plan?.escalation.enabled || plan.escalation.stages.length === 0) {
    return { scheduled: false, stage: null };
  }

  const delay = delayForStage(plan, 0);
  const nextEscalationAt = new Date(Date.now() + delay);

  await prisma.notification.update({
    where: { id: notification.id },
    data: { nextEscalationAt, escalationStage: -1 },
  });

  // A delayed BullMQ job survives process restarts and is the primary timer.
  await enqueueEscalationEvaluation({ notificationId: notification.id, stage: 0 }, { delayMs: delay });

  logger.info(
    { notificationId: notification.id, stage: 0, channel: plan.escalation.stages[0], inMinutes: delay / 60_000 },
    "escalation armed",
  );

  return { scheduled: true, stage: 0 };
}

export interface EscalationOutcome {
  notificationId: string;
  action: "STOPPED" | "ESCALATED" | "EXHAUSTED" | "SUPPRESSED" | "FAILED";
  channel: Channel | null;
  stage: number;
  reason?: string;
  nextStage: number | null;
}

/**
 * Evaluates one escalation stage. Idempotent: re-running the same stage after a
 * worker crash re-checks acknowledgement and re-sends at most once, because the
 * notification's escalationStage is only advanced on success.
 */
export async function evaluateEscalation(notificationId: string, stage: number): Promise<EscalationOutcome> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: {
      user: { include: { settings: true } },
      application: { select: { id: true, company: true, role: true, status: true } },
    },
  });

  if (!notification) {
    return { notificationId, action: "STOPPED", channel: null, stage, reason: "notification not found", nextStage: null };
  }

  // 1. Stop conditions — the user already responded, or the event was resolved.
  if (notification.acknowledgedAt) {
    return { notificationId, action: "STOPPED", channel: null, stage, reason: "acknowledged", nextStage: null };
  }
  if (["ACKNOWLEDGED", "RESOLVED", "CANCELLED"].includes(notification.status)) {
    return { notificationId, action: "STOPPED", channel: null, stage, reason: `status=${notification.status}`, nextStage: null };
  }
  if (notification.escalationPaused) {
    return { notificationId, action: "STOPPED", channel: null, stage, reason: "escalation paused by user", nextStage: null };
  }

  // 2. Stale-job guard: if the notification has already advanced past this stage,
  //    a late or duplicated job must not re-fire an older channel.
  if (notification.escalationStage >= stage) {
    return {
      notificationId,
      action: "STOPPED",
      channel: null,
      stage,
      reason: `already reached stage ${notification.escalationStage}`,
      nextStage: null,
    };
  }

  const plan = readPlan(notification);
  if (!plan) {
    return { notificationId, action: "STOPPED", channel: null, stage, reason: "no escalation plan recorded", nextStage: null };
  }

  const channel = plan.escalation.stages[stage];
  if (!channel) {
    await finalizeEscalation(notification.id);
    return { notificationId, action: "EXHAUSTED", channel: null, stage, reason: "no further stages", nextStage: null };
  }

  const settings = notification.user.settings;
  const payload = buildEscalationPayload(notification, channel);

  // 3. Channel-specific gates.
  if (channel === "VOICE") {
    const gate = await checkVoiceGate(notification.userId, settings, notification.user.timezone, plan);
    if (!gate.allowed) {
      await recordAttempt(notification.id, channel, {
        ok: false,
        skipped: true,
        provider: "policy",
        error: gate.reason,
      }, stage);
      await recordAudit({
        userId: notification.userId,
        actor: "SYSTEM",
        action: AUDIT_ACTIONS.voiceCallSuppressed,
        entityType: "Notification",
        entityId: notification.id,
        summary: gate.reason ?? "Voice escalation suppressed",
        metadata: { stage, plan: plan.voiceEventKey },
      });

      const nextStage = plan.escalation.stages[stage + 1] ? stage + 1 : null;
      if (nextStage !== null) {
        await advanceStage(notification.id, stage, nextStage, plan);
        return { notificationId, action: "SUPPRESSED", channel, stage, reason: gate.reason ?? undefined, nextStage };
      }
      await finalizeEscalation(notification.id);
      return { notificationId, action: "SUPPRESSED", channel, stage, reason: gate.reason ?? undefined, nextStage: null };
    }

    // Generate the spoken script at call time so it reflects the latest state.
    const script = await buildVoiceScript({
      company: notification.application?.company ?? null,
      role: notification.application?.role ?? null,
      statusLabel: payload.status,
      action: (notification.metadata as { requiredAction?: string })?.requiredAction ?? null,
      deadline: payload.deadline,
      severity: notification.severity,
    });
    payload.metadata = { ...(payload.metadata ?? {}), voiceScript: script.script };
  }

  // 4. Deliver.
  const context = await resolveChannelContext(notification.userId, kindForChannel(channel));
  const implementation = getChannel(channel);

  if (!implementation.isConfigured(context)) {
    await recordAttempt(notification.id, channel, {
      ok: false,
      skipped: true,
      provider: implementation.label,
      error: `${implementation.label} is not configured`,
    }, stage);

    const nextStage = plan.escalation.stages[stage + 1] ? stage + 1 : null;
    if (nextStage !== null) {
      await advanceStage(notification.id, stage, nextStage, plan);
      return { notificationId, action: "SUPPRESSED", channel, stage, reason: "channel not configured", nextStage };
    }
    await finalizeEscalation(notification.id);
    return { notificationId, action: "SUPPRESSED", channel, stage, reason: "channel not configured", nextStage: null };
  }

  let result;
  try {
    result = await implementation.send({ ...payload, notificationId: notification.id }, context);
  } catch (error) {
    logger.error({ notificationId: notification.id, channel, ...describeError(error) }, "escalation delivery threw");
    result = { ok: false, skipped: false, provider: implementation.label, error: describeError(error).message };
  }

  await recordAttempt(notification.id, channel, result, stage);

  if (result.ok) {
    await recordAudit({
      userId: notification.userId,
      actor: "SYSTEM",
      action: channel === "VOICE" ? AUDIT_ACTIONS.voiceCallPlaced : AUDIT_ACTIONS.escalationTriggered,
      entityType: "Notification",
      entityId: notification.id,
      summary: `Escalated to ${implementation.label}`,
      metadata: { stage, provider: result.provider, providerMessageId: result.providerMessageId },
    });

    if (channel === "VOICE") {
      await incrementVoiceUsage(notification.userId);
    }
  } else {
    await recordAudit({
      userId: notification.userId,
      actor: "SYSTEM",
      action: AUDIT_ACTIONS.notificationFailed,
      entityType: "Notification",
      entityId: notification.id,
      summary: `${implementation.label} delivery failed`,
      metadata: { stage, error: result.error },
    });
  }

  const nextStage = result.ok && plan.escalation.stages[stage + 1] ? stage + 1 : null;

  if (nextStage !== null) {
    await advanceStage(notification.id, stage, nextStage, plan);
    return { notificationId, action: "ESCALATED", channel, stage, reason: result.error ?? undefined, nextStage };
  }

  await finalizeEscalation(notification.id);
  return {
    notificationId,
    action: result.ok ? "EXHAUSTED" : "FAILED",
    channel,
    stage,
    reason: result.error ?? undefined,
    nextStage: null,
  };
}

function buildEscalationPayload(notification: Notification, _channel: Channel): ChannelPayload {
  const metadata = (notification.metadata ?? {}) as {
    payload?: Omit<ChannelPayload, "notificationId">;
    requiredAction?: string;
  };
  const stored = metadata.payload;
  return {
    title: stored?.title ?? notification.title,
    body: stored?.body ?? notification.body ?? "",
    actionUrl: stored?.actionUrl ?? (notification.actionUrl ? `${env.WEB_BASE_URL}${notification.actionUrl}` : null),
    actionLabel: stored?.actionLabel ?? notification.actionLabel ?? "Open in MailOps",
    severity: notification.severity,
    company: stored?.company ?? null,
    role: stored?.role ?? null,
    status: stored?.status ?? null,
    deadline: stored?.deadline ?? null,
    notificationId: notification.id,
    metadata: { requiredAction: metadata.requiredAction ?? null },
  };
}

async function advanceStage(notificationId: string, completedStage: number, nextStageIndex: number, plan: NotificationPlan): Promise<void> {
  const delay = delayForStage(plan, nextStageIndex);
  await prisma.notification.update({
    where: { id: notificationId },
    data: {
      escalationStage: completedStage,
      status: "ESCALATED",
      nextEscalationAt: new Date(Date.now() + delay),
    },
  });
  await enqueueEscalationEvaluation({ notificationId, stage: nextStageIndex }, { delayMs: delay });
  logger.info(
    { notificationId, completedStage, nextStageIndex, channel: plan.escalation.stages[nextStageIndex], inMinutes: delay / 60_000 },
    "escalation advanced",
  );
}

async function finalizeEscalation(notificationId: string): Promise<void> {
  await prisma.notification.update({
    where: { id: notificationId },
    data: { status: "ESCALATED", nextEscalationAt: null },
  });
}

async function recordAttempt(
  notificationId: string,
  channel: Channel,
  result: { ok: boolean; skipped: boolean; provider: string; providerMessageId?: string | null; error?: string | null },
  stage: number,
): Promise<void> {
  const attemptNo = await prisma.notificationAttempt.count({ where: { notificationId, channel } });
  await prisma.notificationAttempt.create({
    data: {
      notificationId,
      channel,
      status: result.ok ? "SENT" : result.skipped ? "SKIPPED" : "FAILED",
      stage,
      provider: result.provider,
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ? result.error.slice(0, 500) : null,
      attemptNo: attemptNo + 1,
      sentAt: result.ok ? new Date() : null,
    },
  });
}

/** -------------------------------------------------------------------------- */
/** Voice guard rails                                                            */
/** -------------------------------------------------------------------------- */

interface VoiceGate {
  allowed: boolean;
  reason: string | null;
}

/**
 * Every reason not to call, checked immediately before dialling:
 *  - the user must have opted in (and the event type must be enabled)
 *  - quiet hours
 *  - daily call cap
 */
export async function checkVoiceGate(
  userId: string,
  settings: {
    voiceEnabled: boolean;
    voiceMaxCallsPerDay: number;
    voiceQuietHoursStart: number;
    voiceQuietHoursEnd: number;
    voiceCriticalEvents: string[];
  } | null,
  timezone: string,
  plan: NotificationPlan,
): Promise<VoiceGate> {
  if (!settings?.voiceEnabled) {
    return { allowed: false, reason: "Voice escalation is disabled for this account." };
  }
  if (!plan.voiceEligible) {
    return { allowed: false, reason: plan.voiceSuppressionReason ?? "This event is not eligible for a call." };
  }
  if (plan.voiceEventKey && !settings.voiceCriticalEvents.includes(plan.voiceEventKey)) {
    return { allowed: false, reason: `Calls for ${plan.voiceEventKey} events are switched off.` };
  }
  if (isWithinQuietHours(new Date(), timezone, settings.voiceQuietHoursStart, settings.voiceQuietHoursEnd)) {
    return {
      allowed: false,
      reason: `Within quiet hours (${settings.voiceQuietHoursStart}:00–${settings.voiceQuietHoursEnd}:00 ${timezone}).`,
    };
  }

  const used = await getVoiceCallsToday(userId);
  if (used >= settings.voiceMaxCallsPerDay) {
    return { allowed: false, reason: `Daily call limit of ${settings.voiceMaxCallsPerDay} reached.` };
  }

  return { allowed: true, reason: null };
}

/**
 * Daily voice-call count.
 *
 * Redis is the fast path; when it is unavailable the count is derived from the
 * persisted NotificationAttempt rows, which is why a Redis flush can never cause
 * a user to receive more calls than their configured daily maximum.
 */
export async function getVoiceCallsToday(userId: string, persistedFallback = 0): Promise<number> {
  const key = `voice:calls:${userId}:${new Date().toISOString().slice(0, 10)}`;
  try {
    // Bounded: an unreachable Redis must not stall the call guard.
    const value = await withTimeout(redis.get(key), REDIS_OP_TIMEOUT_MS, "voice counter read");
    if (value !== null) return Number.parseInt(value, 10) || 0;
  } catch {
    // fall through to the database
  }

  try {
    const counted = await prisma.notificationAttempt.count({
      where: {
        channel: "VOICE",
        status: "SENT",
        createdAt: { gte: new Date(Date.now() - 86_400_000) },
        notification: { userId },
      },
    });
    return counted;
  } catch {
    return persistedFallback;
  }
}

async function incrementVoiceUsage(userId: string): Promise<void> {
  const key = `voice:calls:${userId}:${new Date().toISOString().slice(0, 10)}`;
  try {
    const count = await withTimeout(redis.incr(key), REDIS_OP_TIMEOUT_MS, "voice counter increment");
    if (count === 1) await redis.expire(key, 86_400);
  } catch {
    // Non-fatal: the fallback counter derives from NotificationAttempt rows.
  }

  await prisma.userSettings
    .updateMany({ where: { userId }, data: { voiceCallsToday: { increment: 1 } } })
    .catch(() => undefined);
}

/** -------------------------------------------------------------------------- */
/** Safety net                                                                   */
/** -------------------------------------------------------------------------- */

/**
 * Finds notifications whose escalation timer has elapsed but whose delayed job
 * was lost (Redis flush, worker restart mid-flight). The scheduler calls this
 * every few minutes so an escalation is never silently dropped.
 */
export async function sweepOverdueEscalations(limit = 25): Promise<number> {
  const due = await prisma.notification.findMany({
    where: {
      requiresAck: true,
      acknowledgedAt: null,
      status: { in: ["PENDING", "SENT", "ESCALATED"] },
      escalationPaused: false,
      nextEscalationAt: { lte: new Date() },
    },
    orderBy: { nextEscalationAt: "asc" },
    take: limit,
  });

  let queued = 0;
  for (const notification of due) {
    const plan = readPlan(notification);
    if (!plan?.escalation.enabled) continue;
    const nextStage = notification.escalationStage + 1;
    if (nextStage >= plan.escalation.stages.length) {
      await finalizeEscalation(notification.id);
      continue;
    }
    const jobId = await enqueueEscalationEvaluation({ notificationId: notification.id, stage: nextStage });
    if (jobId) queued += 1;
  }

  if (queued) logger.info({ queued }, "escalation sweeper re-queued overdue evaluations");
  return queued;
}

/** Re-dispatches the initial channels for a notification (manual retry). */
export async function retryNotificationDelivery(userId: string, notificationId: string): Promise<void> {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!notification) return;
  await enqueueNotification({ notificationId }, { required: false });
}

function kindForChannel(channel: Channel): "SLACK" | "WHATSAPP" | "VOICE" | "AI" {
  if (channel === "SLACK") return "SLACK";
  if (channel === "WHATSAPP") return "WHATSAPP";
  if (channel === "VOICE") return "VOICE";
  return "AI";
}

/** Derived metric used by analytics + the notifications page. */
export function escalationLatencyMinutes(notification: Notification, attempts: Array<{ sentAt: Date | null }>): number | null {
  const first = attempts
    .filter((a) => a.sentAt)
    .map((a) => a.sentAt as Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (!first) return null;
  return minutesSince(notification.createdAt, first);
}

/** Exposed for tests and the audit view. */
export { buildNotificationContent, buildDedupeKey };
export type { NotificationSeverity };
