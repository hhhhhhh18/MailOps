import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { redactSecrets } from "../../src/utils/redact";
import { randomToken } from "../../src/utils/crypto";
import { env } from "../../src/config/env";

/**
 * Email verification: the parts that need no database.
 *
 * These run on every commit. The DB-backed lifecycle (token issuance, single use,
 * expiry, resend semantics) lives in tests/integration/email-verification.test.ts.
 */

const app = createApp();

describe("verification URL redaction", () => {
  it("masks the token carried by a verification link", () => {
    // The requirement is explicit: verification URLs must not reach the logs.
    const raw = randomToken(48);
    const redacted = redactSecrets(`https://app.example.com/verify-email?token=${raw}`);

    expect(redacted).not.toContain(raw);
    expect(redacted).toContain("verify-email");
    expect(redacted).toContain("[REDACTED]");
  });

  it("masks a verification link wherever it appears in a log line", () => {
    const raw = randomToken(48);
    const redacted = redactSecrets(
      `email (console provider, development) body=Confirm this address: https://mailops.app/verify-email?token=${raw} expires soon`,
    );

    expect(redacted).not.toContain(raw);
  });

  it("masks the fragment form as well", () => {
    const raw = randomToken(48);
    expect(redactSecrets(`https://mailops.app/#token=${raw}`)).not.toContain(raw);
  });
});

describe("CSRF on resend-verification", () => {
  it("rejects a request with no CSRF token", async () => {
    const response = await request(app).post("/api/auth/resend-verification");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a request whose header does not match the cookie", async () => {
    const response = await request(app)
      .post("/api/auth/resend-verification")
      .set("Cookie", "mailops_csrf=cookie-value")
      .set("X-CSRF-Token", "different-value");

    expect(response.status).toBe(403);
  });
});

/**
 * Rate limiting lives in its own file: deliberately exhausting a limiter would
 * otherwise poison every later request in this process, which is exactly the
 * interference that broke the validation tests below.
 */
describe.skip("rate limiting on resend-verification (see email-verification-rate-limit.test.ts)", () => {
  it("is covered in a dedicated file", () => {
    expect(env.AUTH_RATE_LIMIT_MAX).toBeGreaterThan(0);
  });
});

describe("verify-email request validation", () => {
  it("requires a token in the query string", async () => {
    const response = await request(app).get("/api/auth/verify-email");
    expect(response.status).toBe(422);
  });

  it("does not echo the submitted token back in an error body", async () => {
    const raw = randomToken(48);
    const response = await request(app).get(`/api/auth/verify-email?token=${raw}`);
    expect(JSON.stringify(response.body)).not.toContain(raw);
  });

  it("is reachable without a session (the link is opened from email)", async () => {
    // A GET is CSRF-exempt, so the failure here must not be 403.
    const response = await request(app).get("/api/auth/verify-email?token=some-token");
    expect(response.status).not.toBe(403);
  });
});
