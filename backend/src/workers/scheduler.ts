import { env } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../config/prisma";
import { redis } from "../config/redis";
import { addMinutes } from "../utils/dates";
import { describeError } from "../utils/errors";
import { enqueueAccountScan, enqueueCleanupProposal, enqueueRetentionSweep } from "../queues";
import { sweepOverdueEscalations } from "../services/notifications/escalation.service";

/**
 * Scheduler.
 *
 * A single tick loop rather than per-user repeatable jobs. That choice matters
 * for this product: scan intervals are per-user settings (default 3.5 hours) and
 * users change them, so a fixed repeatable job would either ignore the setting or
 * need constant re-registration. Here the tick simply asks "who is due?" using
 * the stored interval.
 *
 * The tick also acts as the safety net for escalation timers whose delayed job
 * was lost, and as the daily hook for retention and cleanup proposals.
 */

const TICK_MS = 5 * 60_000; // 5 minutes
const DAILY_HOUR_UTC = 3;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(): { stop: () => void; runOnce: () => Promise<void> } {
  if (!env.SCHEDULER_ENABLED) {
    logger.info("scheduler disabled by configuration");
    return { stop: () => undefined, runOnce: async () => undefined };
  }

  const tick = async () => {
    if (running) {
      logger.debug("scheduler tick skipped; previous tick still running");
      return;
    }
    running = true;
    try {
      await runTick();
    } catch (error) {
      // The scheduler must never die from a single bad tick.
      logger.error({ ...describeError(error) }, "scheduler tick failed");
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), TICK_MS);
  // Run once shortly after boot so a restarted process catches up promptly.
  setTimeout(() => void tick(), 10_000).unref();

  logger.info({ tickMs: TICK_MS }, "scheduler started");

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      logger.info("scheduler stopped");
    },
    runOnce: runTick,
  };
}

async function runTick(): Promise<void> {
  await scanDueAccounts();
  await sweepOverdueEscalations();
  await runDailyJobs();
}

/**
 * scan-all-accounts: enqueues a scan for every connected account whose interval
 * has elapsed. The job itself is deduplicated by a stable BullMQ job id, so a
 * racing manual scan cannot produce two concurrent scans of the same account.
 */
async function scanDueAccounts(): Promise<{ due: number; queued: number }> {
  const accounts = await prisma.gmailAccount.findMany({
    where: { status: { in: ["CONNECTED", "ERROR"] } },
    select: {
      id: true,
      userId: true,
      lastSyncAt: true,
      createdAt: true,
      user: { select: { settings: { select: { scanIntervalMinutes: true, scanningEnabled: true } } } },
    },
    take: 500,
  });

  const now = new Date();
  let due = 0;
  let queued = 0;

  for (const account of accounts) {
    const settings = account.user.settings;
    if (settings && !settings.scanningEnabled) continue;

    const intervalMinutes = settings?.scanIntervalMinutes ?? 210;
    const last = account.lastSyncAt ?? account.createdAt;
    const nextDue = addMinutes(last, intervalMinutes);

    if (nextDue.getTime() > now.getTime()) continue;
    due += 1;

    const jobId = await enqueueAccountScan({
      userId: account.userId,
      gmailAccountId: account.id,
      type: "SCHEDULED",
      triggeredBy: "scheduler",
    });

    if (jobId) queued += 1;
  }

  if (due > 0) logger.info({ due, queued }, "scheduler queued scans");
  return { due, queued };
}

/** Once-per-day maintenance, guarded by a Redis key so restarts cannot repeat it. */
async function runDailyJobs(): Promise<void> {
  if (new Date().getUTCHours() !== DAILY_HOUR_UTC) return;

  const dayKey = `scheduler:daily:${new Date().toISOString().slice(0, 10)}`;

  try {
    const already = await redis.get(dayKey);
    if (already) return;
    await redis.set(dayKey, "1", "EX", 86_400);
  } catch {
    // Without Redis we fall back to running the maintenance jobs; they are
    // idempotent, so an extra run is harmless.
  }

  logger.info("running daily maintenance jobs");
  await enqueueRetentionSweep({}, { jobId: `retention:${dayKey}` });

  const users = await prisma.userSettings.findMany({
    where: { scanningEnabled: true },
    select: { userId: true },
    take: 500,
  });

  for (const user of users) {
    await enqueueCleanupProposal({ userId: user.userId }, { jobId: `cleanup-proposal:${user.userId}:${dayKey}` });
  }
}
