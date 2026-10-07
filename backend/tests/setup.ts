/**
 * Vitest global setup.
 *
 * Sets deterministic, obviously-fake configuration so tests never touch real
 * credentials and never depend on a developer's local .env. dotenv does not
 * override already-set variables, so these win.
 *
 * Integration tests that need a live database are gated behind
 * RUN_INTEGRATION_TESTS=true (see tests/integration/*).
 */
import crypto from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Load backend/.env before anything reads process.env.
 *
 * Vitest runs outside the Prisma CLI (which is what normally loads .env), so
 * without this the integration tests silently fall back to a `mailops_test`
 * database that may not exist — and every DB-backed test fails to authenticate.
 * Dotenv never overwrites an already-set variable, so passing DATABASE_URL on the
 * command line still takes precedence.
 *
 * `process.cwd()` is used instead of `__dirname`, which is not available when the
 * test file is transformed to ESM.
 */
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "backend", ".env") });

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.AI_PROVIDER = "heuristic";
process.env.AI_API_KEY = "";
process.env.JWT_SECRET = "test-only-jwt-secret-not-used-anywhere-real";
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
// The deletion-receipt HMAC key. Separate from JWT_SECRET on purpose and with no fallback,
// so tests must provide it explicitly — exactly like production (see config/env.ts).
process.env.RECEIPT_HMAC_KEY = crypto.randomBytes(32).toString("base64");
process.env.COOKIE_SECURE = "false";
process.env.SCHEDULER_ENABLED = "false";
process.env.GMAIL_SYNC_LOOKBACK_DAYS = "60";
process.env.GMAIL_MAX_MESSAGES_PER_SCAN = "25";
process.env.RATE_LIMIT_MAX = "1000";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

/**
 * Give every test file its own rate-limit namespace.
 *
 * The limiters are Redis-backed now, so their counters are shared across the whole
 * process — and across the machine — rather than living in process memory. That
 * removes the isolation vitest's per-file module registry used to provide: whichever
 * test file happens to hit an auth route first consumes the budget that every other
 * file in the run is asserting against, so a file that passes alone fails in the
 * suite and vice versa. It is also why a burst test cannot simply clean up after
 * itself while sibling files run in parallel.
 *
 * `setupFiles` are executed once per test file, before that file's module graph is
 * imported, so the stores in middleware/security.ts pick this up. Each file gets a
 * unique namespace, which means no test needs to delete anything from Redis and
 * nothing leaks into a later run. The keys expire on their own with the window.
 */
process.env.RATE_LIMIT_KEY_PREFIX = `rl:test:${crypto.randomUUID()}`;
process.env.SLACK_WEBHOOK_URL = "";
process.env.WHATSAPP_ACCESS_TOKEN = "";
process.env.VOICE_ACCOUNT_SID = "";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://mailops:mailops@localhost:5432/mailops_test?schema=public";
}

if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = "redis://localhost:6379";
}

/** True when the suite should attempt real datastore-backed tests. */
export const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
