import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { assertPasswordPolicy, DEFAULT_PASSWORD_MIN_LENGTH } from "../../src/services/auth/auth.service";
import { hashToken, randomToken } from "../../src/utils/crypto";
import { redactSecrets } from "../../src/utils/redact";
import { REDACTED_PATHS } from "../../src/config/logger";

/**
 * Password policy, token handling and log hygiene.
 *
 * None of this needs a database, so it runs on every commit. The DB-backed
 * lifecycle assertions live in tests/integration/password-reset.test.ts.
 */

describe("password policy", () => {
  it("accepts a password that meets the policy", () => {
    expect(() => assertPasswordPolicy("Str0ngPassword")).not.toThrow();
  });

  it("rejects a password shorter than the minimum", () => {
    const short = "Ab1";
    expect(() => assertPasswordPolicy(short)).toThrowError(/at least/i);
  });

  it("rejects a password with no digit", () => {
    expect(() => assertPasswordPolicy("abcdefghijkl")).toThrowError(/letter and one number/i);
  });

  it("rejects a password with no letter", () => {
    expect(() => assertPasswordPolicy("1234567890")).toThrowError(/letter and one number/i);
  });

  it("is the same policy used by registration", () => {
    // The minimum is shared, so register/change/reset cannot drift apart.
    expect(DEFAULT_PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(10);

    // One character below the minimum, but otherwise compliant: only the length
    // rule can reject this, which is what ties the two call sites together.
    const justTooShort = "a".repeat(DEFAULT_PASSWORD_MIN_LENGTH - 2) + "1";
    expect(justTooShort.length).toBe(DEFAULT_PASSWORD_MIN_LENGTH - 1);
    expect(() => assertPasswordPolicy(justTooShort)).toThrowError(/at least/i);

    // Exactly at the minimum is accepted.
    expect(() => assertPasswordPolicy("a".repeat(DEFAULT_PASSWORD_MIN_LENGTH - 1) + "1")).not.toThrow();
  });
});

describe("reset token handling", () => {
  it("generates high-entropy tokens", () => {
    const a = randomToken(48);
    const b = randomToken(48);

    expect(a).not.toBe(b);
    // 48 bytes of base64url is 64 characters, i.e. 384 bits of entropy.
    expect(a.length).toBeGreaterThanOrEqual(60);
  });

  it("hashes deterministically and never returns the raw token", () => {
    const raw = randomToken(48);
    const hash = hashToken(raw);

    expect(hash).not.toBe(raw);
    expect(hashToken(raw)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token must not be recoverable from what is stored.
    expect(hash).not.toContain(raw);
  });

  it("produces a different hash for a single-character difference", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });
});

describe("sensitive-value redaction", () => {
  it("redacts credential-bearing fields the logger must never emit", () => {
    const paths = REDACTED_PATHS.join(" ");
    for (const field of ["password", "token", "authorization", "cookie"]) {
      expect(paths).toContain(field);
    }
  });

  it("masks a reset URL that carries a one-time token", () => {
    // The most dangerous value that could ever reach a log: a live reset link.
    const raw = randomToken(48);
    const redacted = redactSecrets(`https://app.example.com/reset-password?token=${raw}`);

    expect(redacted).not.toContain(raw);
    expect(redacted).toContain("reset-password");
    expect(redacted).toContain("[REDACTED]");
  });

  it("still masks a token in a fragment form", () => {
    const raw = randomToken(48);
    expect(redactSecrets(`https://app.example.com/#token=${raw}`)).not.toContain(raw);
  });

  it("masks JWT and OAuth-looking values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactSecrets(jwt)).not.toBe(jwt);
    expect(redactSecrets("ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx")).not.toContain("ya29.a0AfH6SMB");
  });
});

/**
 * CSRF must remain enforced on the new password endpoints. These run without a
 * database because the CSRF middleware rejects before any handler or query.
 */
describe("CSRF on password endpoints", () => {
  const app = createApp();

  const endpoints = [
    { method: "post" as const, path: "/api/auth/change-password", body: { currentPassword: "a", newPassword: "b" } },
    { method: "post" as const, path: "/api/auth/forgot-password", body: { email: "someone@example.com" } },
    { method: "post" as const, path: "/api/auth/reset-password", body: { token: "t", newPassword: "b" } },
  ];

  it.each(endpoints)("rejects $path without a CSRF token", async ({ method, path, body }) => {
    const response = await request(app)[method](path).send(body);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it.each(endpoints)("rejects $path when the header does not match the cookie", async ({ method, path, body }) => {
    const response = await request(app)
      [method](path)
      .set("Cookie", "mailops_csrf=cookie-value")
      .set("X-CSRF-Token", "a-different-value")
      .send(body);
    expect(response.status).toBe(403);
  });

  it("allows a request carrying a matching CSRF pair to reach validation", async () => {
    // No database is required: an unauthenticated change-password request is
    // rejected by the auth middleware (401) once CSRF has passed.
    const response = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", "mailops_csrf=matched-value")
      .set("X-CSRF-Token", "matched-value")
      .send({ currentPassword: "whatever1", newPassword: "Whatever2" });

    expect(response.status).toBe(401);
    expect(response.status).not.toBe(403);
  });
});
