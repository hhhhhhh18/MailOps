import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import request from "supertest";
import type { Redis } from "ioredis";
import type { Queue, Worker } from "bullmq";

/**
 * Rate limiting when Redis is unavailable.
 *
 * The migration to a Redis-backed store introduced a hang: the store reused the
 * shared `client`, whose `maxRetriesPerRequest: null` (required by BullMQ) makes
 * ioredis queue commands while disconnected instead of failing them. Because
 * `express-rate-limit` awaits the store, a rate-limited request never settled.
 *
 * The fix is a dedicated client that fails fast, plus a store command that is bounded
 * and applies a per-limiter policy:
 *
 *   global limiter -> fail OPEN   (the bucket only protects capacity)
 *   auth limiter   -> fail CLOSED (the bucket is what stops credential stuffing)
 *
 * Both failure modes are covered here because they need different mechanisms:
 * a dead socket is caught by `enableOfflineQueue: false`, whereas a *silent* socket
 * (reachable but never answering) is only caught by the store timeout.
 *
 * ORDERING IS SIGNIFICANT. The buckets are keyed per client, so the boundary tests
 * must run before anything else touches them, and `disconnect()` is irreversible for
 * this process — hence the degraded suites come last.
 */

const ORIGINAL_AUTH_MAX = process.env.AUTH_RATE_LIMIT_MAX;
const ORIGINAL_GLOBAL_MAX = process.env.RATE_LIMIT_MAX;

/** Small enough to assert exact boundaries; deliberately different from each other. */
const AUTH_MAX = 3;
const GLOBAL_MAX = 9;

const DEGRADED_MESSAGE = "rate-limit store unavailable; degrading";

let redis: Redis;
let rateLimitRedis: Redis;
let disconnectRedis: () => Promise<void>;
let globalRateLimit: RequestHandler;
let authRateLimit: RequestHandler;
let errorHandler: ErrorRequestHandler;
let app: Express;
let opTimeoutMs: number;
let getDegradedWarnCount: () => number = () => 0;
let restoreWarnSpy: () => void = () => undefined;

/** How many degraded requests each suite issues, asserted on at the end. */
let degradedRequestsIssued = 0;

function buildProbe(limiter: RequestHandler, handler: ErrorRequestHandler): Express {
  const probe = express();
  probe.post("/probe", limiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  probe.use(handler);
  return probe;
}

/**
 * Waits for a client to reach a terminal status.
 *
 * `quit()` resolves when the QUIT command is answered, but ioredis only moves the
 * status to "end" when the socket's close event arrives — asserting straight after
 * the await is a race.
 */
async function waitForStatus(client: Redis, expected: string, budgetMs = 3_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (client.status !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return client.status;
}

/** Fails the test rather than stalling the suite if a request ever hangs again. */
async function probeRequest(probe: Express, budgetMs: number) {
  const started = Date.now();
  const response = await request(probe).post("/probe").timeout(budgetMs);
  degradedRequestsIssued += 1;
  return { response, elapsed: Date.now() - started };
}

let globalProbe: Express;
let authProbe: Express;

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT_MAX = String(AUTH_MAX);
  process.env.RATE_LIMIT_MAX = String(GLOBAL_MAX);

  // Re-evaluate env and everything that reads it at module load, so the limiters and
  // both Redis clients are constructed with the values above.
  vi.resetModules();

  const [redisModule, loggerModule, security, errorModule, appModule] = await Promise.all([
    import("../../src/config/redis"),
    import("../../src/config/logger"),
    import("../../src/middleware/security"),
    import("../../src/middleware/error"),
    import("../../src/app"),
  ]);

  redis = redisModule.redis as Redis;
  rateLimitRedis = redisModule.rateLimitRedis as Redis;
  disconnectRedis = redisModule.disconnectRedis;
  opTimeoutMs = redisModule.REDIS_OP_TIMEOUT_MS;

  errorHandler = errorModule.errorHandler as unknown as ErrorRequestHandler;
  globalProbe = buildProbe(security.globalRateLimit as unknown as RequestHandler, errorHandler);
  authProbe = buildProbe(security.authRateLimit as unknown as RequestHandler, errorHandler);
  app = appModule.createApp();

  // The log spy must observe the same logger object the middleware uses, so it is
  // installed on the registry generation imported above.
  const warnSpy = vi.spyOn(loggerModule.logger, "warn");
  getDegradedWarnCount = () =>
    warnSpy.mock.calls.filter((call) => call[1] === DEGRADED_MESSAGE).length;
  restoreWarnSpy = () => warnSpy.mockRestore();
});

afterAll(() => {
  restoreWarnSpy();
  process.env.AUTH_RATE_LIMIT_MAX = ORIGINAL_AUTH_MAX;
  process.env.RATE_LIMIT_MAX = ORIGINAL_GLOBAL_MAX;
});

describe("the shared BullMQ client is left alone", () => {
  it("keeps the options BullMQ requires and uses a separate client for rate limiting", () => {
    expect(redis.options.maxRetriesPerRequest).toBeNull();
    expect(redis.options.enableOfflineQueue).not.toBe(false);

    expect(rateLimitRedis).not.toBe(redis);
    expect(rateLimitRedis.options.maxRetriesPerRequest).toBe(1);
    expect(rateLimitRedis.options.enableOfflineQueue).toBe(false);
  });

  it("still constructs a BullMQ Queue and Worker against the shared client", async () => {
    const { Queue, Worker } = await import("bullmq");

    let queue: Queue | undefined;
    let worker: Worker | undefined;

    // BullMQ validates that a blocking connection's maxRetriesPerRequest is null and
    // throws otherwise — this is the guard that the new client was not wired into it.
    expect(() => {
      queue = new Queue("rl-hardening-probe", { connection: redis });
    }).not.toThrow();
    expect(() => {
      worker = new Worker("rl-hardening-probe", async () => "ok", { connection: redis });
    }).not.toThrow();

    await worker?.close();
    await queue?.close();
  });
});

