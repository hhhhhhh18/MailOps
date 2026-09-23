import { Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { QUEUES } from "../config/constants";
import { dispatchNotification } from "../services/notifications/dispatcher.service";
import { describeError } from "../utils/errors";

export interface NotificationJobData {
  notificationId: string;
}

/**
 * notification worker (INFORM).
 *
 * Delivers a notification across its selected channels and arms the escalation
 * ladder. Channel failures are recorded per attempt and never thrown, so one
 * broken integration cannot cause the whole job to retry and double-send the
 * channels that did work.
 */
export function createNotificationWorker(): Worker {
  return new Worker(
    QUEUES.notification,
    async (job: Job<NotificationJobData>) => {
      const outcome = await dispatchNotification(job.data.notificationId);
      logger.info(
        {
          notificationId: outcome.notificationId,
          delivered: outcome.delivered,
          failed: outcome.failed,
          skipped: outcome.skipped,
          escalationArmed: outcome.escalationArmed,
        },
        "notification dispatched",
      );
      return outcome;
    },
    {
      connection: redis,
      concurrency: Math.max(2, env.WORKER_CONCURRENCY),
    },
  );
}

export function attachNotificationLogging(worker: Worker): void {
  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, notificationId: job?.data?.notificationId, ...describeError(error) },
      "notification dispatch job failed",
    );
  });
}
