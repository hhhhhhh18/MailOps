/**
 * Password change and reset against a real database.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true. No real mailbox is involved: the
 * console email provider logs the message it would have sent, and the test reads
 * the one-time link from that log. That is exactly the developer workflow, so the
 * test exercises the same path a human uses locally.
 *
 *   docker compose up -d postgres redis
 *   npm run prisma:deploy
 *   RUN_INTEGRATION_TESTS=true npm test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import { logger } from "../../src/config/logger";
import { hashToken } from "../../src/utils/crypto";
import { AUDIT_ACTIONS } from "../../src/services/audit/audit.service";
import {
  GENERIC_RESET_REQUEST_MESSAGE,
  INVALID_RESET_TOKEN_MESSAGE,
  changePassword,
  loginUser,
  refreshSession,
  registerUser,
  requestPasswordReset,
  resetPassword,
  revokeAllSessions,
} from "../../src/services/auth/auth.service";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const PASSWORD_ORIGINAL = "OriginalPass1";
const PASSWORD_NEW = "Replacement2Pass";
const PASSWORD_RESET = "ResetViaLink3";

describeIntegration("password change and reset", () => {
  let userId = "";
  let email = "";

  beforeAll(async () => {
    email = `password-test-${Date.now()}@example.com`;
    const created = await registerUser({ email, password: PASSWORD_ORIGINAL, name: "Password Test" });
    userId = created.user.id;
  });

  afterAll(async () => {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  });

  /** Reads the one-time link out of the console provider's log line. */
  async function captureResetToken(): Promise<string> {
    const spy = vi.spyOn(logger, "info");
    try {
      await requestPasswordReset({ email });
      const logged = spy.mock.calls.find((call) => call[1] === "email (console provider, development)");
      const body = String((logged?.[0] as { body?: string } | undefined)?.body ?? "");
      const match = /reset-password\?token=([^\s&]+)/.exec(body);
      if (!match) throw new Error("the reset link was not present in the development email output");
      return decodeURIComponent(match[1]);
    } finally {
      spy.mockRestore();
    }
  }

  describe("password change", () => {
    it("rejects the wrong current password", async () => {
      await expect(
        changePassword(userId, { currentPassword: "NotThePassword1", newPassword: PASSWORD_NEW }),
      ).rejects.toThrowError(/current password is incorrect/i);
    });

    it("rejects a new password that breaks the policy", async () => {
      await expect(
        changePassword(userId, { currentPassword: PASSWORD_ORIGINAL, newPassword: "nodigitshere" }),
      ).rejects.toThrowError(/letter and one number/i);
    });

    it("rejects reusing the current password", async () => {
      await expect(
        changePassword(userId, { currentPassword: PASSWORD_ORIGINAL, newPassword: PASSWORD_ORIGINAL }),
      ).rejects.toThrowError(/must be different/i);
    });

    it("changes the password and keeps the current session alive", async () => {
      // Start from an empty session set so the revocation count is exact rather
      // than dependent on sessions created by earlier tests.
      await revokeAllSessions(userId);

      const session = await loginUser({ email, password: PASSWORD_ORIGINAL });
      const otherDevice = await loginUser({ email, password: PASSWORD_ORIGINAL });

      const result = await changePassword(
        userId,
        {
          currentPassword: PASSWORD_ORIGINAL,
          newPassword: PASSWORD_NEW,
          keepRefreshToken: session.tokens.refreshToken,
        },
        { ip: "127.0.0.1" },
      );

      // One other session existed and must have been revoked.
      expect(result.revokedSessions).toBe(1);

      // The calling session still works; the other device does not.
      await expect(refreshSession(session.tokens.refreshToken)).resolves.toBeTruthy();
      await expect(refreshSession(otherDevice.tokens.refreshToken)).rejects.toThrow();

      const attempts = await prisma.auditLog.findMany({
        where: { userId, action: AUDIT_ACTIONS.passwordChanged },
      });
      expect(attempts.length).toBeGreaterThanOrEqual(1);
    });

    it("no longer accepts the old password, and accepts the new one", async () => {
      await expect(loginUser({ email, password: PASSWORD_ORIGINAL })).rejects.toThrowError(/incorrect/i);
      await expect(loginUser({ email, password: PASSWORD_NEW })).resolves.toBeTruthy();
    });
  });

  describe("forgot password", () => {
    it("returns one identical generic response for a known and an unknown address", async () => {
      const known = await requestPasswordReset({ email });
      const unknown = await requestPasswordReset({ email: `nobody-${Date.now()}@example.com` });

      expect(known.message).toBe(GENERIC_RESET_REQUEST_MESSAGE);
      expect(unknown.message).toBe(GENERIC_RESET_REQUEST_MESSAGE);
      expect(known.message).toBe(unknown.message);
    });

    it("never discloses account existence through the response shape", async () => {
      const unknown = await requestPasswordReset({ email: "definitely-not-registered@example.com" });
      expect(Object.keys(unknown).sort()).toEqual(["delivered", "emailSentTo", "message"]);
      expect(unknown.emailSentTo).toBeNull();
    });

    it("stores only a hash of the token, never the raw value", async () => {
      const raw = await captureResetToken();

      const rows = await prisma.passwordResetToken.findMany({ where: { userId } });
      expect(rows.length).toBeGreaterThanOrEqual(1);

      // The stored hash is the hash of the link we received…
      const matching = rows.find((row) => row.tokenHash === hashToken(raw));
      expect(matching).toBeDefined();

      // …and no column anywhere contains the raw token.
      const leaks = rows.filter(
        (row) =>
          row.tokenHash === raw ||
          row.id === raw ||
          (row.requestedByIp ?? "") === raw,
      );
      expect(leaks).toHaveLength(0);
      expect(matching?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("retires any previous link when a new one is requested", async () => {
      const first = await captureResetToken();
      await captureResetToken();

      const firstRow = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(first) } });
      expect(firstRow?.usedAt).not.toBeNull();

      // The retired link must not work.
      await expect(resetPassword({ token: first, newPassword: PASSWORD_RESET })).rejects.toThrowError(
        new RegExp(INVALID_RESET_TOKEN_MESSAGE, "i"),
      );
    });

    it("rejects an expired token", async () => {
      const raw = await captureResetToken();
      await prisma.passwordResetToken.update({
        where: { tokenHash: hashToken(raw) },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await expect(resetPassword({ token: raw, newPassword: PASSWORD_RESET })).rejects.toThrowError(
        /invalid or has expired/i,
      );
    });
  });

  describe("reset password", () => {
    let rawToken = "";

    it("accepts a valid token and sets the new password", async () => {
      rawToken = await captureResetToken();

      const before = await loginUser({ email, password: PASSWORD_NEW });
      const result = await resetPassword({ token: rawToken, newPassword: PASSWORD_RESET });
      expect(result.revokedSessions).toBeGreaterThanOrEqual(1);

      // The pre-reset session is dead.
      await expect(refreshSession(before.tokens.refreshToken)).rejects.toThrow();

      // New password works, previous one does not.
      await expect(loginUser({ email, password: PASSWORD_RESET })).resolves.toBeTruthy();
      await expect(loginUser({ email, password: PASSWORD_NEW })).rejects.toThrowError(/incorrect/i);
    });

    it("marks the token used and refuses a second use", async () => {
      const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
      expect(row?.usedAt).not.toBeNull();

      await expect(resetPassword({ token: rawToken, newPassword: "Another4Password" })).rejects.toThrowError(
        /invalid or has expired/i,
      );

      const rejection = await prisma.auditLog.findFirst({
        where: { userId, action: AUDIT_ACTIONS.passwordResetRejected },
      });
      expect(rejection).not.toBeNull();
    });

    it("rejects a token that was never issued, without revealing why", async () => {
      await expect(resetPassword({ token: "not-a-real-token", newPassword: "Another5Password" })).rejects.toThrowError(
        /invalid or has expired/i,
      );
    });

    it("keeps the session-invalidation guarantee on every reset", async () => {
      const fresh = await captureResetToken();
      const session = await loginUser({ email, password: PASSWORD_RESET });

      await resetPassword({ token: fresh, newPassword: "FinalStage6Pass" });
      await expect(refreshSession(session.tokens.refreshToken)).rejects.toThrow();
      await expect(loginUser({ email, password: "FinalStage6Pass" })).resolves.toBeTruthy();

      const completed = await prisma.auditLog.findMany({
        where: { userId, action: AUDIT_ACTIONS.passwordResetCompleted },
      });
      expect(completed.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("the demo account cannot be reset", () => {
    it("returns the generic response and issues no token", async () => {
      const demo = await prisma.user.findFirst({ where: { isDemo: true } });
      if (!demo) return; // nothing seeded in this database

      const before = await prisma.passwordResetToken.count({ where: { userId: demo.id } });
      const result = await requestPasswordReset({ email: demo.email });

      expect(result.message).toBe(GENERIC_RESET_REQUEST_MESSAGE);
      expect(await prisma.passwordResetToken.count({ where: { userId: demo.id } })).toBe(before);
    });
  });
});
