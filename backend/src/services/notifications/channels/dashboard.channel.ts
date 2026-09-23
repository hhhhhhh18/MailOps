import type { Channel } from "@prisma/client";
import { logger } from "../../../config/logger";
import type { ChannelContext, ChannelPayload, ChannelResult, NotificationChannel } from "./types";

/**
 * Level 1 notification: the in-app dashboard.
 *
 * Delivery is implicit — the Notification row *is* the dashboard entry. This
 * channel exists so that every delivery is recorded in NotificationAttempt
 * uniformly, and so an acknowledgement can be attributed to the dashboard.
 */
export const dashboardChannel: NotificationChannel = {
  id: "DASHBOARD" as Channel,
  label: "MailOps dashboard",

  isConfigured(): boolean {
    return true;
  },

  async send(payload: ChannelPayload, _context: ChannelContext): Promise<ChannelResult> {
    logger.debug({ notificationId: payload.notificationId, severity: payload.severity }, "dashboard notification surfaced");
    return {
      ok: true,
      skipped: false,
      provider: "mailops-dashboard",
      providerMessageId: payload.notificationId,
      error: null,
    };
  },
};
