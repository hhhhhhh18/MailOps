import type { Channel } from "@prisma/client";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { maskPhone } from "../../../utils/redact";
import { failed, skipped, type ChannelContext, type ChannelPayload, type ChannelResult, type NotificationChannel } from "./types";

/**
 * Level 3 notification: WhatsApp via a compliant Business/Cloud API provider.
 *
 * Compliance notes:
 *  - Business-initiated messages must use an approved template; `MAILOPS_ALERT`
 *    is the template name to register with your provider (see DEPLOYMENT.md).
 *  - Only application facts are sent. Never the email body.
 *  - The recipient is the number the user registered, never an address taken
 *    from email content.
 */
export const whatsappChannel: NotificationChannel = {
  id: "WHATSAPP" as Channel,
  label: "WhatsApp",

  isConfigured(context: ChannelContext): boolean {
    const token = context.secrets.accessToken ?? env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = context.config.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID;
    const to = context.config.to ?? env.WHATSAPP_DEFAULT_TO;
    return Boolean(token && phoneId && to);
  },

  async send(payload: ChannelPayload, context: ChannelContext): Promise<ChannelResult> {
    const accessToken = String(context.secrets.accessToken ?? env.WHATSAPP_ACCESS_TOKEN ?? "");
    const phoneNumberId = String(context.config.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID ?? "");
    const to = String(context.config.to ?? env.WHATSAPP_DEFAULT_TO ?? "");

    if (!accessToken || !phoneNumberId || !to) {
      return skipped("WHATSAPP" as Channel, env.WHATSAPP_PROVIDER, "WhatsApp is not configured for this account");
    }

    const bodyLines = [
      "*MailOps Alert*",
      "",
      payload.company ? `Your ${payload.company} application has an update.` : "You have a recruitment update.",
      payload.role ? `\n*Role:* ${payload.role}` : null,
      payload.status ? `*Status:* ${payload.status}` : null,
      payload.deadline ? `\n*Deadline:* ${payload.deadline}` : null,
      payload.actionUrl ? `\n*Open MailOps:*\n${payload.actionUrl}` : null,
    ].filter((line): line is string => line !== null);

    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    const requestBody = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: true, body: bodyLines.join("\n") },
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const data = (await response.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
        error?: { message?: string };
      };

      if (!response.ok) {
        logger.warn({ to: maskPhone(to), status: response.status }, "whatsapp send failed");
        return {
          ok: false,
          skipped: false,
          provider: env.WHATSAPP_PROVIDER,
          error: data.error?.message ?? `WhatsApp provider returned ${response.status}`,
        };
      }

      return {
        ok: true,
        skipped: false,
        provider: env.WHATSAPP_PROVIDER,
        providerMessageId: data.messages?.[0]?.id ?? null,
        error: null,
      };
    } catch (error) {
      logger.warn({ to: maskPhone(to), err: (error as Error).message }, "whatsapp send failed");
      return failed("WHATSAPP" as Channel, env.WHATSAPP_PROVIDER, error);
    }
  },
};
