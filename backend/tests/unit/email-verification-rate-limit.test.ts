import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import request from "supertest";

/**
 * Rate limiting for the email-verification endpoints — and, more usefully, for the
 * Redis-backed `authRateLimit` limiter itself.
 *
 * The predecessor of this file asserted that a burst against
 * `POST /api/auth/resend-verification` eventually returned 429, and passed for the
 * wrong reason. On that route `requireAuth` is mounted *before* `authRateLimit`, so an
 * unauthenticated request is rejected with 401 and the auth limiter is never
 * consulted — the 429 it saw came from the *global* limiter, whose budget happened to
 * be the same 1000 under test. It also relied on vitest handing each file a private
 * counter, which was true of the in-memory store it was written against and false once
 * the counters moved into Redis. That is why it was deleted rather than adapted during
 * the migration.
 *
 * This version addresses all three problems:
 *
 *  1. `authRateLimit` is exercised on a throwaway app that mounts *only* the auth
 *     limiter, so a 429 there cannot have come from the global limiter.
 *  2. The global limiter gets a deliberately different budget, so the two can never be
 *     confused with one another.
 *  3. Isolation comes from the per-file `RATE_LIMIT_KEY_PREFIX` set in tests/setup.ts,
 *     so this file neither inherits another file's counter nor needs to clean up after
 *     itself.
 *
 * `requireAuth` throws on a missing token before it reaches the database
 * (middleware/auth.ts:35), so the endpoint assertion below remains a genuine unit test.
 */

const ORIGINAL_AUTH_MAX = process.env.AUTH_RATE_LIMIT_MAX;
const ORIGINAL_GLOBAL_MAX = process.env.RATE_LIMIT_MAX;

/** Small enough to assert an exact boundary quickly. The two must differ. */
const AUTH_MAX = 3;
const GLOBAL_MAX = 9;

let app: Express;
let probeApp: Express;
let errorHandler: ErrorRequestHandler;

/** Builds an app that mounts the real auth limiter and nothing else. */
function buildProbeApp(authLimiter: RequestHandler, handler: ErrorRequestHandler): Express {
  const probe = express();
  probe.post("/probe", authLimiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  // The real error handler, so the throttle response is production-shaped.
  probe.use(handler);
  return probe;
}

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT_MAX = String(AUTH_MAX);
  process.env.RATE_LIMIT_MAX = String(GLOBAL_MAX);

  // Re-evaluate src/config/env.ts and everything that reads it at module load, so the
  // limiters are constructed with the budgets above.
  vi.resetModules();

  const [security, errorModule, appModule] = await Promise.all([
    import("../../src/middleware/security"),
    import("../../src/middleware/error"),
    import("../../src/app"),
  ]);

  errorHandler = errorModule.errorHandler as unknown as ErrorRequestHandler;
  probeApp = buildProbeApp(security.authRateLimit as unknown as RequestHandler, errorHandler);
  app = appModule.createApp();
});

afterAll(() => {
  process.env.AUTH_RATE_LIMIT_MAX = ORIGINAL_AUTH_MAX;
  process.env.RATE_LIMIT_MAX = ORIGINAL_GLOBAL_MAX;
});

/**
 * These assertions share one bucket on purpose: the limiter is keyed per client, not
 * per route, so every probe request consumes the same budget. The first test spends
 * it; the later ones describe the resulting state. This ordering dependency is the
 * reason they read as a sequence rather than as independent cases.
 */
describe("authRateLimit (Redis-backed)", () => {
  it("allows exactly the configured budget and throttles the next request", async () => {
    // Guards the isolation claim: a global 429 must be distinguishable from an auth 429.
    expect(AUTH_MAX).toBeLessThan(GLOBAL_MAX);

    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_MAX; i += 1) {
      const response = await request(probeApp).post("/probe");
      statuses.push(response.status);
    }

    // Every request within the budget was allowed through to the route…
    expect(statuses.slice(0, AUTH_MAX)).toEqual(Array(AUTH_MAX).fill(200));
    // …and the one past it was refused. Nothing else can produce this 429: the probe
    // app mounts no global limiter.
    expect(statuses[AUTH_MAX]).toBe(429);
  });

  it("returns the retryable rate-limit error rather than a generic failure", async () => {
    const response = await request(probeApp).post("/probe");

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("RATE_LIMITED");
    expect(response.body.error.retryable).toBe(true);
  });

  it("advertises the standard rate-limit headers", async () => {
    const response = await request(probeApp).post("/probe");

    const headerNames = Object.keys(response.headers).map((name) => name.toLowerCase());
    expect(headerNames.some((name) => name.startsWith("ratelimit"))).toBe(true);
  });

  it("shares the budget beyond the module registry, which is what makes it Redis-backed", async () => {
    /**
     * The counter has to outlive this process's module state — that is the entire point
     * of the migration, and its absence is precisely what broke the suite. A fresh
     * module registry constructs brand-new RedisStore instances and issues its own
     * SCRIPT LOAD; against an in-memory store the budget would reset here and this
     * request would succeed. It still sees the exhausted bucket, so the state lives in
     * Redis, not in the module.
     */
    vi.resetModules();
    const [freshSecurity, freshError] = await Promise.all([
      import("../../src/middleware/security"),
      import("../../src/middleware/error"),
    ]);

    // The handler must come from the same registry as the limiter: a fresh registry
    // constructs its own AppError class, and the error handler identifies errors with
    // `instanceof`, so pairing the old handler with the new limiter would report an
    // unmapped 500 instead of the 429 it actually threw.
    const freshApp = buildProbeApp(
      freshSecurity.authRateLimit as unknown as RequestHandler,
      freshError.errorHandler as unknown as ErrorRequestHandler,
    );
    const response = await request(freshApp).post("/probe");

    expect(response.status).toBe(429);
  });
});

describe("rate limiting on POST /api/auth/resend-verification", () => {
  it("throttles unauthenticated traffic before it can be used to trigger mail", async () => {
    /**
     * On this route `requireAuth` runs before `authRateLimit`, so an unauthenticated
     * burst is bounded by the *global* limiter — hence GLOBAL_MAX here rather than
     * AUTH_MAX. That is the real protection for this endpoint, and asserting it is the
     * honest version of what the deleted test was reaching for.
     *
     * `authRateLimit` with a session present is covered above, and against the real
     * route ordering in account-deletion-rate-limit.test.ts (DELETE /api/auth/account
     * mounts it ahead of requireAuth).
     */
    const statuses: number[] = [];
    for (let i = 0; i <= GLOBAL_MAX; i += 1) {
      const response = await request(app)
        .post("/api/auth/resend-verification")
        // Valid double-submit token, so the request gets as far as authentication.
        .set("Cookie", "mailops_csrf=matched")
        .set("X-CSRF-Token", "matched");
      statuses.push(response.status);
    }

    // Unauthenticated, so every attempt within the budget is a 401 and never sends mail.
    expect(statuses.slice(0, GLOBAL_MAX).every((status) => status === 401)).toBe(true);
    // The request past the budget is refused outright.
    expect(statuses[GLOBAL_MAX]).toBe(429);
  });
});