describe("normal operation, Redis available", () => {
  it("enforces the global budget and then throttles", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= GLOBAL_MAX; i += 1) {
      const response = await request(globalProbe).post("/probe");
      statuses.push(response.status);
    }

    expect(statuses.slice(0, GLOBAL_MAX)).toEqual(Array(GLOBAL_MAX).fill(200));
    expect(statuses[GLOBAL_MAX]).toBe(429);
  });

  it("enforces the auth budget and then throttles", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_MAX; i += 1) {
      const response = await request(authProbe).post("/probe");
      statuses.push(response.status);
    }

    expect(statuses.slice(0, AUTH_MAX)).toEqual(Array(AUTH_MAX).fill(200));
    expect(statuses[AUTH_MAX]).toBe(429);
  });
});

describe("a silent Redis: reachable but never answering", () => {
  /**
   * Simulates the failure that `enableOfflineQueue: false` does NOT cover: the socket
   * is writeable, so the command is accepted and simply never comes back. Only the
   * store timeout can bound this, which is what these two tests prove.
   */
  let restoreCall: () => void = () => undefined;

  beforeAll(() => {
    const spy = vi
      .spyOn(rateLimitRedis, "call")
      .mockImplementation(() => new Promise(() => undefined) as never);
    restoreCall = () => spy.mockRestore();
  });

  afterAll(() => {
    restoreCall();
  });

  it("bounds the global limiter and lets the request through", async () => {
    const budget = opTimeoutMs + 1_500;
    const { response, elapsed } = await probeRequest(globalProbe, budget);

    expect(elapsed).toBeLessThan(budget);
    // Fail open: even though the bucket was exhausted above, a failed read reports
    // zero hits, so the request is allowed rather than stuck or refused.
    expect(response.status).toBe(200);
  });

  it("bounds the auth limiter and refuses the request", async () => {
    // Three timeouts are possible: the attempt, the script reload, and the retry.
    const budget = opTimeoutMs * 3 + 1_500;
    const { response, elapsed } = await probeRequest(authProbe, budget);

    expect(elapsed).toBeLessThan(budget);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("REDIS_UNAVAILABLE");
    expect(response.body.error.retryable).toBe(true);
    expect(response.body.error.degraded).toBe(true);
  });

  it("warns about the degradation", () => {
    expect(getDegradedWarnCount()).toBeGreaterThan(0);
  });
});

describe("Redis unavailable: socket not writeable", () => {
  // Irreversible for this process, which is why this suite runs last.
  beforeAll(() => {
    rateLimitRedis.disconnect();
  });

  it("fails the global limiter open instead of hanging, 500ing or 503ing", async () => {
    const budget = opTimeoutMs + 1_500;
    const { response, elapsed } = await probeRequest(globalProbe, budget);

    expect(elapsed).toBeLessThan(budget);
    expect(response.status).toBe(200);
    expect(response.status).not.toBe(500);
    expect(response.status).not.toBe(503);
    expect(response.status).not.toBe(429);
  });

  it("fails the auth limiter closed with a retryable 503", async () => {
    const { response, elapsed } = await probeRequest(authProbe, opTimeoutMs * 3 + 1_500);

    expect(elapsed).toBeLessThan(opTimeoutMs * 3 + 1_500);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("REDIS_UNAVAILABLE");
    expect(response.body.error.retryable).toBe(true);
    expect(response.body.error.degraded).toBe(true);
  });

  it("refuses sign-in through the real route, end to end", async () => {
    // POST /api/auth/login mounts authRateLimit ahead of validation and of the
    // session check (routes/auth.routes.ts), so this exercises the fail-closed path
    // exactly as production would.
    const response = await request(app)
      .post("/api/auth/login")
      .set("Cookie", "mailops_csrf=matched")
      .set("X-CSRF-Token", "matched")
      .send({ email: "someone@example.com", password: "does-not-matter-1" })
      .timeout(opTimeoutMs * 3 + 1_500);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("REDIS_UNAVAILABLE");
  });

  it("still serves non-auth routes, so the outage is not a blanket 503", async () => {
    // The global limiter fails open, so this reaches requireAuth and is rejected for
    // the ordinary reason — no session. That is the documented degradation contract.
    const response = await request(app).get("/api/auth/me");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("keeps the warning bounded rather than logging once per request", async () => {
    // The throttle is 30s and this file runs well inside that window, so however many
    // requests degrade, only the first one is allowed to warn.
    for (let i = 0; i < 5; i += 1) {
      await probeRequest(globalProbe, opTimeoutMs + 1_500);
    }

    expect(degradedRequestsIssued).toBeGreaterThan(5);
    expect(getDegradedWarnCount()).toBe(1);
  });
});

describe("graceful shutdown", () => {
  it("closes both clients and is safe to call twice", async () => {
    await disconnectRedis();

    expect(await waitForStatus(rateLimitRedis, "end")).toBe("end");
    expect(await waitForStatus(redis, "end")).toBe("end");

    // Idempotent: both entrypoints call this, and a second signal must not throw.
    await expect(disconnectRedis()).resolves.toBeUndefined();
  });
});
