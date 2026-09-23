import type { Channel } from "@prisma/client";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { maskPhone } from "../../../utils/redact";
import { failed, skipped, type ChannelContext, type ChannelPayload, type ChannelResult, type NotificationChannel } from "./types";

/**
 * Level 4 escalation: AI voice call.
 *
 * The script is supplied by the voice-script AI responsibility and already
 * contains an automated-assistant disclosure. This channel only handles
 * telephony.
 *
 * Hard requirements enforced at this layer:
 *  - the user must have opted in (checked upstream in the escalation service)
 *  - the script must disclose that the caller is automated
 *  - no email content is ever read aloud
 */
export const voiceChannel: NotificationChannel = {
  id: "VOICE" as Channel,
  label: "AI voice call",

  isConfigured(context: ChannelContext): boolean {
    const sid = context.secrets.accountSid ?? env.VOICE_ACCOUNT_SID;
    const token = context.secrets.authToken ?? env.VOICE_AUTH_TOKEN;
    const from = context.config.fromNumber ?? env.VOICE_FROM_NUMBER;
    const to = context.config.to ?? context.config.phoneNumber;
    return Boolean(sid && token && from && to);
  },

  async send(payload: ChannelPayload, context: ChannelContext): Promise<ChannelResult> {
    const accountSid = String(context.secrets.accountSid ?? env.VOICE_ACCOUNT_SID ?? "");
    const authToken = String(context.secrets.authToken ?? env.VOICE_AUTH_TOKEN ?? "");
    const fromNumber = String(context.config.fromNumber ?? env.VOICE_FROM_NUMBER ?? "");
    const toNumber = String(context.config.to ?? context.config.phoneNumber ?? "");
    const script = String(payload.metadata?.voiceScript ?? "");

    if (!accountSid || !authToken || !fromNumber || !toNumber) {
      return skipped("VOICE" as Channel, env.VOICE_PROVIDER, "The voice provider is not configured for this account");
    }
    if (!script) {
      return skipped("VOICE" as Channel, env.VOICE_PROVIDER, "No voice script was generated for this event");
    }
    if (!/automated|automatic|ai assistant/i.test(script)) {
      // Defence in depth: never place a call that fails to identify itself.
      return skipped("VOICE" as Channel, env.VOICE_PROVIDER, "Blocked: script is missing the automated-caller disclosure");
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
    const form = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      // TwiML inline; Twilio reads the message aloud using its TTS engine.
      Twiml: `<Response><Say voice="Polly.Joanna">${escapeXml(script)}</Say></Response>`,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });

      const data = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!response.ok) {
        logger.warn({ to: maskPhone(toNumber), status: response.status }, "voice call failed");
        return {
          ok: false,
          skipped: false,
          provider: env.VOICE_PROVIDER,
          error: data.message ?? `Voice provider returned ${response.status}`,
        };
      }

      logger.info({ to: maskPhone(toNumber), callSid: data.sid }, "voice escalation call placed");
      return {
        ok: true,
        skipped: false,
        provider: env.VOICE_PROVIDER,
        providerMessageId: data.sid ?? null,
        error: null,
      };
    } catch (error) {
      logger.warn({ to: maskPhone(toNumber), err: (error as Error).message }, "voice call failed");
      return failed("VOICE" as Channel, env.VOICE_PROVIDER, error);
    }
  },
};

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
