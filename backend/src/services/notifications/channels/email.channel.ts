import { createRequire } from "node:module";
import type { Channel } from "@prisma/client";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { redactSecrets } from "../../../utils/redact";
import { failed, skipped, type ChannelContext, type ChannelPayload, type ChannelResult, type NotificationChannel } from "./types";

/**
 * `nodemailer` is an optional dependency: the console provider needs nothing, so
 * most deployments never install it. Requiring it at runtime (rather than
 * importing it) keeps it out of the build graph entirely and lets the channel
 * degrade to "skipped" when it is absent.
 */
const nodeRequire = createRequire(__filename);

interface MailTransport {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>;
}

interface NodemailerModule {
  createTransport(options: Record<string, unknown>): MailTransport;
}

function loadNodemailer(): NodemailerModule | null {
  try {
    return nodeRequire("nodemailer") as NodemailerModule;
  } catch {
    return null;
  }
}

/**
 * Optional email channel.
 *
 * Defaults to the `console` provider: in development MailOps logs the message it
 * would have sent instead of requiring an SMTP server. Set
 * EMAIL_CHANNEL_PROVIDER=smtp to deliver for real.
 */
export const emailChannel: NotificationChannel = {
  id: "EMAIL" as Channel,
  label: "Email",

  isConfigured(context: ChannelContext): boolean {
    if (env.EMAIL_CHANNEL_PROVIDER === "console") return true;
    return Boolean(context.config.to && env.SMTP_HOST);
  },

  async send(payload: ChannelPayload, context: ChannelContext): Promise<ChannelResult> {
    const to = String(context.config.to ?? "");

    if (env.EMAIL_CHANNEL_PROVIDER === "console") {
      // Structured, redacted output — safe to leave enabled locally.
      logger.info(
        {
          to: to || "(user account email)",
          subject: `[MailOps] ${redactSecrets(payload.title)}`,
          severity: payload.severity,
          actionUrl: payload.actionUrl,
        },
        "email notification (console provider)",
      );
      return { ok: true, skipped: false, provider: "console", providerMessageId: null, error: null };
    }

    if (!env.SMTP_HOST || !to) {
      return skipped("EMAIL" as Channel, "smtp", "SMTP is not configured for this account");
    }

    try {
      // A transport dependency is intentionally not bundled: MailOps keeps the
      // email channel pluggable so deployments can use their existing provider.
      const nodemailer = loadNodemailer();
      if (!nodemailer) {
        return skipped("EMAIL" as Channel, "smtp", "The optional nodemailer package is not installed");
      }

      const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      });

      const info = await transport.sendMail({
        from: env.SMTP_FROM,
        to,
        subject: `[MailOps] ${payload.title}`,
        text: [
          payload.title,
          "",
          payload.company ? `Company: ${payload.company}` : "",
          payload.role ? `Role: ${payload.role}` : "",
          payload.status ? `Status: ${payload.status}` : "",
          payload.body,
          payload.deadline ? `Deadline: ${payload.deadline}` : "",
          payload.actionUrl ? `Open MailOps: ${payload.actionUrl}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });

      return { ok: true, skipped: false, provider: "smtp", providerMessageId: info.messageId ?? null, error: null };
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "email notification failed");
      return failed("EMAIL" as Channel, "smtp", error);
    }
  },
};
