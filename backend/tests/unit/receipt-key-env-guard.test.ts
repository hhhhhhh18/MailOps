/**
 * The production boot guard for `RECEIPT_HMAC_KEY` (F5).
 *
 * `config/env.ts` refuses to start in production with insecure config instead of logging a
 * warning. The receipt key belongs on that list for the same reason `JWT_SECRET` does: a
 * deployment that starts without it would write deletion receipts it can never match again.
 *
 * `config/env.ts` itself is never mocked — `loadEnv()` reads `process.env` at module
 * evaluation, so the guard is exercised for real by resetting the module registry and
 * re-importing the module with a controlled environment. Only the module's own
 * `dotenv.config()` call is neutralised, so the environment the guard sees is the one this
 * test constructs rather than the local machine's `.env` (see the `vi.mock` below).
 */
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `config/env.ts` calls `dotenv.config()` at import time. Because these tests re-import it
 * via `vi.resetModules()`, that call re-populates `process.env` from the developer's
 * `backend/.env` on every import, silently undoing the `delete process.env.…` this file
 * relies on — which is exactly what happened once a real local `RECEIPT_HMAC_KEY` was
 * added to `.env`. Neutralising dotenv keeps the file hermetic: it tests a *guard*, so the
 * environment must be the one the test builds, not whatever is on the machine.
 */
vi.mock("dotenv", () => ({
  default: { config: () => ({ parsed: {} }) },
}));

const ORIGINAL_ENV = { ...process.env };

/** A production-shaped environment that satisfies every other guard. */
function productionEnv(): void {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "production-jwt-secret-with-at-least-32-chars";
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.COOKIE_SECURE = "true";
  process.env.RECEIPT_HMAC_KEY = crypto.randomBytes(32).toString("base64");
}

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in ORIGINAL_ENV)) delete process.env[name];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  vi.resetModules();
});

describe("production boot guard — RECEIPT_HMAC_KEY", () => {
  it("refuses to start without the receipt key", async () => {
    productionEnv();
    delete process.env.RECEIPT_HMAC_KEY;
    vi.resetModules();

    await expect(import("../../src/config/env")).rejects.toThrow(/RECEIPT_HMAC_KEY/);
  });

  it("names the missing key in the refusal, like the other guards", async () => {
    productionEnv();
    delete process.env.RECEIPT_HMAC_KEY;
    vi.resetModules();

    const outcome = await import("../../src/config/env").catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/Refusing to start in production with insecure config/);
    expect((outcome as Error).message).toMatch(/RECEIPT_HMAC_KEY/);
  });

  it("starts when the receipt key is present", async () => {
    productionEnv();
    vi.resetModules();

    const module = await import("../../src/config/env");
    expect(module.env.NODE_ENV).toBe("production");
    expect(module.env.RECEIPT_HMAC_KEY).toBe(process.env.RECEIPT_HMAC_KEY);
  });

  it("does not require the key in a non-production environment", async () => {
    // Development stays startable; the missing key surfaces explicitly at use time instead
    // (see deletion-receipt-key.test.ts), so there is never a silent fallback.
    process.env.NODE_ENV = "development";
    delete process.env.RECEIPT_HMAC_KEY;
    vi.resetModules();

    const module = await import("../../src/config/env");
    expect(module.env.RECEIPT_HMAC_KEY).toBeUndefined();
  });
});
