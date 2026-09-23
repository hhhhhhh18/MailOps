import { Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { QUEUES } from "../config/constants";
import { evaluateEscalation } from "../services/notifications/escalation.service";
import { describeError } from "../utils/errors";

export interface EscalationJobData {
  notificationId: string;
  stage: number;
}

/**
 * escalation worker.
 *
 * Each job represents "check whether the user acknowledged; if not, escalate to
 * the next channel". The delay is the escalation timer, which is why this runs as
 * a separate queue from notification delivery: a delayed job surviving a restart
 * is exactly the guarantee the product needs.
 */
export function createEscalationWorker(): Worker {
  return new Worker(
    QUEUES.escalation,
    async (job: Job<EscalationJobData>) => {
      const outcome = await evaluateEscalation(job.data.notificationId, job.data.stage);
      logger.info(
        {
          notificationId: outcome.notificationId,
          action: outcome.action,
          channel: outcome.channel,
          stage: outcome.stage,
          nextStage: outcome.nextStage,
          reason: outcome.reason,
        },
        "escalation evaluated",
      );
      return outcome;
    },
    {
      connection: redis,
      concurrency: Math.max(2, env.WORKER_CONCURRENCY),
    },
  );
}

export function attachEscalationLogging(worker: Worker): void {
  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, notificationId: job?.data?.notificationId, stage: job?.data?.stage, ...describeError(error) },
      "escalation job failed",
    );
  });
}
