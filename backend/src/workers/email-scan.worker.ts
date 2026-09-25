import { Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { QUEUES } from "../config/constants";
import { scanGmailAccount } from "../services/gmail/sync.service";
import { skippedForDeletedAccount, userStillExists } from "../services/account/worker-guard";
import { describeError, isAppError } from "../utils/errors";

export interface ScanJobData {
  userId: string;
  gmailAccountId: string;
  type: "INITIAL" | "SCHEDULED" | "MANUAL";
  triggeredBy?: string;
  fullRescan?: boolean;
}

/**
 * email-scan worker (OBSERVE).
 *
 * The only place that talks to the Gmail API to read new messages. It never
 * performs AI analysis — it stores normalised metadata and enqueues one
 * processing job per new message, which keeps a long scan from blocking anything.
 */
export function createEmailScanWorker(): Worker {
  return new Worker(
    QUEUES.emailScan,
    async (job: Job<ScanJobData>) => {
      /**
       * The account may have been erased after this scan was queued. Scanning would
       * read the mailbox and re-ingest messages for a user who no longer exists, so
       * stop here rather than let the FK violation do it.
       */
      if (!(await userStillExists(job.data?.userId))) {
        logger.info({ jobId: job.id }, "skipping scan for a deleted account");
        return skippedForDeletedAccount();
      }

      const startedAt = Date.now();
      const outcome = await scanGmailAccount(job.data);
      logger.info({ ...outcome, durationMs: Date.now() - startedAt }, "scan job completed");
      return outcome;
    },
    {
      // Scans are I/O bound and quota limited; a low concurrency avoids Gmail 429s.
      // Retry policy comes from the queue's defaultJobOptions (see queues/index.ts).
      connection: redis,
      concurrency: Math.max(1, Math.min(2, env.WORKER_CONCURRENCY)),
    },
  );
}

export function attachScanLogging(worker: Worker): void {
  worker.on("failed", (job, error) => {
    const data = job?.data as ScanJobData | undefined;
    logger.error(
      { jobId: job?.id, accountId: data?.gmailAccountId, attempts: job?.attemptsMade, ...describeError(error) },
      "scan job failed",
    );

    // A revoked credential is not retryable — log it as an actionable event rather
    // than letting BullMQ burn five attempts.
    if (isAppError(error) && (error.code === "GMAIL_CONNECTION_EXPIRED" || error.code === "GMAIL_NOT_CONNECTED")) {
      logger.warn({ accountId: data?.gmailAccountId }, "scan requires the user to reconnect Gmail");
    }
  });
}
