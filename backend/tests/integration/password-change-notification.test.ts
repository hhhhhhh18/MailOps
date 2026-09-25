/**
 * Security email sent after a successful password change.
 *
 * The email channel module is mocked so the notification can be inspected
 * directly (arguments, delivery outcome, failure modes) without depending on SMTP
 * or on the console provider's logging. Everything else — the real password
 * hashing, the real database writes, the real session revocation — is exercised
 * unchanged.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Hoisted so the mock factory can reference it. */
const { mockSendTransactionalEmail } = vi.hoisted(() => ({
  mockSendTransactionalEmail: vi.fn(),
}));

vi.mock("../../src/services/notifications/channels/email.channel", () => ({
  sendTransactionalEmail: mockSendTransactionalEmail,
  // Provided so any other module in the graph that imports the registry still
  // resolves; this file only asserts on the transactional path.
  emailChannel: {
    id: "EMAIL",
    label: "Email",
    isConfigured: () => true,
    send: vi.fn(),
  },
}));

// Static imports are fine: `vi.mock` above is hoisted ahead of the module graph,
// so auth.service receives the mocked email channel.
import { prisma } from "../../src/config/prisma";
import { AUDIT_ACTIONS } from "../../src/services/audit/audit.service";
import { changePassword, loginUser, registerUser } from "../../src/services/auth/auth.service";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

/** The security notification is the only transactional email in these tests. */
function securityEmailCalls() {
  return mockSendTransactionalEmail.mock.calls.filter(
    (call) => (call[0] as { kind?: string }).kind === "password-changed",
  );
}

function lastSecurityEmail() {
  const calls = securityEmailCalls();
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as { to: string; subject: string; text: string; html?: string };
}

describeIntegration("password change security email", () => {
  let userId = "";
  let email = "";
  /** Tracks the live password across sequential tests. */
  let current = "OriginalPass1";

  beforeAll(async () => {
    email = `password-notify-${Date.now()}@example.com`;
    const created = await registerUser({ email, password: current, name: "Notify Test" });
    userId = created.user.id;
  });

  afterAll(async () => {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("attempts the security email after a successful change, and records delivery", async () => {
    mockSendTransactionalEmail.mockReset();
    mockSendTransactionalEmail.mockResolvedValue({
      ok: true,
      skipped: false,
      provider: "smtp",
      providerMessageId: "msg-1",
      error: null,
    });

    const next = "SecondStage2Pass";
    await changePassword(userId, { currentPassword: current, newPassword: next }, { ip: "203.0.113.7" });
    current = next;

    const calls = securityEmailCalls();
    expect(calls).toHaveLength(1);

    const sent = lastSecurityEmail();
    expect(sent.to).toBe(email);
    expect(sent.subject).toMatch(/password was changed/i);
    expect(sent.text).toMatch(/did NOT change your password/i);
    expect(sent.text).toMatch(/Forgot password\?/i);

    const audit = await prisma.auditLog.findFirst({
      where: { userId, action: AUDIT_ACTIONS.passwordChanged },
      orderBy: { createdAt: "desc" },
    });
    const metadata = audit?.metadata as { securityEmail?: { attempted?: boolean; sent?: boolean } } | null;
    expect(metadata?.securityEmail?.attempted).toBe(true);
    expect(metadata?.securityEmail?.sent).toBe(true);
  });

  it.each([
    ["a wrong current password", "NotMyPassword1"],
    ["a weak new password", "nodigitshere"],
    ["the current password again", null],
  ])("does not send an email when the change is rejected for %s", async (_label, newPassword) => {
    mockSendTransactionalEmail.mockReset();
    mockSendTransactionalEmail.mockResolvedValue({ ok: true, skipped: false, provider: "smtp", error: null });

    await expect(
      changePassword(userId, {
        currentPassword: _label === "a wrong current password" ? "NotMyPassword1" : current,
        newPassword: newPassword ?? current,
      }),
    ).rejects.toThrow();

    expect(securityEmailCalls()).toHaveLength(0);

    // The password really is unchanged: the previous value still authenticates.
    await expect(loginUser({ email, password: current })).resolves.toBeTruthy();
  });

  it("never includes password, hash, token or session material in the body", async () => {
    mockSendTransactionalEmail.mockReset();
    mockSendTransactionalEmail.mockResolvedValue({ ok: true, skipped: false, provider: "smtp", error: null });

    const session = await loginUser({ email, password: current });
    const next = "ThirdStage3Pass";
    await changePassword(
      userId,
      { currentPassword: current, newPassword: next, keepRefreshToken: session.tokens.refreshToken },
      { ip: "198.51.100.9" },
    );

    const sent = lastSecurityEmail();
    const body = `${sent.text}${sent.html ?? ""}`;

    // No plaintext credentials, in either direction.
    expect(body).not.toContain(next);
    expect(body).not.toContain(current);
    // No hash-shaped value (bcrypt hashes are 60 chars; HMAC-SHA256 is 64 hex).
    expect(body).not.toMatch(/\$2[aby]\$/);
    expect(body).not.toMatch(/\b[0-9a-f]{64}\b/);
    // No session or token material.
    expect(body).not.toContain(session.tokens.refreshToken);
    expect(body).not.toContain(session.tokens.accessToken);
    expect(body).not.toMatch(/mailops_rt|mailops_at|mailops_csrf|Bearer\s|token=/i);

    current = next;
  });

  it("keeps the change successful when delivery fails, and records the failure", async () => {
    mockSendTransactionalEmail.mockReset();
    // The provider contract reports failure rather than throwing.
    mockSendTransactionalEmail.mockResolvedValue({
      ok: false,
      skipped: false,
      provider: "smtp",
      providerMessageId: null,
      error: "connect ETIMEDOUT mail.example.com:587",
    });

    const next = "FourthStage4Pass";
    const result = await changePassword(userId, { currentPassword: current, newPassword: next });
    current = next;

    // The change stands: the call resolved and the new password works.
    expect(result.revokedSessions).toBeGreaterThanOrEqual(0);
    await expect(loginUser({ email, password: next })).resolves.toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { userId, action: AUDIT_ACTIONS.passwordChanged },
      orderBy: { createdAt: "desc" },
    });
    const metadata = audit?.metadata as {
      securityEmail?: { sent?: boolean; reason?: string | null };
    } | null;
    expect(metadata?.securityEmail?.sent).toBe(false);
    expect(metadata?.securityEmail?.reason).toContain("ETIMEDOUT");
  });

  it("keeps the change successful even if the provider throws", async () => {
    mockSendTransactionalEmail.mockReset();
    mockSendTransactionalEmail.mockRejectedValue(new Error("provider exploded"));

    const next = "FifthStage5Pass";
    await expect(changePassword(userId, { currentPassword: current, newPassword: next })).resolves.toBeTruthy();
    current = next;

    await expect(loginUser({ email, password: next })).resolves.toBeTruthy();
    expect(securityEmailCalls()).toHaveLength(1);
  });
});
