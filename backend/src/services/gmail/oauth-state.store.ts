import { REDIS_OP_TIMEOUT_MS, oauthStateRedis, withTimeout } from "../../config/redis";
import { logger } from "../../config/logger";
import { randomToken } from "../../utils/crypto";
import { AppError, ERROR_CODES, describeError } from "../../utils/errors";

/**
 * OAuth `state` store for the Gmail connection flow.
 *
 * The state was previously a module-level `Map`, which only worked for a single API
 * instance: with more than one instance, or after a restart between consent-start and
 * the callback, the callback landed on a process that had never seen the nonce and the
 * user was told the state "has already been used". Moving it to Redis makes the value
 * visible to every instance and survives a deploy mid-flow.
 *
 * Security properties, all preserved from the in-process implementation:
 *  - the state is 24 CSPRNG bytes (192 bits) rendered as base64url — pure random, so
 *    it is safe in a URL, browser history and Google's logs;
 *  - it is single-use and consumed atomically, so two concurrent callbacks cannot both
 *    succeed;
 *  - it is bound to the user who started the flow, and the binding never leaves the
 *    server;
 *  - it expires after 10 minutes, now enforced by Redis itself rather than by a sweep
 *    that only ran when some other user happened to start a flow.
 *
 * The value is the owning `userId`; the key is the random nonce. Nothing
 * user-identifying is placed in the key, so the keyspace does not leak account
 * identifiers the way `voice:calls:{userId}:{date}` does.
 *
 * This is a security control, so it fails CLOSED: if Redis is unreachable the flow is
 * refused (503) rather than silently degrading to process memory, which would reintroduce
 * the cross-instance and replay weaknesses this store exists to remove.
 */

/** Lifetime of a consent flow, in seconds. Mirrors the previous 10-minute in-process TTL. */
export const STATE_TTL_SECONDS = 10 * 60;

const KEY_PREFIX = "oauth:state:";

/**
 * Returns the value and deletes it in a single round trip.
 *
 * `GETDEL` would be shorter but requires Redis >= 6.2, and DEPLOYMENT.md supports
 * Redis 6+, so a script keeps consumption atomic on every supported version. A plain
 * `GET` followed by `DEL` would not: two callbacks could both read the userId before
 * either deleted it.
 */
const CONSUME_SCRIPT = "local value = redis.call('GET', KEYS[1]) if value then redis.call('DEL', KEYS[1]) end return value";

function keyFor(state: string): string {
  return `${KEY_PREFIX}${state}`;
}

/**
 * A Redis failure is an infrastructure failure, not a bad request, so it must be
 * reported as 503 rather than as an invalid state — otherwise an outage would look to
 * the user (and to our own metrics) like a security rejection.
 */
function stateStoreUnavailable(operation: string, error: unknown): AppError {
  logger.warn({ err: describeError(error).message, operation }, "oauth state store unavailable");
  return new AppError(
    "The Gmail connection service is temporarily unavailable. Please try again shortly.",
    { statusCode: 503, code: ERROR_CODES.REDIS_UNAVAILABLE, retryable: true, degraded: true },
  );
}

/**
 * Issues a new state nonce for a user and returns it.
 *
 * The TTL is set at write time, so an abandoned consent screen cannot leave a usable
 * state behind — Redis drops it regardless of whether any later flow is started.
 */
export async function issueState(userId: string): Promise<string> {
  const nonce = randomToken(24);

  try {
    await withTimeout(
      oauthStateRedis.set(keyFor(nonce), userId, "EX", STATE_TTL_SECONDS),
      REDIS_OP_TIMEOUT_MS,
      "oauth state write",
    );
  } catch (error) {
    throw stateStoreUnavailable("write", error);
  }

  return nonce;
}

/**
 * Validates a state and returns the user it was issued to.
 *
 * The value is removed before anything else is checked, so every outcome other than
 * success still burns the state — a replayed callback cannot get a second attempt by
 * presenting an otherwise-valid nonce.
 */
export async function consumeState(state: string | undefined): Promise<string> {
  if (!state) {
    throw new AppError("Missing OAuth state parameter", { statusCode: 400, code: ERROR_CODES.VALIDATION_ERROR });
  }

  let userId: unknown;
  try {
    userId = await withTimeout(
      oauthStateRedis.eval(CONSUME_SCRIPT, 1, keyFor(state)),
      REDIS_OP_TIMEOUT_MS,
      "oauth state consume",
    );
  } catch (error) {
    throw stateStoreUnavailable("consume", error);
  }

  if (typeof userId !== "string" || userId.length === 0) {
    throw new AppError("OAuth state is invalid or has already been used", {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }

  return userId;
}

/**
 * Observability helper: is this state still outstanding? Never consumes it.
 *
 * Deliberately not on any authorization path, and it fails closed — an unreachable
 * Redis reports `false` rather than throwing, because "false" is the safe answer for a
 * caller asking whether a state is valid.
 */
export async function peekState(state: string): Promise<boolean> {
  try {
    const exists = await withTimeout(oauthStateRedis.exists(keyFor(state)), REDIS_OP_TIMEOUT_MS, "oauth state peek");
    return exists === 1;
  } catch {
    return false;
  }
}
