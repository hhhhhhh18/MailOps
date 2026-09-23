import type { Channel } from "@prisma/client";
import { dashboardChannel } from "./dashboard.channel";
import { slackChannel } from "./slack.channel";
import { whatsappChannel } from "./whatsapp.channel";
import { voiceChannel } from "./voice.channel";
import { emailChannel } from "./email.channel";
import type { NotificationChannel } from "./types";

/**
 * Channel registry. Adding a channel means adding one entry here — the
 * escalation engine and dispatcher discover capabilities from this map and
 * never hard-code channel availability.
 */
export const CHANNELS: Record<Channel, NotificationChannel> = {
  DASHBOARD: dashboardChannel,
  SLACK: slackChannel,
  WHATSAPP: whatsappChannel,
  VOICE: voiceChannel,
  EMAIL: emailChannel,
};

export const ESCALATABLE_CHANNELS: Channel[] = ["SLACK", "WHATSAPP", "VOICE"];

export function getChannel(channel: Channel): NotificationChannel {
  return CHANNELS[channel];
}

export * from "./types";
