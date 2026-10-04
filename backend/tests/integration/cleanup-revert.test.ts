/**
 * Reverting an executed Gmail cleanup action.
 *
 * The regression covered here: revert used to re-add the INBOX label through
 * `messages.modify` and then record the message as restored. TRASH is a Gmail system
 * label, so modify cannot clear it — the message stayed in Trash (where Gmail purges
 * it after 30 days) while the database and the UI reported success. Untrashing needs
 * the dedicated endpoint, and nothing may be recorded as restored until that call has
 * actually succeeded.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true because it needs PostgreSQL. Gmail itself is
 * mocked — `GmailClient` is replaced so these tests can assert *which* API the service
 * chose, which is the entire point of the fix.
 *
 *   npm run prisma:deploy
 *   RUN_INTEGRATION_TESTS=true npm test
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUntrashMessage, mockAddLabel, mockTrashMessage, mockArchiveMessage } = vi.hoisted(() => ({
  mockUntrashMessage: vi.fn(),
  mockAddLabel: vi.fn(),
  mockTrashMessage: vi.fn(),
  mockArchiveMessage: vi.fn(),
}));

vi.mock("../../src/services/gmail/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/gmail/client")>();
  return {
    ...actual,
    // Only `forAccount` is used by the cleanup service; the rest of the module (e.g.
    // buildScanQuery) is passed through untouched.
    GmailClient: {
      forAccount: async () => ({
        untrashMessage: mockUntrashMessage,
        addLabel: mockAddLabel,
        trashMessage: mockTrashMessage,
        archiveMessage: mockArchiveMessage,
      }),
    } as unknown as typeof actual.GmailClient,
  };
});

import { prisma } from "../../src/config/prisma";
import { revertCleanupAction } from "../../src/services/cleanup/cleanup.service";
import { ERROR_CODES, IntegrationError } from "../../src/utils/errors";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const createdUserIds: string[] = [];

/**
 * Seeds one user with a CONNECTED Gmail account, an email, and an EXECUTED cleanup
 * action of the given type, mirroring the state `executeCleanupBatch` leaves behind.
 */
