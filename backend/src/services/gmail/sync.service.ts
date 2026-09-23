import type { GmailAccount, ScanJob, UserSettings } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { addMinutes } from "../../utils/dates";
import { AppError, describeError, ERROR_CODES, IntegrationError, NotFoundError } from "../../utils/errors";
import { enqueueProcessEmail } from "../../queues";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import { GmailClient, buildScanQuery } from "./client";
import { minimizeMessage } from "./normalizer";

export interface ScanOptions {
  userId: string;
  gmailAccountId: string;
  type: "INITIAL" | "SCHEDULED" | "MANUAL";
  triggeredBy?: string;
  /** Ignore the stored history cursor and rescan the lookback window. */
  fullRescan?: boolean;
}

export interface ScanOutcome {
  scanJobId: string;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  messagesScanned: number;
  messagesNew: number;
  messagesQueued: number;
  messagesSkipped: number;
  error: string | null;
}

/**
 * Background email scan.
 *
 * Idempotency guarantees:
 *  - message-level: `@@unique([userId, gmailMessageId])` plus an in-run dedupe set,
 *    so re-running a scan can never create a duplicate Email row.
 *  - job-level: a stable BullMQ job id (`scan:<account>:<type>`) collapses racing scans.
 *  - cursor-level: the Gmail historyId is only advanced after a scan succeeds, so a
 *    failure causes a safe re-read rather than a silent gap.
 */
