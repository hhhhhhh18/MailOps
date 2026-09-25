import { Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { JOBS, QUEUES } from "../config/constants";
import { analyzeEmail } from "../services/ai/analysis.service";
import { enqueueApplicationUpdate } from "../queues";
import { skippedForDeletedAccount, userStillExists } from "../services/account/worker-guard";
import { describeError } from "../utils/errors";

export interface ProcessEmailJobData {
  emailId: string;
  userId: string;
  force?: boolean;
}

/**
 * email-processing worker (UNDERSTAND + DECIDE).
 *
 * Classifies, extracts, summarises and decides for a single email, then hands off
 * to application-processing. Kept separate from memory/action so that a failure
 * here can be retried without risking duplicate applications.
 */
export function createEmailProcessingWorker(): Worker {
  return new Worker(
    QUEUES.emailProcessing,
    async (job: Job<ProcessEmailJobData>) => {
      const { emailId, userId, force } = job.data;

      // The account may have been erased after this job was queued. Analysing the
      // email would spend AI quota on a deleted user and then try to write rows whose
      // FK is gone, so stop before doing either.
      if (!(await userStillExists(userId))) {
        logger.info({ jobId: job.id, emailId }, "skipping email processing for a deleted account");
        return skippedForDeletedAccount();
      }

      const startedAt = Date.now();

      const outcome = await analyzeEmail(emailId, { force });

      if (outcome.skipped) {
        logger.debug({ emailId }, "email already processed; skipping");
        return { skipped: true, emailId };
      }

      // Only job-related mail can create or update an application.
      if (outcome.category === "JOB" && outcome.analysisId) {
        await enqueueApplicationUpdate({ userId, emailId, analysisId: outcome.analysisId });
      }

      return {
        emailId,
        category: outcome.category,
        subCategory: outcome.subCategory,
        confidence: outcome.confidence,
        needsReview: outcome.needsReview,
        durationMs: Date.now() - startedAt,
      };
    },
    {
      connection: redis,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );
}

export function attachEmailProcessingLogging(worker: Worker): void {
  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, emailId: job?.data?.emailId, attempts: job?.attemptsMade, ...describeError(error) },
      "email processing job failed",
    );
  });
  worker.on("completed", (job, result) => {
    logger.debug({ jobId: job.id, result }, "email processing job completed");
  });
}

export { JOBS };