async function seedExecutedAction(
  type: "DELETE" | "ARCHIVE",
  options: { deletedFromGmail: boolean; status?: "EXECUTED" | "FAILED" },
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const user = await prisma.user.create({
    data: { email: `cleanup-revert-${suffix}@example.com`, passwordHash: "not-a-real-hash" },
  });
  createdUserIds.push(user.id);

  const account = await prisma.gmailAccount.create({
    data: {
      userId: user.id,
      emailAddress: `cleanup-revert-${suffix}@example.com`,
      grantedScopes: [],
    },
  });

  const email = await prisma.email.create({
    data: {
      userId: user.id,
      gmailAccountId: account.id,
      gmailMessageId: `msg_${suffix}`,
      subject: "Weekly deal roundup",
      receivedAt: new Date(),
      deletedFromGmail: options.deletedFromGmail,
      deletedFromMailops: options.deletedFromGmail ? new Date() : null,
    },
  });

  const action = await prisma.cleanupAction.create({
    data: {
      userId: user.id,
      emailId: email.id,
      type,
      status: options.status ?? "EXECUTED",
      executedAt: new Date(),
      batchId: `batch_${suffix}`,
    },
  });

  return { user, email, action };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

describeIntegration("revertCleanupAction — DELETE", () => {
  it("untrashes the message and never touches labels", async () => {
    const { user, email, action } = await seedExecutedAction("DELETE", { deletedFromGmail: true });

    await expect(revertCleanupAction(user.id, action.id)).resolves.toEqual({ reverted: true });

    expect(mockUntrashMessage).toHaveBeenCalledWith(email.gmailMessageId);
    // The core regression: adding INBOX cannot clear the TRASH label.
    expect(mockAddLabel).not.toHaveBeenCalled();
    expect(mockTrashMessage).not.toHaveBeenCalled();
    expect(mockArchiveMessage).not.toHaveBeenCalled();
  });

  it("records the restore only after the untrash succeeded", async () => {
    const { user, email, action } = await seedExecutedAction("DELETE", { deletedFromGmail: true });

    await revertCleanupAction(user.id, action.id);

    const restoredEmail = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(restoredEmail.deletedFromGmail).toBe(false);
    expect(restoredEmail.deletedFromMailops).toBeNull();

    const reverted = await prisma.cleanupAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(reverted.status).toBe("REVERTED");
    expect(reverted.error).toBeNull();
  });

  it("keeps the action EXECUTED and leaves the message flagged deleted when untrash fails", async () => {
    const { user, email, action } = await seedExecutedAction("DELETE", { deletedFromGmail: true });
    mockUntrashMessage.mockRejectedValueOnce(
      new IntegrationError("Gmail API is temporarily unavailable", ERROR_CODES.GMAIL_API_UNAVAILABLE, {
        retryable: true,
      }),
    );

    await expect(revertCleanupAction(user.id, action.id)).rejects.toMatchObject({
      retryable: true,
      code: ERROR_CODES.GMAIL_API_UNAVAILABLE,
    });

    // Still EXECUTED, so the user can try again.
    const stillExecuted = await prisma.cleanupAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(stillExecuted.status).toBe("EXECUTED");
    expect(stillExecuted.error).toMatch(/temporarily unavailable/i);

    // And the message really is still in Trash, so the flag must not have flipped.
    const unchanged = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(unchanged.deletedFromGmail).toBe(true);
    expect(unchanged.deletedFromMailops).not.toBeNull();
  });

  it("wraps a non-IntegrationError as a retryable IntegrationError", async () => {
    const { user, action } = await seedExecutedAction("DELETE", { deletedFromGmail: true });
    mockUntrashMessage.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(revertCleanupAction(user.id, action.id)).rejects.toMatchObject({
      code: ERROR_CODES.GMAIL_API_UNAVAILABLE,
      retryable: true,
    });
  });

  it("is retryable — the same action succeeds once Gmail recovers", async () => {
    const { user, email, action } = await seedExecutedAction("DELETE", { deletedFromGmail: true });

    mockUntrashMessage.mockRejectedValueOnce(
      new IntegrationError("Gmail API request failed", ERROR_CODES.GMAIL_API_UNAVAILABLE, { retryable: true }),
    );
    await expect(revertCleanupAction(user.id, action.id)).rejects.toThrow();

    // Second attempt, Gmail healthy again.
    await expect(revertCleanupAction(user.id, action.id)).resolves.toEqual({ reverted: true });
    expect(mockUntrashMessage).toHaveBeenLastCalledWith(email.gmailMessageId);

    const reverted = await prisma.cleanupAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(reverted.status).toBe("REVERTED");
    expect(reverted.error).toBeNull();
  });
});

describeIntegration("revertCleanupAction — ARCHIVE", () => {
  it("still restores INBOX through modify, and never untrashes", async () => {
    const { user, email, action } = await seedExecutedAction("ARCHIVE", { deletedFromGmail: false });

    await expect(revertCleanupAction(user.id, action.id)).resolves.toEqual({ reverted: true });

    expect(mockAddLabel).toHaveBeenCalledWith(email.gmailMessageId, "INBOX");
    expect(mockUntrashMessage).not.toHaveBeenCalled();

    const reverted = await prisma.cleanupAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(reverted.status).toBe("REVERTED");
  });
});

describeIntegration("revertCleanupAction — guards", () => {
  it("refuses to revert an action that was never executed", async () => {
    const { user, action } = await seedExecutedAction("DELETE", {
      deletedFromGmail: true,
      status: "FAILED",
    });

    await expect(revertCleanupAction(user.id, action.id)).rejects.toThrow(/only executed/i);
    expect(mockUntrashMessage).not.toHaveBeenCalled();
  });

  it("does not let one user revert another user's action", async () => {
    const { action } = await seedExecutedAction("DELETE", { deletedFromGmail: true });
    const other = await seedExecutedAction("DELETE", { deletedFromGmail: true });

    await expect(revertCleanupAction(other.user.id, action.id)).rejects.toThrow(/not found/i);
    expect(mockUntrashMessage).not.toHaveBeenCalled();
  });
});