export async function scanGmailAccount(options: ScanOptions): Promise<ScanOutcome> {
  const account = await prisma.gmailAccount.findFirst({
    where: { id: options.gmailAccountId, userId: options.userId },
    include: { user: { include: { settings: true } } },
  });

  if (!account) throw new NotFoundError("Gmail account");
  if (account.status === "DISCONNECTED") {
    throw new AppError("This Gmail account is disconnected. Reconnect it to resume scanning.", {
      statusCode: 409,
      code: ERROR_CODES.GMAIL_NOT_CONNECTED,
    });
  }
  if (account.status === "EXPIRED") {
    throw new AppError("Gmail access has expired. Please reconnect your Gmail account.", {
      statusCode: 409,
      code: ERROR_CODES.GMAIL_CONNECTION_EXPIRED,
    });
  }

  const settings = account.user.settings;
  const scanJob = await prisma.scanJob.create({
    data: {
      userId: options.userId,
      gmailAccountId: account.id,
      type: options.type,
      status: "RUNNING",
      startedAt: new Date(),
      triggeredBy: options.triggeredBy ?? "scheduler",
    },
  });

  await recordAudit({
    userId: options.userId,
    actor: "SYSTEM",
    action: AUDIT_ACTIONS.gmailScanStarted,
    entityType: "ScanJob",
    entityId: scanJob.id,
    summary: `${options.type} scan started`,
    metadata: { type: options.type, triggeredBy: options.triggeredBy ?? "scheduler" },
  });

  const startedAt = Date.now();

  try {
    const client = await GmailClient.forAccount(account);
    const profile = await client.getProfile();

    const { ids, usedHistory } = await collectCandidateIds(client, account, options);
    const max = env.GMAIL_MAX_MESSAGES_PER_SCAN;
    const bounded = ids.slice(0, max);

    const existing = bounded.length
      ? await prisma.email.findMany({
          where: { userId: options.userId, gmailMessageId: { in: bounded } },
          select: { gmailMessageId: true },
        })
      : [];
    const known = new Set(existing.map((e) => e.gmailMessageId));
    const newIds = bounded.filter((id) => !known.has(id));

    let created = 0;
    let queued = 0;

    if (newIds.length) {
      const { messages, failedIds } = await client.getMessages(newIds);
      const storeBody = settings?.storeEmailBody ?? true;

      for (const raw of messages) {
        const message = minimizeMessage(raw, storeBody);
        try {
          const email = await prisma.email.create({
            data: {
              userId: options.userId,
              gmailAccountId: account.id,
              gmailMessageId: message.gmailMessageId,
              gmailThreadId: message.gmailThreadId,
              fromName: message.fromName,
              fromEmail: message.fromEmail,
              toEmail: message.toEmail,
              subject: message.subject,
              snippet: message.snippet,
              bodyText: message.bodyText,
              receivedAt: message.receivedAt,
              labels: message.labels,
              hasAttachments: message.hasAttachments,
              sizeEstimate: message.sizeEstimate,
              isImportant: message.isImportant,
              isUnread: message.isUnread,
              threadKey: message.threadKey,
              processingState: "QUEUED",
            },
            select: { id: true },
          });
          created += 1;
          const jobId = await enqueueProcessEmail({ emailId: email.id, userId: options.userId });
          if (jobId) queued += 1;
        } catch (error) {
          // P2002 = another scan inserted the same message first. That is exactly
          // the idempotent behaviour we want.
          if (isUniqueViolation(error)) continue;
          logger.warn({ gmailMessageId: message.gmailMessageId, ...describeError(error) }, "failed to store email");
        }
      }

      if (failedIds.length) {
        logger.warn({ count: failedIds.length, accountId: account.id }, "some messages could not be fetched");
      }
    }

    const status: ScanOutcome["status"] = bounded.length >= max ? "PARTIAL" : "COMPLETED";

    await prisma.scanJob.update({
      where: { id: scanJob.id },
      data: {
        status,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        messagesScanned: bounded.length,
        messagesNew: created,
        messagesQueued: queued,
        messagesSkipped: known.size,
        cursor: profile.historyId ?? account.historyId,
      },
    });

    // Advance the cursor only on success.
    await prisma.gmailAccount.update({
      where: { id: account.id },
      data: {
        lastSyncAt: new Date(),
        historyId: profile.historyId ?? account.historyId,
        status: "CONNECTED",
        lastError: null,
        lastErrorAt: null,
      },
    });

    await recordAudit({
      userId: options.userId,
      actor: "SYSTEM",
      action: AUDIT_ACTIONS.gmailScanCompleted,
      entityType: "ScanJob",
      entityId: scanJob.id,
      summary: `Scanned ${bounded.length} message${bounded.length === 1 ? "" : "s"}, ${created} new`,
      metadata: { usedHistory, messagesNew: created, messagesQueued: queued, messagesSkipped: known.size, status },
    });

    logger.info(
      { accountId: account.id, scanned: bounded.length, created, queued, usedHistory, status },
      "gmail scan finished",
    );

    return {
      scanJobId: scanJob.id,
      status,
      messagesScanned: bounded.length,
      messagesNew: created,
      messagesQueued: queued,
      messagesSkipped: known.size,
      error: null,
    };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Gmail scan failed";

    await prisma.scanJob.update({
      where: { id: scanJob.id },
      data: { status: "FAILED", finishedAt: new Date(), durationMs: Date.now() - startedAt, error: message },
    });

    await prisma.gmailAccount.update({
      where: { id: account.id },
      data: { lastError: message, lastErrorAt: new Date() },
    });

    await recordAudit({
      userId: options.userId,
      actor: "SYSTEM",
      action: AUDIT_ACTIONS.gmailScanFailed,
      entityType: "ScanJob",
      entityId: scanJob.id,
      summary: message,
    });

    logger.error({ accountId: account.id, ...describeError(error) }, "gmail scan failed");
    throw error;
  }
}

/**
 * Picks candidate message ids. Prefers the incremental history feed; falls back
 * to a bounded full query when there is no cursor or it has expired.
 */
