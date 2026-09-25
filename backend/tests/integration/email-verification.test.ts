/**
 * Email verification lifecycle against a real database.
 *
 * The email channel is mocked so the one-time link can be read from the captured
 * message rather than scraped from logs — which also lets the tests assert that the
 * link is *only* ever in the email, never in the database, the audit log or an API
 * response.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendTransactionalEmail } = vi.hoisted(() => ({
  mockSendTransactionalEmail: vi.fn(),
}));

vi.mock("../../src/services/notifications/channels/email.channel", () => ({
  sendTransactionalEmail: mockSendTransactionalEmail,
  emailChannel: { id: "EMAIL", label: "Email", isConfigured: () => true, send: vi.fn() },
}));

import { prisma } from "../../src/config/prisma";
import { hashToken } from "../../src/utils/crypto";
import { AUDIT_ACTIONS } from "../../src/services/audit/audit.service";
import {
  GENERIC_VERIFICATION_MESSAGE,
  loginUser,
  registerUser,
  resendVerification,
  verifyEmail,
} from "../../src/services/auth/auth.service";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const PASSWORD = "VerifyMe1Pass";
/** Email bodies captured during the current test. */
let captured: string[] = [];

function verificationLinks(): string[] {
  return captured
    .map((body) => /verify-email\?token=([^\s&"'<]+)/.exec(body)?.[1])
    .filter((token): token is string => Boolean(token))
    .map((token) => decodeURIComponent(token));
}

function lastLink(): string {
  const links = verificationLinks();
  expect(links.length).toBeGreaterThan(0);
  return links[links.length - 1];
}

function acceptDelivery() {
  mockSendTransactionalEmail.mockImplementation(async (message: { text?: string }) => {
    if (message.text) captured.push(message.text);
    return { ok: true, skipped: false, provider: "smtp", providerMessageId: "msg-1", error: null };
  });
}

describeIntegration("email verification", () => {
  const createdUserIds: string[] = [];

  beforeEach(() => {
    captured = [];
    mockSendTransactionalEmail.mockReset();
    acceptDelivery();
  });

  afterAll(async () => {
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  async function newUser(label: string) {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const result = await registerUser({ email, password: PASSWORD, name: "Verify Test" }, { ip: "203.0.113.5" });
    createdUserIds.push(result.user.id);
    return { email, ...result };
  }

  describe("registration", () => {
    it("starts the account unverified and reports that in the session payload", async () => {
      const { user } = await newUser("register");

      expect(user.emailVerified).toBe(false);
      expect(user.emailVerifiedAt).toBeNull();

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.emailVerifiedAt).toBeNull();
    });

    it("attempts the verification email and records the outcome", async () => {
      const { user } = await newUser("email");

      const verificationMails = mockSendTransactionalEmail.mock.calls.filter(
        (call) => (call[0] as { kind?: string }).kind === "email-verification",
      );
      expect(verificationMails).toHaveLength(1);
      expect((verificationMails[0][0] as { to: string }).to
      ).toBe(user.email);

      const audit = await prisma.auditLog.findFirst({
        where: { userId: user.id, action: AUDIT_ACTIONS.emailVerificationRequested },
      });
      const metadata = audit?.metadata as { delivered?: boolean; expiresInMinutes?: number } | null;
      expect(audit).not.toBeNull();
      expect(metadata?.delivered).toBe(true);
      expect(metadata?.expiresInMinutes).toBeGreaterThan(0);
    });

    it("the email carries branding, purpose, the link and the expiry", async () => {
      await newUser("content");

      const raw = lastLink();
      const body = captured.join("\n");
      expect(body).toMatch(/MailOps/);
      expect(body).toMatch(/Confirm this email address/i);
      expect(body).toContain("/verify-email?token=");
      expect(body).toMatch(/expires/i);
      // The token appears only inside the URL, never as a bare value.
      expect(body).not.toContain(`token: ${raw}`);
    });

    it("stores only a hash of the token, never the raw value", async () => {
      const { user } = await newUser("hash");
      const raw = lastLink();

      const rows = await prisma.emailVerificationToken.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(hashToken(raw));
      expect(rows[0].tokenHash).not.toBe(raw);
      expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].usedAt).toBeNull();

      // And the raw value is nowhere in the audit trail either.
      const audit = await prisma.auditLog.findMany({ where: { userId: user.id } });
      expect(JSON.stringify(audit)).not.toContain(raw);
    });

    it("does not fail registration when the verification email cannot be delivered", async () => {
      mockSendTransactionalEmail.mockResolvedValue({
        ok: false,
        skipped: false,
        provider: "smtp",
        providerMessageId: null,
        error: "connect ETIMEDOUT",
      });

      const { user } = await newUser("nomail");

      // The account exists and can sign in; only the notification failed.
      expect(user.emailVerified).toBe(false);
      await expect(loginUser({ email: user.email, password: PASSWORD })).resolves.toBeTruthy();

      const audit = await prisma.auditLog.findFirst({
        where: { userId: user.id, action: AUDIT_ACTIONS.emailVerificationRequested },
      });
      expect((audit?.metadata as { delivered?: boolean } | null)?.delivered).toBe(false);
    });
  });

  describe("verification", () => {
    it("verifies the account with a valid token", async () => {
      const { user } = await newUser("valid");
      const raw = lastLink();

      const result = await verifyEmail({ token: raw, ip: "203.0.113.5" });
      expect(result.status).toBe("VERIFIED");

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.emailVerifiedAt).not.toBeNull();

      const token = await prisma.emailVerificationToken.findUnique({
        where: { tokenHash: hashToken(raw) },
      });
      expect(token?.usedAt).not.toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: { userId: user.id, action: AUDIT_ACTIONS.emailVerificationCompleted },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(raw);
    });

    it("treats a second use of the same link as already verified, not an error", async () => {
      const { user } = await newUser("reuse");
      const raw = lastLink();

      await expect(verifyEmail({ token: raw })).resolves.toEqual({ status: "VERIFIED" });
      const second = await verifyEmail({ token: raw });
      expect(second.status).toBe("ALREADY_VERIFIED");

      // The original verification timestamp is preserved.
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.emailVerifiedAt).not.toBeNull();
    });

    it("rejects an expired token and audits the rejection", async () => {
      const { user } = await newUser("expired");
      const raw = lastLink();

      await prisma.emailVerificationToken.update({
        where: { tokenHash: hashToken(raw) },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      expect((await verifyEmail({ token: raw })).status).toBe("EXPIRED");
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.emailVerifiedAt).toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: { userId: user.id, action: AUDIT_ACTIONS.emailVerificationRejected },
      });
      expect(audit).not.toBeNull();
    });

    it("rejects a token that was never issued", async () => {
      expect((await verifyEmail({ token: "not-a-real-token" })).status).toBe("INVALID");
    });

    it("does not verify anyone with an empty token", async () => {
      expect((await verifyEmail({ token: "   " })).status).toBe("INVALID");
    });
  });

  describe("resend", () => {
    it("issues a new link and retires the old one", async () => {
      const { user } = await newUser("resend");
      const first = lastLink();

      const result = await resendVerification(user.id, { ip: "203.0.113.5" });
      expect(result.message).toBe(GENERIC_VERIFICATION_MESSAGE);
      expect(result.emailVerified).toBe(false);
      expect(result.sent).toBe(true);

      const second = lastLink();
      expect(second).not.toBe(first);

      // Only one live token may exist for the account.
      const active = await prisma.emailVerificationToken.count({
        where: { userId: user.id, usedAt: null },
      });
      expect(active).toBe(1);

      // The retired link no longer works.
      expect((await verifyEmail({ token: first })).status).toBe("INVALID");

      // …and the new one does.
      expect((await verifyEmail({ token: second })).status).toBe("VERIFIED");
    });

    it("returns the safe generic response for an already-verified account and sends nothing", async () => {
      const { user } = await newUser("verified");
      await verifyEmail({ token: lastLink() });

      mockSendTransactionalEmail.mockClear();
      const result = await resendVerification(user.id);

      expect(result.message).toBe(GENERIC_VERIFICATION_MESSAGE);
      expect(result.emailVerified).toBe(true);
      expect(result.sent).toBe(false);
      expect(mockSendTransactionalEmail).not.toHaveBeenCalled();

      const active = await prisma.emailVerificationToken.count({
        where: { userId: user.id, usedAt: null },
      });
      expect(active).toBe(0);
    });
  });

  describe("login policy", () => {
    it("lets an unverified user sign in and exposes the unverified status", async () => {
      const { email } = await newUser("login-unverified");

      const session = await loginUser({ email, password: PASSWORD });
      expect(session.user.emailVerified).toBe(false);
      expect(session.user.emailVerifiedAt).toBeNull();
    });

    it("reports a verified status once the address is confirmed", async () => {
      const { user, email } = await newUser("login-verified");
      await verifyEmail({ token: lastLink() });

      const session = await loginUser({ email, password: PASSWORD });
      expect(session.user.emailVerified).toBe(true);
      expect(session.user.emailVerifiedAt).not.toBeNull();
      expect(session.user.id).toBe(user.id);
    });
  });
});
