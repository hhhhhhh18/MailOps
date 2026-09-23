import type { Channel } from "@prisma/client";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { failed, skipped, type ChannelContext, type ChannelPayload, type ChannelResult, type NotificationChannel } from "./types";

/**
 * Level 2 notification: Slack (incoming webhook).
 *
 * A webhook is used rather than a bot token so that no workspace-wide
 * installation is required and the credential scope stays minimal.
 */
export const slackChannel: NotificationChannel = {
  id: "SLACK" as Channel,
  label: "Slack",

  isConfigured(context: ChannelContext): boolean {
    return Boolean(context.secrets.webhookUrl ?? env.SLACK_WEBHOOK_URL);
  },

  async send(payload: ChannelPayload, context: ChannelContext): Promise<ChannelResult> {
    const webhookUrl = String(context.secrets.webhookUrl ?? env.SLACK_WEBHOOK_URL ?? "");
    if (!webhookUrl) return skipped("SLACK" as Channel, "slack-webhook", "No Slack webhook is configured");

    const emoji = payload.severity === "CRITICAL" ? "🚨" : "🔔";
    const lines = [
      `${emoji} *MailOps — ${payload.severity === "CRITICAL" ? "Important recruitment email" : "Recruitment update"}*`,
      "",
      `*Company:* ${payload.company ?? "Unknown"}`,
      payload.role ? `*Role:* ${payload.role}` : null,
      payload.status ? `*Status:* ${payload.status}` : null,
      "",
      payload.body,
      payload.deadline ? `\n*Deadline:* ${payload.deadline}` : null,
      payload.actionUrl ? `\n<${payload.actionUrl}|Open in MailOps>` : null,
    ].filter((line): line is string => line !== null);

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: lines.join("\n"),
          // Blocks keep the message readable in Slack's newer clients.
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: lines.join("\n") },
            },
          ],
          unfurl_links: false,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          skipped: false,
          provider: "slack-webhook",
          error: `Slack returned ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
        };
      }

      return { ok: true, skipped: false, provider: "slack-webhook", providerMessageId: null, error: null };
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "slack notification failed");
      return failed("SLACK" as Channel, "slack-webhook", error);
    }
  },
};
