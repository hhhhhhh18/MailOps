import { createRequire } from "node:module";
import type { Channel } from "@prisma/client";
import { env, isProduction } from "../../../config/env";
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
 * Builds the SMTP transport once, so the notification channel and the
 * transactional path (password reset) cannot drift apart in configuration.
 */
function buildTransport(): { transport: MailTransport; provider: string } | { error: string } {
  const nodemailer = loadNodemailer();
  if (!nodemailer) {
    return { error: "The optional nodemailer package is not installed" };
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });

  return { transport, provider: "smtp" };
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
    return sendMail({
      to: String(context.config.to ?? ""),
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
      kind: payload.severity.toLowerCase(),
      missingDestinationMessage: "SMTP is not configured for this account",
    });
  },
};

/** A transactional message carrying a one-time credential (reset link). */
export interface TransactionalEmailInput {
  to: string;
  subject: string;
  /** Plain-text body. In development this contains the one-time link. */
  text: string;
  html?: string;
  /** Short label used in logs instead of the body, e.g. "password-reset". */
  kind: string;
}

/**
 * Transactional email (account lifecycle), not a notification.
 *
 * It reuses the exact same provider selection and transport as the notification
 * channel — deliberately one email system, two callers. The only behavioural
 * difference is the logging policy below, because a reset body contains a live
 * one-time credential.
 */
export async function sendTransactionalEmail(input: TransactionalEmailInput): Promise<ChannelResult> {
  return sendMail({
    ...input,
    missingDestinationMessage: "Transactional email is not configured (set SMTP_HOST or EMAIL_CHANNEL_PROVIDER)",
  });
}

interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: string;
  missingDestinationMessage: string;
}

async function sendMail(input: SendMailInput): Promise<ChannelResult> {
  const to = input.to;

  if (env.EMAIL_CHANNEL_PROVIDER === "console") {
    /**
     * Console provider.
     *
     * Development: the body is printed, because a password-reset link is only
     * usable if the developer can see it, and this provider never runs in a
     * deployed environment.
     *
     * Production: if the console provider is somehow selected, the body is
     * withheld entirely — a reset URL in production logs would be a live account
     * takeover credential.
     */
    if (isProduction) {
      logger.warn(
        { to: to ? redactSecrets(to) : "(missing)", subject: input.subject, kind: input.kind },
        "email suppressed: console provider selected in production; body withheld",
      );
      return failed("EMAIL" as Channel, "console", "Console email provider is not permitted in production");
    }

    logger.info(
      {
        to: to || "(user account email)",
        subject: input.subject,
        kind: input.kind,
        body: input.text,
      },
      "email (console provider, development)",
    );
    return { ok: true, skipped: false, provider: "console", providerMessageId: null, error: null };
  }

  if (!env.SMTP_HOST || !to) {
    return skipped("EMAIL" as Channel, "smtp", input.missingDestinationMessage);
  }

  const built = buildTransport();
  if ("error" in built) {
    return skipped("EMAIL" as Channel, "smtp", built.error);
  }

  try {
    const info = await built.transport.sendMail({
      from: env.SMTP_FROM,
      to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    });

    // Kind and destination only — never the subject line or body of a
    // credential-bearing message.
    logger.info({ kind: input.kind, provider: "smtp" }, "transactional email sent");
    return { ok: true, skipped: false, provider: built.provider, providerMessageId: info.messageId ?? null, error: null };
  } catch (error) {
    logger.warn({ kind: input.kind, err: (error as Error).message }, "email send failed");
    return failed("EMAIL" as Channel, "smtp", error);
  }
}