async function collectCandidateIds(
  client: GmailClient,
  account: GmailAccount,
  options: ScanOptions,
): Promise<{ ids: string[]; usedHistory: boolean }> {
  const shouldUseHistory = !options.fullRescan && options.type !== "INITIAL" && Boolean(account.historyId);

  if (shouldUseHistory && account.historyId) {
    const page = await client.listHistory(account.historyId);
    if (!page.expired) {
      return { ids: page.messageIds, usedHistory: true };
    }
    logger.info({ accountId: account.id }, "gmail history cursor expired; falling back to a bounded rescan");
  }

  const ids: string[] = [];
  let pageToken: string | null = null;
  const query = buildScanQuery({
    lookbackDays: options.type === "INITIAL" ? Math.max(env.GMAIL_SYNC_LOOKBACK_DAYS, 180) : env.GMAIL_SYNC_LOOKBACK_DAYS,
  });

  for (let page = 0; page < 5; page += 1) {
    const result = await client.listMessageIds(query, { maxResults: 100, pageToken });
    ids.push(...result.ids);
    pageToken = result.nextPageToken;
    if (!pageToken || ids.length >= env.GMAIL_MAX_MESSAGES_PER_SCAN) break;
  }

  return { ids: Array.from(new Set(ids)), usedHistory: false };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "P2002");
}

/** -------------------------------------------------------------------------- */
/** Scan scheduling helpers (dashboard "last scan / next scan" panel)            */
/** -------------------------------------------------------------------------- */

export interface ScanSchedule {
  lastScanAt: Date | null;
  lastScanStatus: string | null;
  lastScanDurationMs: number | null;
  lastScanError: string | null;
  nextScanAt: Date | null;
  intervalMinutes: number;
  scanningEnabled: boolean;
  scannedMessagesLast24h: number;
}

export async function getScanSchedule(userId: string): Promise<ScanSchedule> {
  const [settings, account, lastJob, recentCount] = await Promise.all([
    prisma.userSettings.findUnique({ where: { userId } }),
    prisma.gmailAccount.findFirst({ where: { userId, status: { not: "DISCONNECTED" } }, orderBy: { createdAt: "desc" } }),
    prisma.scanJob.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.email.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
  ]);

  const intervalMinutes = settings?.scanIntervalMinutes ?? 210;
  const scanningEnabled = (settings?.scanningEnabled ?? true) && Boolean(account);
  const lastScanAt = account?.lastSyncAt ?? lastJob?.finishedAt ?? null;
  const nextScanAt = scanningEnabled && lastScanAt ? addMinutes(lastScanAt, intervalMinutes) : null;

  return {
    lastScanAt,
    lastScanStatus: lastJob?.status ?? null,
    lastScanDurationMs: lastJob?.durationMs ?? null,
    lastScanError: lastJob?.error ?? account?.lastError ?? null,
    nextScanAt: nextScanAt && nextScanAt.getTime() < Date.now() ? new Date() : nextScanAt,
    intervalMinutes,
    scanningEnabled,
    scannedMessagesLast24h: recentCount,
  };
}

/** Runs a scan immediately on the user's behalf (manual "Scan now"). */
export async function requestManualScan(userId: string): Promise<{ accountId: string }> {
  const account = await prisma.gmailAccount.findFirst({
    where: { userId, status: { in: ["CONNECTED", "ERROR"] } },
    orderBy: { createdAt: "desc" },
  });

  if (!account) {
    throw new AppError("Connect a Gmail account before scanning.", {
      statusCode: 409,
      code: ERROR_CODES.GMAIL_NOT_CONNECTED,
    });
  }

  return { accountId: account.id };
}

export async function getScanJobs(userId: string, limit = 20): Promise<ScanJob[]> {
  return prisma.scanJob.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit });
}

export function defaultSettingsShape(settings: UserSettings | null) {
  return {
    scanIntervalMinutes: settings?.scanIntervalMinutes ?? 210,
    storeEmailBody: settings?.storeEmailBody ?? true,
    dataRetentionDays: settings?.dataRetentionDays ?? 365,
  };
}

export { IntegrationError };
