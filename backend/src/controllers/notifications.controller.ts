import type { Request, Response } from "express";
import { z } from "zod";
import { currentUserId } from "../middleware/auth";
import { ok, paginated } from "../utils/http";
import {
  acknowledgeNotification,
  getNotificationCounts,
  listNotifications,
  pauseEscalation,
  resolveNotification,
  type NotificationListFilters,
} from "../services/notifications/notification.service";
import { retryNotificationDelivery, sweepOverdueEscalations } from "../services/notifications/escalation.service";
import { reconcileEscalations } from "../services/notifications/dispatcher.service";

export const notificationIdParamSchema = z.object({ notificationId: z.string().min(1).max(64) });

export const notificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum(["PENDING", "SENT", "ACKNOWLEDGED", "ESCALATED", "RESOLVED", "FAILED", "CANCELLED", "SUPPRESSED"])
    .optional(),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  type: z
    .enum([
      "JOB_IMPORTANT",
      "JOB_STATUS_CHANGE",
      "DEADLINE_APPROACHING",
      "OFFER_RECEIVED",
      "REJECTION_RECEIVED",
      "RECRUITER_ACTION",
      "CLEANUP_PROPOSAL",
      "REVIEW_REQUIRED",
      "SYNC_FAILURE",
      "INTEGRATION_FAILURE",
      "DIGEST",
    ])
    .optional(),
  requiresAck: z.coerce.boolean().optional(),
  unacknowledgedOnly: z.coerce.boolean().optional(),
  applicationId: z.string().max(64).optional(),
});

export async function list(req: Request, res: Response) {
  const userId = currentUserId(req);
  const query = req.query as unknown as z.infer<typeof notificationListQuerySchema>;
  const filters: NotificationListFilters = {
    page: query.page,
    pageSize: query.pageSize,
    status: query.status,
    severity: query.severity,
    type: query.type,
    requiresAck: query.requiresAck,
    unacknowledgedOnly: query.unacknowledgedOnly,
    applicationId: query.applicationId,
  };

  const { items, page } = await listNotifications(userId, filters);
  return paginated(res, items, page);
}

export async function counts(req: Request, res: Response) {
  const userId = currentUserId(req);
  return ok(res, await getNotificationCounts(userId));
}

export const ackSchema = z.object({ via: z.enum(["DASHBOARD", "SLACK", "WHATSAPP", "EMAIL", "VOICE"]).default("DASHBOARD") });

/**
 * Acknowledgement. This is what stops the escalation ladder — the notification
 * service clears nextEscalationAt and pauses escalation in the same write.
 */
export async function acknowledge(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = (req.body ?? {}) as z.infer<typeof ackSchema>;
  const notification = await acknowledgeNotification(userId, req.params.notificationId, body.via);
  return ok(res, { notification, escalationStopped: true });
}

export async function resolve(req: Request, res: Response) {
  const userId = currentUserId(req);
  const notification = await resolveNotification(userId, req.params.notificationId);
  return ok(res, notification);
}

export const pauseSchema = z.object({ paused: z.boolean() });

export async function pause(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = req.body as z.infer<typeof pauseSchema>;
  const notification = await pauseEscalation(userId, req.params.notificationId, body.paused);
  return ok(res, notification);
}

/** Manual retry of the initial channel delivery (e.g. after fixing Slack). */
export async function retry(req: Request, res: Response) {
  const userId = currentUserId(req);
  await retryNotificationDelivery(userId, req.params.notificationId);
  return ok(res, { queued: true }, undefined, 202);
}

/** Re-arms escalation for pending acknowledgements and clears settled timers. */
export async function reconcile(req: Request, res: Response) {
  const userId = currentUserId(req);
  const result = await reconcileEscalations(userId);
  return ok(res, result);
}

/** Safety-net sweep; also runs automatically from the scheduler. */
export async function sweep(req: Request, res: Response) {
  const queued = await sweepOverdueEscalations();
  return ok(res, { queued });
}
