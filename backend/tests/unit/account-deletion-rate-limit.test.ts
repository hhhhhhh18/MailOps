import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import crypto from "node:crypto";

/**
 * Rate limiting for account deletion.
 *
 * The test exhausts a Redis-backed limiter, so isolation must come from a
 * dedicated Redis key namespace rather than Vitest's module registry.
 *
 * The technique here matters. The naive version — burst N+1 requests and assert
 * the last is 429 — passes even when the route's own limiter is missing, because
 * the GLOBAL limiter returns 429 for the same burst (both read the same window).
 * That is a false positive.
 *
 * So this test does three things:
 *   1. sets the global limit far above the auth limit, so the only middleware
 *      capable of producing the expected 429 is `authRateLimit`;
 *   2. gives this test file its own Redis namespace before importing the limiter
 *      modules, so counters cannot leak from another Redis-backed test;
 *   3. lowers the auth limit to 3, so the exact boundary is checked quickly
 *      rather than "somewhere in the next 1001 requests".
 *
 * `authRateLimit` is mounted before `requireAuth` on this route, which is what
 * lets an unauthenticated burst reach the limiter at all — and means no
 * database is touched.
 */

const ORIGINAL_AUTH_MAX = process.env.AUTH_RATE_LIMIT_MAX;
const ORIGINAL_GLOBAL_MAX = process.env.RATE_LIMIT_MAX;
const ORIGINAL_RATE_LIMIT_PREFIX = process.env.RATE_LIMIT_KEY_PREFIX;

const TEST_RATE_LIMIT_PREFIX =
  `rl:test:account-deletion:${crypto.randomUUID()}`;

let app: Express;
let authMax = 0;
let globalMax = 0;

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.RATE_LIMIT_MAX = "500";

  // The Redis namespace must be set before resetting/importing the modules
  // that construct the rate-limit stores.
  process.env.RATE_LIMIT_KEY_PREFIX = TEST_RATE_LIMIT_PREFIX;

  // Re-evaluate src/config/env.ts and the limiter modules so they are
  // constructed with this test's own Redis namespace and limits.
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
  process.env.RATE_LIMIT_KEY_PREFIX = ORIGINAL_RATE_LIMIT_PREFIX;
});

describe("rate limiting on DELETE /api/auth/account", () => {
  it("isolates the two limiters it depends on", () => {
    // Guards the validity of the assertions below: if these were equal, a
    // global 429 would be indistinguishable from an auth 429 and the test
    // would prove nothing.
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
        .send({
          password: "irrelevant",
          confirmation: "irrelevant@example.com",
        });

      statuses.push(response.status);
    }

    // Every attempt up to the limit reaches authentication (401 — no session).
    expect(statuses.slice(0, authMax)).toEqual(Array(authMax).fill(401));

    // The next attempt is refused by the auth limiter.
    expect(statuses[authMax]).toBe(429);
  });
});