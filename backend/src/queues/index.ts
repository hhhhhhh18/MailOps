import { Queue, type Job, type JobsOptions, type JobType } from "bullmq";
import { DEFAULT_JOB_OPTIONS, JOBS, QUEUES } from "../config/constants";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { describeError, QueueUnavailableError } from "../utils/errors";

/**
 * BullMQ queue registry.
 *
 * Queue producers degrade gracefully: a Redis outage must not take down the API
 * (product rule #35). Interactive endpoints surface a 503 so the user knows the
 * action did not take effect; background producers log and drop, and the next
 * scheduled sweep picks the work up again.
 */

const globalForQueues = globalThis as unknown as { mailopsQueues?: Map<string, Queue> };

const registry: Map<string, Queue> = globalForQueues.mailopsQueues ?? new Map();
if (!globalForQueues.mailopsQueues) globalForQueues.mailopsQueues = registry;

function getQueue(name: string): Queue {
  const existing = registry.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: redis,
    defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
  });
  queue.on("error", (error) => {
    logger.warn({ queue: name, err: (error as Error).message }, "queue error");
  });
  registry.set(name, queue);
  return queue;
}

export const queues = {
  get emailScan() {
    return getQueue(QUEUES.emailScan);
  },
  get emailProcessing() {
    return getQueue(QUEUES.emailProcessing);
  },
  get applicationProcessing() {
    return getQueue(QUEUES.applicationProcessing);
  },
  get notification() {
    return getQueue(QUEUES.notification);
  },
  get cleanup() {
    return getQueue(QUEUES.cleanup);
  },
  get escalation() {
    return getQueue(QUEUES.escalation);
  },
};

export interface EnqueueOptions {
  /** Interactive requests must fail loudly; background jobs must not. */
  required?: boolean;
  jobId?: string;
  delayMs?: number;
  attempts?: number;
}

async function add(queueName: string, jobName: string, data: Record<string, unknown>, options: EnqueueOptions = {}) {
  const queue = getQueue(queueName);
  try {
    const job = await queue.add(jobName, data, {
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
      ...(options.attempts ? { attempts: options.attempts } : {}),
    });
    logger.debug({ queue: queueName, job: jobName, id: job.id }, "job enqueued");
    return job.id ?? null;
  } catch (error) {
    logger.error({ queue: queueName, job: jobName, ...describeError(error) }, "failed to enqueue job");
    if (options.required) {
      throw new QueueUnavailableError();
    }
    return null;
  }
}

/** -------------------------------------------------------------------------- */
/** Typed producers                                                             */
/** -------------------------------------------------------------------------- */

export function enqueueAccountScan(
  data: { userId: string; gmailAccountId: string; type: "SCHEDULED" | "MANUAL" | "INITIAL"; triggeredBy?: string; fullRescan?: boolean },
  options: EnqueueOptions = {},
) {
  // A stable job id per (account, type) prevents duplicate scans piling up when
  // the scheduler and a manual refresh race.
  const jobId = options.jobId ?? `scan:${data.gmailAccountId}:${data.type}`;
  return add(QUEUES.emailScan, JOBS.scanAccount, data, { ...options, jobId });
}

export function enqueueProcessEmail(data: { emailId: string; userId: string; force?: boolean }, options: EnqueueOptions = {}) {
  return add(QUEUES.emailProcessing, JOBS.processEmail, data, {
    ...options,
    // Idempotency at the queue level: one in-flight processing job per email.
   jobId: options.jobId ?? `email-${data.emailId}${data.force ? `-${Date.now()}` : ""}`,
  });
}

export function enqueueApplicationUpdate(
  data: { userId: string; emailId: string; applicationId?: string | null; analysisId: string },
  options: EnqueueOptions = {},
) {
  return add(QUEUES.applicationProcessing, JOBS.updateApplication, data, options);
}

export function enqueueNotification(data: { notificationId: string }, options: EnqueueOptions = {}) {
  return add(QUEUES.notification, JOBS.dispatchChannel, data, options);
}

export function enqueueEscalationEvaluation(data: { notificationId: string; stage: number }, options: EnqueueOptions = {}) {
  return add(QUEUES.escalation, JOBS.evaluateEscalation, data, {
    ...options,
    // Deterministic id so a re-scheduled stage replaces rather than duplicates.
    jobId: options.jobId ?? `esc:${data.notificationId}:${data.stage}`,
  });
}

export function enqueueCleanup(data: { userId: string; batchId?: string; emailIds?: string[]; action?: string }, options: EnqueueOptions = {}) {
  return add(QUEUES.cleanup, JOBS.executeCleanup, data, options);
}

export function enqueueCleanupProposal(data: { userId: string }, options: EnqueueOptions = {}) {
  return add(QUEUES.cleanup, JOBS.proposeCleanup, data, options);
}

export function enqueueRetentionSweep(data: { userId?: string } = {}, options: EnqueueOptions = {}) {
  return add(QUEUES.cleanup, JOBS.retentionSweep, data, options);
}

/** -------------------------------------------------------------------------- */
/** Introspection (used by the health endpoint and the dashboard scan panel)     */
/** -------------------------------------------------------------------------- */

export interface QueueHealth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  available: boolean;
  error?: string;
}

