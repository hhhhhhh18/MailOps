import { Queue, type JobsOptions } from "bullmq";
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
    jobId: options.jobId ?? `email:${data.emailId}${data.force ? `:${Date.now()}` : ""}`,
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

/** Targeted cleanup for the "delete my MailOps data" flow. */
export async function obliterateUserJobs(emailId: string): Promise<void> {
  try {
    await queues.emailProcessing.remove(`email:${emailId}`);
  } catch {
    // Job may already be gone; nothing to do.
  }
}
