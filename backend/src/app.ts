import express, { type Express } from "express";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { checkDatabase } from "./config/prisma";
import { checkRedis } from "./config/redis";
import { errorHandler, notFoundHandler, requestIdMiddleware } from "./middleware/error";
import { cookiesMiddleware, corsMiddleware, csrfMiddleware, globalRateLimit, securityHeaders } from "./middleware/security";
import { apiRouter } from "./routes";
import { ok } from "./utils/http";

/**
 * Express application factory.
 *
 * Middleware order matters and is deliberate:
 *   request id -> security headers -> CORS -> body parsing -> cookies ->
 *   rate limit -> CSRF -> routes -> 404 -> error handler
 */
export function createApp(): Express {
  const app = express();

  // Behind a load balancer the client IP arrives in X-Forwarded-For; trust exactly
  // one hop so rate limiting keys on the real client.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestIdMiddleware);
  app.use(securityHeaders);
  app.use(corsMiddleware);

  // Bounded body size: MailOps never accepts large uploads, and a 1mb cap limits
  // the blast radius of a malicious payload.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(cookiesMiddleware);
  app.use(globalRateLimit);
  app.use(csrfMiddleware);

  // ---------------------------------------------------------------------------
  // Health. Liveness must never touch a dependency; readiness reports them.
  // ---------------------------------------------------------------------------
  app.get("/health/live", (_req, res) => {
    res.status(200).json({ status: "ok", service: "mailops-api", uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get("/health", async (_req, res) => {
    const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
    const healthy = database.ok;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? (redis.ok ? "ok" : "degraded") : "unavailable",
      service: "mailops-api",
      version: "1.0.0",
      environment: env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: {
        database: database.ok ? "ok" : "unavailable",
        redis: redis.ok ? "ok" : "unavailable",
        aiProvider: env.AI_PROVIDER,
      },
      // Degraded is not down: without Redis the API still serves reads.
      degradedCapabilities: redis.ok ? [] : ["background scanning", "queued processing", "escalation timers"],
    });
  });

  app.get("/", (_req, res) => {
    res.status(200).json({
      name: "MailOps API",
      description: "AI job-application operations agent — API",
      docs: "/api/meta/taxonomy",
      health: "/health",
    });
  });

  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Startup dependency report used by the entrypoint. */
export async function reportDependencies(): Promise<{ database: boolean; redis: boolean }> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  if (!database.ok) logger.error({ err: database.error }, "database is unavailable at startup");
  if (!redis.ok) {
    logger.warn(
      { err: redis.error },
      "redis is unavailable at startup — the API will serve reads but queue-backed actions will fail",
    );
  }
  return { database: database.ok, redis: redis.ok };
}

export { ok };
