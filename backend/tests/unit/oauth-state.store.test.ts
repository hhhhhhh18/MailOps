/**
 * OAuth `state` store (F4) against a real Redis.
 *
 * The store is a security control, so these tests assert the properties the old
 * in-process `Map` only had by accident: a real server-side TTL, single-use
 * consumption, and atomicity under concurrent callbacks. Atomicity is the one that
 * could not be tested before — an in-process `Map` had no `await` between its read and
 * its delete, so it was atomic for reasons nothing recorded or verified.
 *
 * No database is needed: the store deals in opaque nonces and user ids, so this runs
 * in the default (unit) suite exactly like `rate-limit-redis-availability.test.ts`,
 * which also exercises a real Redis connection.
 *
 * The fail-fast behaviour when Redis is unreachable needs a controllable client and
 * therefore lives in `oauth-state.outage.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oauthStateRedis } from "../../src/config/redis";
import { AppError } from "../../src/utils/errors";
import { STATE_TTL_SECONDS, consumeState, issueState, peekState } from "../../src/services/gmail/oauth-state.store";

const KEY_PREFIX = "oauth:state:";

/** A plausible cuid, shaped like a real `User.id`. */
const USER_A = "clz9x8v7b0000abcd1234efgh";
const USER_B = "clz9x8v7b0001abcd5678ijkl";

/** Every nonce this file issues, so nothing is left behind. */
const issued: string[] = [];

async function issue(userId = USER_A): Promise<string> {
  const nonce = await issueState(userId);
  issued.push(nonce);
  return nonce;
}

/**
 * Waits for the client to become writable.
 *
 * The store's client is deliberately fail-fast (`enableOfflineQueue: false`), so a
 * command issued before the socket is ready is rejected with "Stream isn't writeable"
 * rather than queued. In a full suite run that window is wide enough to hit — the
 * production code only cares after startup, but a test asserts immediately — so wait
 * for the `ready` event instead of racing it.
 */
async function waitForReady(timeoutMs = 15_000): Promise<void> {
  if (oauthStateRedis.status === "ready") return;

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      oauthStateRedis.off("ready", onReady);
      reject(new Error(`oauth state Redis client was not ready within ${timeoutMs}ms (status: ${oauthStateRedis.status})`));
    }, timeoutMs);

    oauthStateRedis.once("ready", onReady);
  });
}

beforeAll(async () => {
  // Fail loudly and early if Redis is not reachable, rather than letting each test
  // discover it through a timeout.
  await waitForReady();
  await oauthStateRedis.ping();
});

afterAll(async () => {
  // Belt and braces: consumed states are already deleted, but a test that fails
  // mid-way could leave a key behind until its TTL lapses.
  const keys = issued.map((nonce) => `${KEY_PREFIX}${nonce}`);
  if (keys.length) await oauthStateRedis.del(...keys).catch(() => undefined);
  await oauthStateRedis.quit().catch(() => oauthStateRedis.disconnect());
});

describe("issueState", () => {
  it("returns a 32-character base64url nonce with no user data in it", async () => {
    const nonce = await issue(USER_A);

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // 24 CSPRNG bytes = 192 bits. The state travels through the URL bar and Google's
    // logs, so it must be opaque on its own.
    expect(nonce).not.toContain(USER_A);
    expect(nonce.length).toBe(32);
  });

  it("issues a distinct nonce every time", async () => {
    const nonces = new Set(await Promise.all([issue(), issue(), issue(), issue(), issue()]));
    expect(nonces.size).toBe(5);
  });

  it("stores the state under the oauth:state: namespace", async () => {
    const nonce = await issue(USER_A);

    // Pins the keyspace so it cannot drift into BullMQ's or the rate limiter's.
    expect(await oauthStateRedis.exists(`${KEY_PREFIX}${nonce}`)).toBe(1);
    expect(await oauthStateRedis.get(`${KEY_PREFIX}${nonce}`)).toBe(USER_A);
  });

  it("sets the TTL at write time, so an abandoned consent screen expires on its own", async () => {
    const nonce = await issue(USER_A);

    // Replaces the old opportunistic sweep, which only ran when someone else started
    // a new flow. -1 would mean "no expiry"; -2 would mean the key is already gone.
    const ttl = await oauthStateRedis.ttl(`${KEY_PREFIX}${nonce}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(STATE_TTL_SECONDS);
    expect(STATE_TTL_SECONDS).toBe(600);
  });
});

describe("consumeState", () => {
  it("returns the user the state was issued to, and removes it", async () => {
    const nonce = await issue(USER_B);

    await expect(consumeState(nonce)).resolves.toBe(USER_B);
    expect(await oauthStateRedis.exists(`${KEY_PREFIX}${nonce}`)).toBe(0);
  });

  it("is single-use: a replayed callback is rejected", async () => {
    const nonce = await issue(USER_A);
    await expect(consumeState(nonce)).resolves.toBe(USER_A);

    const replay = await consumeState(nonce).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(AppError);
    expect((replay as AppError).statusCode).toBe(400);
    expect((replay as AppError).code).toBe("VALIDATION_ERROR");
    expect((replay as AppError).message).toBe("OAuth state is invalid or has already been used");
  });

  it("lets exactly one of two concurrent callbacks win", async () => {
    const nonce = await issue(USER_A);

    // Both EVALs are written to the socket before either reply arrives, so this
    // really does exercise the race. With a non-atomic GET-then-DEL both would read
    // the user id and both would report success, which for a real callback would mean
    // consuming one authorization code twice.
    const results = await Promise.allSettled([consumeState(nonce), consumeState(nonce)]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((won[0] as PromiseFulfilledResult<string>).value).toBe(USER_A);

    const failure = (lost[0] as PromiseRejectedResult).reason as AppError;
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.code).toBe("VALIDATION_ERROR");

    // And the state is genuinely gone afterwards.
    expect(await oauthStateRedis.exists(`${KEY_PREFIX}${nonce}`)).toBe(0);
  });

  it("rejects an unknown state without touching another user's entry", async () => {
    const nonce = await issue(USER_B);

    const outcome = await consumeState("not-a-real-state").catch((error: unknown) => error);
    expect((outcome as AppError).code).toBe("VALIDATION_ERROR");
    expect((outcome as AppError).statusCode).toBe(400);

    // A wrong state must not burn a valid one.
    expect(await oauthStateRedis.exists(`${KEY_PREFIX}${nonce}`)).toBe(1);
    await expect(consumeState(nonce)).resolves.toBe(USER_B);
  });

  it("rejects a missing state before consulting Redis", async () => {
    for (const value of [undefined, ""]) {
      const outcome = await consumeState(value).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(AppError);
      expect((outcome as AppError).message).toBe("Missing OAuth state parameter");
      expect((outcome as AppError).statusCode).toBe(400);
      expect((outcome as AppError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("keeps the user binding server-side only", async () => {
    const nonce = await issue(USER_A);

    // The nonce alone reveals nothing; the binding is the stored value.
    expect(nonce).not.toContain(USER_A);
    expect(await oauthStateRedis.get(`${KEY_PREFIX}${nonce}`)).toBe(USER_A);
  });
});

describe("peekState", () => {
  it("reports an outstanding state without consuming it", async () => {
    const nonce = await issue(USER_A);

    await expect(peekState(nonce)).resolves.toBe(true);
    // Still usable afterwards — that is the whole point of a non-consuming peek.
    await expect(consumeState(nonce)).resolves.toBe(USER_A);
    await expect(peekState(nonce)).resolves.toBe(false);
  });

  it("reports false for an unknown state", async () => {
    await expect(peekState("never-issued")).resolves.toBe(false);
  });
});
