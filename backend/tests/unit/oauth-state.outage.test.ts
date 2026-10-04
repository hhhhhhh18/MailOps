/**
 * OAuth `state` store when Redis is unavailable (F4).
 *
 * The store fails CLOSED: the shared `redis` client keeps `maxRetriesPerRequest: null`
 * for BullMQ, which makes an awaited command *hang* while Redis reconnects rather than
 * fail. On the Gmail callback that would strand the user's browser mid-redirect, so the
 * store gets its own fail-fast client plus a command timeout. Both failure modes are
 * covered here because they need different mechanisms — exactly as
 * `rate-limit-redis-availability.test.ts` separates them for the rate limiter:
 *
 *   dead socket   -> `enableOfflineQueue: false` rejects immediately
 *   silent socket -> only the timeout catches it (reachable, never answers)
 *
 * The real store, the real controller and the real route are used throughout; only
 * `oauthStateRedis` is replaced, so the route assertion exercises the genuine
 * callback-to-redirect path. No database is needed — the callback is public and
 * `consumeState` runs before anything touches Prisma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { fakeRedis } = vi.hoisted(() => ({
  fakeRedis: {
    set: vi.fn(),
    eval: vi.fn(),
    exists: vi.fn(),
  },
}));

vi.mock("../../src/config/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/redis")>();
  return { ...actual, oauthStateRedis: fakeRedis as unknown as typeof actual.oauthStateRedis };
});

import { REDIS_OP_TIMEOUT_MS } from "../../src/config/redis";
import { createApp } from "../../src/app";
import { AppError } from "../../src/utils/errors";
import { consumeState, issueState } from "../../src/services/gmail/oauth-state.store";

const app = createApp();

const DEAD_SOCKET = new Error("connect ECONNREFUSED 127.0.0.1:6379");
/** A socket that is connected but never answers — nothing rejects until we time out. */
const silentSocket = () => new Promise<never>(() => undefined);

/** Resolves true when the promise settles before `budgetMs`, without waiting for it. */
async function settledWithin(promise: Promise<unknown>, budgetMs: number): Promise<{ settled: boolean; ms: number }> {
  const started = Date.now();
  let settled = false;
  await Promise.race([
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    ),
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);
  return { settled, ms: Date.now() - started };
}

beforeEach(() => {
  // `reset` rather than `clear`: each test installs its own failure mode, and a
  // leftover implementation from a previous test would mask that.
  vi.resetAllMocks();
});

describe("oauth state store — fail closed when Redis is unreachable", () => {
  it("rejects a callback state promptly when the socket is dead, without waiting for the timeout", async () => {
    fakeRedis.eval.mockRejectedValue(DEAD_SOCKET);

    const started = Date.now();
    const outcome = await consumeState("some-nonce").catch((error: unknown) => error);
    const elapsed = Date.now() - started;

    expect(outcome).toBeInstanceOf(AppError);
    const error = outcome as AppError;
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("REDIS_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.degraded).toBe(true);

    // `enableOfflineQueue: false` makes this a rejection, not a queued command, so it
    // must beat the command timeout — otherwise a dead Redis would be indistinguishable
    // from a slow one and every callback would wait the full budget.
    expect(elapsed).toBeLessThan(REDIS_OP_TIMEOUT_MS);
  });

  it("rejects rather than hangs when Redis is reachable but never answers", async () => {
    fakeRedis.eval.mockImplementation(silentSocket);

    const outcome = await settledWithin(
      consumeState("some-nonce").catch((error: unknown) => error),
      5_000,
    );

    expect(outcome.settled).toBe(true);
    // Bounded by the command timeout, not by the caller's patience.
    expect(outcome.ms).toBeGreaterThanOrEqual(REDIS_OP_TIMEOUT_MS - 100);
    expect(outcome.ms).toBeLessThan(5_000);
  });

  it("refuses to issue a state when Redis is unreachable, so no unusable state escapes", async () => {
    fakeRedis.set.mockRejectedValue(DEAD_SOCKET);

    const outcome = await issueState("clz9x8v7b0000abcd1234efgh").catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(AppError);
    const error = outcome as AppError;
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("REDIS_UNAVAILABLE");
  });

  it("bounds the state write as well, so /oauth/start cannot hang", async () => {
    fakeRedis.set.mockImplementation(silentSocket);

    const outcome = await settledWithin(
      issueState("clz9x8v7b0000abcd1234efgh").catch((error: unknown) => error),
      5_000,
    );

    expect(outcome.settled).toBe(true);
    expect(outcome.ms).toBeLessThan(5_000);
  });
});

describe("GET /api/gmail/oauth/callback under a Redis outage", () => {
  it("redirects to the app with REDIS_UNAVAILABLE instead of hanging or 500ing", async () => {
    fakeRedis.eval.mockRejectedValue(DEAD_SOCKET);

    const result = await settledWithin(
      request(app).get("/api/gmail/oauth/callback?code=fake-code&state=fake-state"),
      5_000,
    );
    expect(result.settled).toBe(true);
    expect(result.ms).toBeLessThan(5_000);

    const response = await request(app).get("/api/gmail/oauth/callback?code=fake-code&state=fake-state");

    // The contract is a redirect, never JSON and never a 500 — Google's redirect
    // arrives in a browser.
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("section=gmail");
    expect(response.headers.location).toContain("gmail=failed");
    expect(response.headers.location).toContain("reason=REDIS_UNAVAILABLE");
  });

  it("still reports an invalid state as VALIDATION_ERROR when Redis is healthy", async () => {
    fakeRedis.eval.mockResolvedValue(null);

    const response = await request(app).get("/api/gmail/oauth/callback?code=fake-code&state=bogus");

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("gmail=failed");
    expect(response.headers.location).toContain("reason=VALIDATION_ERROR");
  });
});
