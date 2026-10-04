import IORedis, { type Redis, type RedisOptions } from "ioredis";
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

export function createRedisClient(role: string, overrides: Partial<RedisOptions> = {}): Redis {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    lazyConnect: false,
    // Opt-in per client. The defaults above are the ones BullMQ validates, so a
    // consumer that is *not* BullMQ can relax them for itself without weakening the
    // shared client.
    ...overrides,
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
 * Dedicated client for rate limiting.
 *
 * Deliberately not the shared instance. That one must keep
 * `maxRetriesPerRequest: null` for BullMQ, which is exactly what makes ioredis queue
 * commands while disconnected instead of failing them — and `express-rate-limit`
 * awaits the store, so a queued command hangs the request. This client fails fast
 * instead:
 *
 *   maxRetriesPerRequest: 1     give up rather than retry forever
 *   enableOfflineQueue: false   reject immediately when the socket is not writeable
 *
 * The retry strategy is left at the factory default on purpose: the client keeps
 * reconnecting, so rate limiting recovers by itself once Redis returns. Both
 * behaviours are only half the story — a reachable-but-silent Redis still leaves a
 * command in flight, which is why the stores also bound every command with a
 * timeout. See `createStoreCommand` in middleware/security.ts.
 *
 * Never hand this client to BullMQ: it would be rejected as a blocking connection.
 */
export const rateLimitRedis = createRedisClient("ratelimit", {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

/**
 * Dedicated client for the OAuth `state` store.
 *
 * Same fail-fast posture as the rate-limit client and for the same reason: the shared
 * client must keep `maxRetriesPerRequest: null` for BullMQ, and that is precisely what
 * makes an awaited command hang while Redis is reconnecting instead of failing. OAuth
 * state is read on the Gmail callback path, so a hung read would hang the user's
 * browser on a consent redirect.
 *
 * Separate from `rateLimitRedis` on purpose — the two have independent lifecycles and
 * no shared policy, and keeping them apart means an OAuth outage cannot perturb the
 * rate limiter (or vice versa). Never hand this client to BullMQ.
 */
export const oauthStateRedis = createRedisClient("oauth-state", {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

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

/**
 * Closes every Redis client this process owns.
 *
 * Both entrypoints already call this during shutdown, so adding a client here is what
 * guarantees it is closed — rather than having to remember it in two shutdown
 * sequences. `quit()` is tried first so pending replies drain; a client that is
 * already closed or unreachable falls back to `disconnect()`.
 */
export async function disconnectRedis(): Promise<void> {
  for (const client of [redis, rateLimitRedis, oauthStateRedis]) {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}

/** Simple fixed-window counter used for voice-call quotas etc. */
export async function incrementWindowCounter(key: string, ttlSeconds: number): Promise<number> {
  const count = await withTimeout(redis.incr(key), REDIS_OP_TIMEOUT_MS, "redis incr");
  if (count === 1) await redis.expire(key, ttlSeconds);
  return count;
}
