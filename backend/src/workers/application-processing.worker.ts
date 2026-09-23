import { Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { QUEUES } from "../config/constants";
import { processApplicationFromEmail } from "../services/applications/application-processing.service";
import { describeError } from "../utils/errors";

export interface ApplicationJobData {
  userId: string;
  emailId: string;
  applicationId?: string | null;
  analysisId: string;
}

/**
 * application-processing worker (REMEMBER + ACT).
 *
 * Owns the only code path that creates or mutates an Application. It runs in a
 * worker rather than the request/analysis path so that a slow AI matcher call
 * cannot stall inbox processing, and so retries are isolated from classification.
 */
export function createApplicationProcessingWorker(): Worker {
  return new Worker(
    QUEUES.applicationProcessing,
    async (job: Job<ApplicationJobData>) => {
      const startedAt = Date.now();
      const outcome = await processApplicationFromEmail(job.data);

      logger.info(
        {
          emailId: outcome.emailId,
          outcome: outcome.outcome,
          applicationId: outcome.applicationId,
          statusChanged: outcome.statusChanged,
          durationMs: Date.now() - startedAt,
        },
        "application processing completed",
      );

      return outcome;
    },
    {
      connection: redis,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );
}

export function attachApplicationProcessingLogging(worker: Worker): void {
  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, emailId: job?.data?.emailId, attempts: job?.attemptsMade, ...describeError(error) },
      "application processing job failed",
    );
  });
}