export async function getQueueHealth(): Promise<QueueHealth[]> {
  const results: QueueHealth[] = [];
  for (const [name, queue] of registry) {
    try {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
      results.push({
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
        available: true,
      });
    } catch (error) {
      results.push({
        name,
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
        available: false,
        error: (error as Error).message,
      });
    }
  }
  return results;
}

export async function closeQueues(): Promise<void> {
  const closers = Array.from(registry.values()).map((queue) => queue.close().catch(() => undefined));
  await Promise.all(closers);
  registry.clear();
}

/** -------------------------------------------------------------------------- */
/** Account deletion: purge everything user-identifiable outside PostgreSQL      */
/** -------------------------------------------------------------------------- */

/**
 * Queues whose job payloads carry a `userId`, and therefore user-identifiable data.
 *
 * `notification` and `escalation` are deliberately absent: their payloads contain
 * only an opaque notification id, and their workers already no-op when the
 * underlying row is gone (see dispatcher.service.ts). There is nothing
 * user-identifiable to purge, and enumerating them would risk touching a job that
 * belongs to someone else.
 */
const PII_BEARING_QUEUES = [
  QUEUES.emailScan,
  QUEUES.emailProcessing,
  QUEUES.applicationProcessing,
  QUEUES.cleanup,
] as const;

/**
 * States a job may be sitting in. `active` is included so a job that is stuck
 * mid-flight is also removed rather than left to finish against a deleted account.
 */
const JOB_STATES: JobType[] = ["waiting", "delayed", "active", "failed", "completed", "paused", "wait"];

export interface QueuePurgeResult {
  /** Queue name → number of jobs removed. */
  removedByQueue: Record<string, number>;
  totalRemoved: number;
  failures: string[];
}

/**
 * Removes every job belonging to `userId` from the PII-bearing queues.
 *
 * Deliberately enumerates real job payloads instead of reconstructing job ids. The
 * producers use several id shapes — `email:{id}`, `email:{id}:{timestamp}` for a
 * forced reprocess, `scan:{account}:{type}` — and most cleanup jobs carry no
 * explicit id at all, so an id-based approach silently misses jobs. That is exactly
 * the flaw in the `obliterateUserJobs(emailId)` helper this replaces: it removed one
 * id shape from one queue and left everything else behind.
 *
 * Completed and failed jobs are included on purpose: retained job bodies
 * (`removeOnComplete`/`removeOnFail` keep the last N) would otherwise hold the
 * userId and emailId in Redis indefinitely.
 *
 * Never touches a job whose payload belongs to another user.
 */
export async function purgeUserQueueData(userId: string): Promise<QueuePurgeResult> {
  const removedByQueue: Record<string, number> = {};
  const failures: string[] = [];
  let totalRemoved = 0;

  for (const queueName of PII_BEARING_QUEUES) {
    let removed = 0;

    let queue: Queue;
    try {
      queue = getQueue(queueName);
    } catch (error) {
      failures.push(`${queueName}: ${(error as Error).message}`);
      removedByQueue[queueName] = 0;
      continue;
    }

    for (const state of JOB_STATES) {
      let jobs: (Job | undefined)[] = [];
      try {
        jobs = await queue.getJobs([state], 0, 1000, true);
      } catch (error) {
        failures.push(`${queueName}/${state}: ${(error as Error).message}`);
        continue;
      }

      for (const job of jobs) {
        if (!job) continue;
        if ((job.data as { userId?: string } | undefined)?.userId !== userId) continue;

        try {
          await job.remove();
          removed += 1;
        } catch (error) {
          // An active job holds a lock and may refuse removal. Not fatal: the
          // worker-side existence guard stops it doing any work regardless.
          failures.push(`${queueName}/${state}/${job.id}: ${(error as Error).message}`);
        }
      }
    }

    removedByQueue[queueName] = removed;
    totalRemoved += removed;
  }

  return { removedByQueue, totalRemoved, failures };
}

/**
 * Deletes Redis keys that carry a userId *in the key name*.
 *
 * `voice:calls:{userId}:{date}` is the only such key today (escalation.service.ts).
 * The date suffix is why a pattern is used rather than one computed key: a deletion
 * can span midnight.
 */
export async function purgeUserRedisKeys(userId: string): Promise<{ removedKeys: number; failures: string[] }> {
  const failures: string[] = [];
  let removedKeys = 0;

  try {
    const keys = await redis.keys(`voice:calls:${userId}:*`);
    if (keys.length) removedKeys = await redis.del(...keys);
  } catch (error) {
    failures.push(`voice-calls: ${(error as Error).message}`);
  }

  return { removedKeys, failures };
}

/**
 * Everything user-identifiable that lives outside PostgreSQL, for one user.
 *
 * Best-effort and idempotent by design: it runs *after* the user row is already
 * gone, so a partial failure is recorded on the deletion receipt and can be retried
 * without the erasure itself being in any way affected.
 */
export async function purgeUserExternalData(userId: string): Promise<{
  queues: QueuePurgeResult;
  redisKeys: { removedKeys: number; failures: string[] };
  failures: string[];
}> {
  const queues = await purgeUserQueueData(userId);
  const redisKeys = await purgeUserRedisKeys(userId);
  return { queues, redisKeys, failures: [...queues.failures, ...redisKeys.failures] };
}
