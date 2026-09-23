import type { Channel } from "@prisma/client";

/**
 * Delivery payload for an outbound notification.
 *
 * It deliberately carries *facts about the application*, not the email body:
 * "do not send sensitive email contents unnecessarily" (product rule #16).
 * The user is always pointed back to MailOps for the full detail.
 */
export interface ChannelPayload {
  title: string;
  body: string;
  actionUrl: string | null;
  actionLabel: string | null;
  severity: string;
  company: string | null;
  role: string | null;
  status: string | null;
  deadline: string | null;
  /** Identifier of the notification, for provider-side correlation. */
  notificationId: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelResult {
  ok: boolean;
  /** True when the channel was not configured — a soft, non-alerting outcome. */
  skipped: boolean;
  provider: string;
  providerMessageId?: string | null;
  error?: string | null;
}

export interface IntegrationSecrets {
  [key: string]: unknown;
}

export interface ChannelContext {
  /** Non-secret configuration (channel ids, phone numbers, display names). */
  config: Record<string, unknown>;
  /** Decrypted secrets; empty object when the channel is unconfigured. */
  secrets: IntegrationSecrets;
}

export interface NotificationChannel {
  readonly id: Channel;
  readonly label: string;
  /** Whether the channel can deliver given the resolved integration context. */
  isConfigured(context: ChannelContext): boolean;
  send(payload: ChannelPayload, context: ChannelContext): Promise<ChannelResult>;
}

export function skipped(channel: Channel, provider: string, reason: string): ChannelResult {
  return { ok: false, skipped: true, provider, error: reason };
}

export function failed(channel: Channel, provider: string, error: unknown): ChannelResult {
  return {
    ok: false,
    skipped: false,
    provider,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Prefixes an app-relative action URL so external channels get a clickable link. */
export function absoluteActionUrl(actionUrl: string | null, webBaseUrl: string): string | null {
  if (!actionUrl) return null;
  if (/^https?:\/\//i.test(actionUrl)) return actionUrl;
  return `${webBaseUrl.replace(/\/$/, "")}${actionUrl.startsWith("/") ? "" : "/"}${actionUrl}`;
}
