import type { Integration, IntegrationKind } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { decryptJson } from "../../utils/crypto";
import { logger } from "../../config/logger";
import type { ChannelContext } from "./channels/types";

/**
 * Resolves a user's integration into a channel context.
 *
 * Secrets are stored envelope-encrypted and decrypted only here, only for the
 * duration of a send. If decryption fails (e.g. the encryption key was rotated
 * without re-encrypting) the channel reports itself unconfigured rather than
 * throwing: a broken Slack token must not stop a WhatsApp escalation.
 */
export async function resolveChannelContext(userId: string, kind: IntegrationKind): Promise<ChannelContext> {
  const integration = await prisma.integration.findUnique({
    where: { userId_kind: { userId, kind } },
  });

  if (!integration) return { config: {}, secrets: {} };

  let secrets: Record<string, unknown> = {};
  if (integration.secretsEnc) {
    try {
      secrets = decryptJson<Record<string, unknown>>(integration.secretsEnc) ?? {};
    } catch (error) {
      logger.warn(
        { userId, kind, err: (error as Error).message },
        "failed to decrypt integration secrets; treating channel as unconfigured",
      );
      secrets = {};
    }
  }

  return {
    config: (integration.config ?? {}) as Record<string, unknown>,
    secrets,
  };
}

export async function getIntegration(userId: string, kind: IntegrationKind): Promise<Integration | null> {
  return prisma.integration.findUnique({ where: { userId_kind: { userId, kind } } });
}

export interface IntegrationStatusView {
  kind: IntegrationKind;
  status: string;
  displayName: string | null;
  /** Secrets are never returned to the client — only whether one is stored. */
  hasCredentials: boolean;
  config: Record<string, unknown>;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export async function listIntegrationStatus(userId: string): Promise<IntegrationStatusView[]> {
  const rows = await prisma.integration.findMany({ where: { userId }, orderBy: { kind: "asc" } });
  return rows.map((row) => ({
    kind: row.kind,
    status: row.status,
    displayName: row.displayName,
    hasCredentials: Boolean(row.secretsEnc),
    config: sanitizeConfig((row.config ?? {}) as Record<string, unknown>),
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    lastError: row.lastError,
  }));
}

const SECRETISH_KEY = /(token|secret|password|key|webhook|sid)/i;

/** Strips anything credential-looking out of stored config before display. */
function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRETISH_KEY.test(key)) continue;
    out[key] = value;
  }
  return out;
}
