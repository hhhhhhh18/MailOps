import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

/**
 * Rate limiting for account deletion.
 *
 * Deliberately isolated in its own file: the test exhausts a limiter, and vitest gives
 * each file its own module registry, so the counter cannot leak into another suite.
 *
 * The technique here matters. The naive version — burst N+1 requests and assert the
 * last is 429 — passes even when the route's own limiter is missing, because the
 * GLOBAL limiter returns 429 for the same burst (both read the same window). That is
 * a false positive, and it is a real one that exists in the P0-4 rate-limit test today.
 *
 * So this test does two things differently:
 *   1. sets the global limit far above the auth limit, so the only middleware capable
 *      of producing a 429 is `authRateLimit`;
 *   2. lowers the auth limit to 3, so the assertion is fast and the exact boundary is
 *      checked rather than "somewhere in the next 1001 requests".
 *
 * `authRateLimit` is mounted before `requireAuth` on this route, which is what lets an
 * unauthenticated burst reach the limiter at all — and means no database is touched.
 */

const ORIGINAL_AUTH_MAX = process.env.AUTH_RATE_LIMIT_MAX;
const ORIGINAL_GLOBAL_MAX = process.env.RATE_LIMIT_MAX;

let app: Express;
let authMax = 0;
let globalMax = 0;

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.RATE_LIMIT_MAX = "500";

  // Re-evaluate src/config/env.ts so the limiters below are built with these values.
  vi.resetModules();
  const [{ createApp }, { env }] = await Promise.all([
    import("../../src/app"),
    import("../../src/config/env"),
  ]);

  app = createApp();
  authMax = env.AUTH_RATE_LIMIT_MAX;
  globalMax = env.RATE_LIMIT_MAX;
});

afterAll(() => {
  process.env.AUTH_RATE_LIMIT_MAX = ORIGINAL_AUTH_MAX;
  process.env.RATE_LIMIT_MAX = ORIGINAL_GLOBAL_MAX;
});

describe("rate limiting on DELETE /api/auth/account", () => {
  it("isolates the two limiters it depends on", () => {
    // Guards the validity of the assertions below: if these were equal, a global 429
    // would be indistinguishable from an auth 429 and the test would prove nothing.
    expect(authMax).toBe(3);
    expect(globalMax).toBeGreaterThan(authMax);
  });

  it("allows the configured number of attempts and then throttles with 429", async () => {
    const statuses: number[] = [];

    for (let i = 0; i < authMax + 1; i += 1) {
      const response = await request(app)
        .delete("/api/auth/account")
        .set("Cookie", "mailops_csrf=matched")
        .set("X-CSRF-Token", "matched")
        .send({ password: "irrelevant", confirmation: "irrelevant@example.com" });

      statuses.push(response.status);
    }

    // Every attempt up to the limit reached authentication (401 — no session).
    expect(statuses.slice(0, authMax)).toEqual(Array(authMax).fill(401));
    // The next one is refused by the auth limiter.
    expect(statuses[authMax]).toBe(429);
  });
});
