import type { Request, Response } from "express";
import { z } from "zod";
import type { IntegrationKind } from "@prisma/client";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { currentUserId } from "../middleware/auth";
import { ok, paginated } from "../utils/http";
import { encryptJson, describeKey } from "../utils/crypto";
import { AppError, ERROR_CODES, NotFoundError } from "../utils/errors";
import {
  exportUserData,
  getOrCreateSettings,
  getPrivacySummary,
  settingsPatchSchema,
  updateSettings,
} from "../services/settings/settings.service";
import { listIntegrationStatus } from "../services/notifications/integration-resolver";
import { listAuditLogs, AUDIT_ACTIONS, recordAudit } from "../services/audit/audit.service";
import { purgeUserEmailData, runRetentionSweep } from "../services/cleanup/cleanup.service";
import { getQueueHealth } from "../queues";
import { checkDatabase } from "../config/prisma";
import { checkRedis } from "../config/redis";

export async function getSettings(req: Request, res: Response) {
  const userId = currentUserId(req);
  const [user, settings, integrations] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, timezone: true, isDemo: true, createdAt: true },
    }),
    getOrCreateSettings(userId),
    listIntegrationStatus(userId),
  ]);

  if (!user) throw new NotFoundError("User");

  return ok(res, {
    account: user,
    settings,
    integrations,
    capabilities: {
      gmailConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      slackConfigured: Boolean(env.SLACK_WEBHOOK_URL),
      whatsappConfigured: Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
      voiceConfigured: Boolean(env.VOICE_ACCOUNT_SID && env.VOICE_AUTH_TOKEN && env.VOICE_FROM_NUMBER),
      aiProvider: env.AI_PROVIDER,
      voiceOptInRequired: true,
    },
    limits: {
      scanIntervalMinutes: { min: 15, max: 1440 },
      voiceMaxCallsPerDay: { min: 0, max: 10 },
      dataRetentionDays: { min: 7, max: 3650 },
      escalationDelaysMinutes: { min: 1, max: 1440, maxStages: 5 },
    },
  });
}

export async function patchSettings(req: Request, res: Response) {
  const userId = currentUserId(req);
  const patch = req.body as z.infer<typeof settingsPatchSchema>;
  const settings = await updateSettings(userId, patch);
  return ok(res, settings);
}

export const integrationKindSchema = z.object({
  kind: z.enum(["SLACK", "WHATSAPP", "VOICE", "EMAIL", "AI"]),
});

export const integrationUpdateSchema = z.object({
  displayName: z.string().trim().max(120).optional(),
  /** Non-secret configuration (channel ids, phone numbers, recipients). */
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Secret material. Encrypted before storage; never echoed back. */
  secrets: z.record(z.string().max(2000)).optional(),
  status: z.enum(["CONNECTED", "DISCONNECTED", "ERROR", "PENDING"]).optional(),
  verify: z.boolean().optional(),
});

