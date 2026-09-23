import { createApp, reportDependencies } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { disconnectDatabase } from "./config/prisma";
import { disconnectRedis } from "./config/redis";
import { closeQueues } from "./queues";

/**
 * API entrypoint.
 *
 * Graceful shutdown is not optional for this product: an interruption mid-scan
 * could otherwise leave a ScanJob stuck in RUNNING and, worse, a cleanup batch
 * half-applied. The handlers below stop accepting connections, let in-flight
 * work drain, then close datastores.
 */
async function main(): Promise<void> {
  await reportDependencies();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        environment: env.NODE_ENV,
        aiProvider: env.AI_PROVIDER,
        webBaseUrl: env.WEB_BASE_URL,
      },
      "MailOps API listening",
    );
  });

  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    server.close(async () => {
      try {
        await closeQueues();
        await disconnectRedis();
        await disconnectDatabase();
        logger.info("shutdown complete");
        process.exit(0);
      } catch (error) {
        logger.error({ err: (error as Error).message }, "error during shutdown");
        process.exit(1);
      }
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, "unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error.message, stack: error.stack }, "uncaught exception; exiting");
    void shutdown("uncaughtException");
  });
}

void main().catch((error) => {
  logger.fatal({ err: error instanceof Error ? error.message : String(error) }, "failed to start MailOps API");
  process.exit(1);
});
