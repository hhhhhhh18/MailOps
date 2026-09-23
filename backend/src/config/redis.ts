import IORedis, { type Redis } from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

/**
 * Redis is used only as BullMQ transport + ephemeral rate-limit counters.
 * If Redis is unavailable the API still serves read endpoints; queue-producing
 * endpoints return 503 with a clear message instead of crashing the process.
 */

const globalForRedis = globalThis as unknown as { mailopsRedis?: Redis };

export const redisConnectionOptions = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as null, // required by BullMQ
  enableReadyCheck: false,
};

export function createRedisClient(role: string): Redis {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    lazyConnect: false,
  });

  client.on("error", (err) => {
    logger.warn({ err: err.message, role }, "redis connection error");
  });
  client.on("ready", () => {
    logger.debug({ role }, "redis ready");
  });

  return client;
}

export const redis = globalForRedis.mailopsRedis ?? createRedisClient("shared");
if (!globalForRedis.mailopsRedis) globalForRedis.mailopsRedis = redis;

/**
 * Bounds an operation that depends on a possibly-unreachable remote.
 *
 * ioredis queues commands while it is reconnecting, so an awaited command against
 * a down Redis does not fail — it hangs. Any health check or guard that must
 * return promptly has to bound the wait explicitly.
 */
export async function withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default budget for a non-critical Redis read. */
export const REDIS_OP_TIMEOUT_MS = 800;

export async function checkRedis(timeoutMs = 1500): Promise<{ ok: boolean; error?: string }> {
  try {
    const pong = await withTimeout(redis.ping(), timeoutMs, "redis ping");
    return { ok: pong === "PONG" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function disconnectRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

/** Simple fixed-window counter used for voice-call quotas etc. */
export async function incrementWindowCounter(key: string, ttlSeconds: number): Promise<number> {
  const count = await withTimeout(redis.incr(key), REDIS_OP_TIMEOUT_MS, "redis incr");
  if (count === 1) await redis.expire(key, ttlSeconds);
  return count;
}