export async function updateIntegration(req: Request, res: Response) {
  const userId = currentUserId(req);
  const kind = req.params.kind as IntegrationKind;
  const body = req.body as z.infer<typeof integrationUpdateSchema>;

  let status = body.status ?? "CONNECTED";
  let lastError: string | null = null;

  // Optional liveness verification so a bad token fails at configuration time
  // rather than silently at 3am during an escalation.
  if (body.verify && kind === "SLACK") {
    const webhookUrl = String(body.secrets?.webhookUrl ?? "");
    if (!webhookUrl) {
      throw new AppError("A Slack webhook URL is required to verify the connection", {
        statusCode: 422,
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "MailOps connection test — your Slack alerts are wired up." }),
      });
      if (!response.ok) {
        status = "ERROR";
        lastError = `Slack rejected the webhook (HTTP ${response.status})`;
      }
    } catch (error) {
      status = "ERROR";
      lastError = error instanceof Error ? error.message : "Slack could not be reached";
    }
  }

  const existing = await prisma.integration.findUnique({ where: { userId_kind: { userId, kind } } });

  const secretsEnc = body.secrets
    ? encryptJson({ ...((existing?.secretsEnc ? safeParse(existing.secretsEnc) : {}) as object), ...body.secrets })
    : (existing?.secretsEnc ?? null);

  const integration = await prisma.integration.upsert({
    where: { userId_kind: { userId, kind } },
    create: {
      userId,
      kind,
      status,
      displayName: body.displayName ?? null,
      config: (body.config ?? {}) as object,
      secretsEnc,
      lastVerifiedAt: body.verify ? new Date() : null,
      lastError,
      lastErrorAt: lastError ? new Date() : null,
    },
    update: {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.config ? { config: body.config as object } : {}),
      ...(body.secrets ? { secretsEnc } : {}),
      status,
      ...(body.verify ? { lastVerifiedAt: new Date() } : {}),
      lastError,
      lastErrorAt: lastError ? new Date() : null,
    },
  });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.integrationUpdated,
    entityType: "Integration",
    entityId: integration.id,
    summary: `${kind} integration ${status.toLowerCase()}`,
    metadata: { kind, status, verified: Boolean(body.verify), configKeys: Object.keys(body.config ?? {}) },
  });

  return ok(res, {
    kind: integration.kind,
    status: integration.status,
    displayName: integration.displayName,
    lastError: integration.lastError,
    lastVerifiedAt: integration.lastVerifiedAt,
    // Never return secrets.
    hasCredentials: Boolean(integration.secretsEnc),
  });
}

function safeParse(payload: string): Record<string, unknown> {
  // Existing secrets are opaque here; they are decrypted only for delivery.
  return {};
}

export async function disconnectIntegration(req: Request, res: Response) {
  const userId = currentUserId(req);
  const kind = req.params.kind as IntegrationKind;

  await prisma.integration.upsert({
    where: { userId_kind: { userId, kind } },
    create: { userId, kind, status: "DISCONNECTED" },
    update: { status: "DISCONNECTED", secretsEnc: null, lastError: null },
  });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.integrationUpdated,
    entityType: "Integration",
    summary: `${kind} disconnected and its credentials deleted`,
    metadata: { kind },
  });

  return ok(res, { disconnected: true, kind });
}

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().max(120).optional(),
  actor: z.enum(["AI", "SYSTEM", "USER"]).optional(),
  entityType: z.string().max(64).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/** The audit trail: every automated action MailOps took, in order. */
export async function auditLog(req: Request, res: Response) {
  const userId = currentUserId(req);
  const query = req.query as unknown as z.infer<typeof auditQuerySchema>;

  const { items, page } = await listAuditLogs(userId, {
    page: query.page,
    pageSize: query.pageSize,
    action: query.action,
    actor: query.actor,
    entityType: query.entityType,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  });

  return paginated(res, items, page);
}

export async function privacy(req: Request, res: Response) {
  const userId = currentUserId(req);
  return ok(res, await getPrivacySummary(userId));
}

export async function exportData(req: Request, res: Response) {
  const userId = currentUserId(req);
  const data = await exportUserData(userId);

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.dataPurged,
    entityType: "User",
    entityId: userId,
    summary: "Data export downloaded",
  });

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="mailops-export-${Date.now()}.json"`);
  return res.status(200).send(JSON.stringify(data, null, 2));
}

export const deleteDataSchema = z.object({
  keepApplicationHistory: z.boolean().default(true),
});

export async function deleteEmailData(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = (req.body ?? { keepApplicationHistory: true }) as z.infer<typeof deleteDataSchema>;
  const result = await purgeUserEmailData(userId, body);
  return ok(res, result);
}

export async function retentionSweep(req: Request, res: Response) {
  const userId = currentUserId(req);
  const result = await runRetentionSweep(userId);
  return ok(res, result);
}

/** Admin-ish diagnostics. Never exposes secrets; only presence + fingerprints. */
export async function diagnostics(_req: Request, res: Response) {
  const [database, redis, queues] = await Promise.all([checkDatabase(), checkRedis(), getQueueHealth()]);
  return ok(res, {
    database,
    redis,
    queues,
    encryption: describeKey(),
    ai: { provider: env.AI_PROVIDER, configured: env.AI_PROVIDER === "heuristic" || Boolean(env.AI_API_KEY) },
    environment: env.NODE_ENV,
  });
}
