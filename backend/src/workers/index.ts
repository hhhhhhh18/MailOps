import type { Worker } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { checkDatabase, disconnectDatabase } from "../config/prisma";
import { checkRedis, disconnectRedis } from "../config/redis";
import { closeQueues } from "../queues";
import { createEmailScanWorker, attachScanLogging } from "./email-scan.worker";
import { createEmailProcessingWorker, attachEmailProcessingLogging } from "./email-processing.worker";
import {
  createApplicationProcessingWorker,
  attachApplicationProcessingLogging,
} from "./application-processing.worker";
import { createNotificationWorker, attachNotificationLogging } from "./notification.worker";
import { createEscalationWorker, attachEscalationLogging } from "./escalation.worker";
import { createCleanupWorker, attachCleanupLogging } from "./cleanup.worker";
import { startScheduler } from "./scheduler";

/**
 * Worker runtime entrypoint.
 *
 * Runs all six queues in one process for simplicity in development and small
 * deployments. Each worker is created independently, so in production you can run
 * several copies of this file (they share the queues and BullMQ distributes jobs)
 * or split them per queue by passing a list of enabled queue names.
 */
async function main(): Promise<void> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  if (!database.ok) {
    logger.fatal({ err: database.error }, "workers cannot start: database unavailable");
    process.exit(1);
  }
  if (!redis.ok) {
    logger.fatal({ err: redis.error }, "workers cannot start: redis unavailable");
    process.exit(1);
  }

  const workers: Worker[] = [];

  const scanWorker = createEmailScanWorker();
  attachScanLogging(scanWorker);
  workers.push(scanWorker);

  const emailWorker = createEmailProcessingWorker();
  attachEmailProcessingLogging(emailWorker);
  workers.push(emailWorker);

  const applicationWorker = createApplicationProcessingWorker();
  attachApplicationProcessingLogging(applicationWorker);
  workers.push(applicationWorker);

  const notificationWorker = createNotificationWorker();
  attachNotificationLogging(notificationWorker);
  workers.push(notificationWorker);

  const escalationWorker = createEscalationWorker();
  attachEscalationLogging(escalationWorker);
  workers.push(escalationWorker);

  const cleanupWorker = createCleanupWorker();
  attachCleanupLogging(cleanupWorker);
  workers.push(cleanupWorker);

  const scheduler = startScheduler();

  logger.info(
    {
      queues: workers.length,
      concurrency: env.WORKER_CONCURRENCY,
      schedulerEnabled: env.SCHEDULER_ENABLED,
      aiProvider: env.AI_PROVIDER,
    },
    "MailOps workers started",
  );

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down workers");

    const forceExit = setTimeout(() => {
      logger.error("graceful worker shutdown timed out; forcing exit");
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    scheduler.stop();

    try {
      // close() waits for in-flight jobs to finish, which is what protects a
      // cleanup batch or a status transition from being cut in half.
      await Promise.all(workers.map((worker) => worker.close()));
      await closeQueues();
      await disconnectRedis();
      await disconnectDatabase();
      logger.info("worker shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: (error as Error).message }, "error during worker shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, "unhandled rejection in worker");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error.message, stack: error.stack }, "uncaught exception in worker; exiting");
    void shutdown("uncaughtException");
  });
}

void main().catch((error) => {
  logger.fatal({ err: error instanceof Error ? error.message : String(error) }, "failed to start MailOps workers");
  process.exit(1);
});
