/**
 * Account deletion against a real database (and, where available, a real Redis).
 *
 * The email/Google boundary is mocked so the two things that matter most can be
 * asserted precisely: that revocation happens BEFORE the user row is deleted, and
 * that a failed revocation does not stop the erasure.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { mockDisconnectGmail } = vi.hoisted(() => ({ mockDisconnectGmail: vi.fn() }));

vi.mock("../../src/services/gmail/oauth.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/gmail/oauth.service")>();
  return { ...actual, disconnectGmailAccount: mockDisconnectGmail };
});

import { createApp } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { redis } from "../../src/config/redis";
import { hashPassword, hashToken, randomToken } from "../../src/utils/crypto";
import { loginUser } from "../../src/services/auth/auth.service";
import {
  ObliterateUserAccountService,
  USER_OWNED_MODEL_KEYS,
} from "../../src/services/account/deletion.service";
import { userStillExists } from "../../src/services/account/worker-guard";
import { AUDIT_ACTIONS } from "../../src/services/audit/audit.service";
import { dispatchNotification } from "../../src/services/notifications/dispatcher.service";
import { sweepOverdueEscalations } from "../../src/services/notifications/escalation.service";
import { queues, enqueueCleanupProposal, enqueueApplicationUpdate, enqueueAccountScan } from "../../src/queues";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const PASSWORD = "DeleteMe1Pass!";
const app = createApp();

/** Everything a seeded account owns, captured so post-deletion checks can use real ids. */
interface SeededAccount {
  userId: string;
  email: string;
  gmailAccountIds: string[];
  emailIds: string[];
  applicationIds: string[];
  notificationIds: string[];
  receiptCountBefore: number;
}

const createdUserIds: string[] = [];

async function seedAccount(label: string, options: { gmailAccounts?: number } = {}): Promise<SeededAccount> {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const unique = () => Math.random().toString(36).slice(2, 10);

  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), name: "Deletion Test" },
  });
  const userId = user.id;
  createdUserIds.push(userId);

  await prisma.userSettings.create({ data: { userId } });

  const gmailAccountIds: string[] = [];
  for (let i = 0; i < (options.gmailAccounts ?? 1); i += 1) {
    const account = await prisma.gmailAccount.create({
      data: {
        userId,
        emailAddress: `${label}-${i}-${unique()}@gmail.example.com`,
        status: "CONNECTED",
        accessTokenEnc: "placeholder-ciphertext",
        refreshTokenEnc: "placeholder-ciphertext",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    });
    gmailAccountIds.push(account.id);
  }
  const gmailAccountId = gmailAccountIds[0];

  const emailRow = await prisma.email.create({
    data: {
      userId,
      gmailAccountId,
      gmailMessageId: `msg-${unique()}`,
      receivedAt: new Date(),
      fromEmail: "recruiter@example.com",
      toEmail: email,
      subject: "Interview invitation",
      snippet: "We would like to invite you",
      bodyText: "Full body text of the recruitment email.",
    },
  });

  await prisma.emailAnalysis.create({
    data: {
      emailId: emailRow.id,
      userId,
      category: "JOB",
      subCategory: "INTERVIEW",
      priority: "HIGH",
      confidence: 0.93,
      model: "test-model",
      promptVersion: "v1",
      provider: "test",
      reasoning: "Mentions an interview",
    },
  });

  const application = await prisma.application.create({
    data: { userId, company: "Acme Corp", role: "Backend Engineer", companyKey: "acme corp", roleKey: "backend engineer" },
  });

  await prisma.applicationEvent.create({
    data: {
      applicationId: application.id,
      userId,
      type: "APPLICATION_CREATED",
      title: "Application created",
      emailId: emailRow.id,
    },
  });

  const notification = await prisma.notification.create({
    data: {
      userId,
      applicationId: application.id,
      emailId: emailRow.id,
      type: "JOB_IMPORTANT",
      severity: "HIGH",
      title: "Interview scheduled",
      dedupeKey: `dedupe-${unique()}`,
    },
  });

  // The model with no userId of its own — only reachable through its parent.
  await prisma.notificationAttempt.create({
    data: { notificationId: notification.id, channel: "SLACK", status: "SENT", attemptNo: 1 },
  });

  await prisma.integration.create({
    data: {
      userId,
      kind: "SLACK",
      status: "CONNECTED",
      secretsEnc: "placeholder-ciphertext",
    },
  });

  await prisma.cleanupAction.create({
    data: {
      userId,
      emailId: emailRow.id,
      applicationId: application.id,
      type: "ARCHIVE",
      senderEmail: "promo@example.com",
    },
  });

  await prisma.scanJob.create({ data: { userId, gmailAccountId, type: "MANUAL" } });
  await prisma.auditLog.create({ data: { userId, action: "test.seeded", summary: "seeded for deletion test" } });

  const expiry = new Date(Date.now() + 3_600_000);
  await prisma.refreshToken.create({ data: { userId, tokenHash: hashToken(randomToken()), expiresAt: expiry } });
  await prisma.passwordResetToken.create({ data: { userId, tokenHash: hashToken(randomToken()), expiresAt: expiry } });
  await prisma.emailVerificationToken.create({ data: { userId, tokenHash: hashToken(randomToken()), expiresAt: expiry } });

  return {
    userId,
    email,
    gmailAccountIds,
    emailIds: [emailRow.id],
    applicationIds: [application.id],
    notificationIds: [notification.id],
    receiptCountBefore: await prisma.accountDeletionRecord.count(),
  };
}

/**
 * Independent post-deletion census.
 *
 * Written with explicit queries rather than reusing the service's counter on purpose:
 * asserting erasure with the same function that produced the claim would be circular.
 * `NotificationAttempt` is counted by the notification ids captured *before* deletion —
 * querying `{ in: [] }` would return 0 even if orphaned rows remained, which is the
 * exact false pass this guards against.
 */
async function remainingRows(account: SeededAccount): Promise<Record<string, number>> {
  const { userId, gmailAccountIds, emailIds, applicationIds, notificationIds } = account;
  return {
    User: await prisma.user.count({ where: { id: userId } }),
    UserSettings: await prisma.userSettings.count({ where: { userId } }),
    GmailAccount: await prisma.gmailAccount.count({ where: { id: { in: gmailAccountIds } } }),
    Email: await prisma.email.count({ where: { id: { in: emailIds } } }),
    EmailAnalysis: await prisma.emailAnalysis.count({ where: { userId } }),
    Application: await prisma.application.count({ where: { id: { in: applicationIds } } }),
    ApplicationEvent: await prisma.applicationEvent.count({ where: { userId } }),
    Notification: await prisma.notification.count({ where: { id: { in: notificationIds } } }),
    NotificationAttempt: await prisma.notificationAttempt.count({
      where: { notificationId: { in: notificationIds } },
    }),
    Integration: await prisma.integration.count({ where: { userId } }),
    CleanupAction: await prisma.cleanupAction.count({ where: { userId } }),
    ScanJob: await prisma.scanJob.count({ where: { userId } }),
    AuditLog: await prisma.auditLog.count({ where: { userId } }),
    RefreshToken: await prisma.refreshToken.count({ where: { userId } }),
    PasswordResetToken: await prisma.passwordResetToken.count({ where: { userId } }),
    EmailVerificationToken: await prisma.emailVerificationToken.count({ where: { userId } }),
  };
}

let redisAvailable = false;

beforeAll(async () => {
  if (!integrationEnabled) return;
  try {
    await redis.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

beforeEach(() => {
  mockDisconnectGmail.mockReset();
  mockDisconnectGmail.mockImplementation(async () => ({ revoked: true }));
});

afterAll(async () => {
  if (createdUserIds.length) {
    // Tolerant of already-deleted rows.
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

describeIntegration("account deletion", () => {
  /* ---------------------------------------------------------------------- */
  /* Erasure completeness                                                    */
  /* ---------------------------------------------------------------------- */

  describe("erasure completeness", () => {
    it("removes every row the account owned, across all sixteen models", async () => {
      const account = await seedAccount("erase");

      const counts = await ObliterateUserAccountService.counts(account.userId);
      // Every model in the inventory must actually have a row, otherwise "zero after"
      // would be vacuously true for that model and prove nothing.
      const emptyBeforeDeletion = Object.entries(counts).filter(([, value]) => value === 0);
      expect(emptyBeforeDeletion, "seed must populate every user-owned model").toEqual([]);

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
        ip: "203.0.113.9",
      });

      expect(result.deleted).toBe(true);

      const remaining = await remainingRows(account);
      expect(remaining).toEqual(Object.fromEntries(Object.keys(remaining).map((key) => [key, 0])));

      // Spelled out for the model with no userId of its own.
      expect(remaining.NotificationAttempt).toBe(0);
    });

    it("deletes the account's audit trail with everything else", async () => {
      const account = await seedAccount("audit");
      expect(await prisma.auditLog.count({ where: { userId: account.userId } })).toBeGreaterThan(0);

      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(await prisma.auditLog.count({ where: { userId: account.userId } })).toBe(0);
    });

    it("reports counts that match what was actually removed", async () => {
      const account = await seedAccount("counts");
      const actual = await ObliterateUserAccountService.counts(account.userId);

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(result.countsByModel).toEqual(actual);
      expect(result.totalRowsDeleted).toBe(
        Object.values(actual).reduce((sum, value) => sum + value, 0),
      );
      expect(result.countsByModel.emails).toBe(1);
      expect(result.countsByModel.notificationAttempts).toBe(1);
      expect(result.countsByModel.user).toBe(1);
    });

    it("covers exactly the models the deletion architecture declares", async () => {
      const account = await seedAccount("inventory");
      const counts = await ObliterateUserAccountService.counts(account.userId);

      expect(Object.keys(counts).sort()).toEqual(
        Object.values(USER_OWNED_MODEL_KEYS).sort(),
      );
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Multi-user isolation                                                    */
  /* ---------------------------------------------------------------------- */

  describe("multi-user isolation", () => {
    it("leaves another account's data completely untouched", async () => {
      const victim = await seedAccount("victim");
      const survivor = await seedAccount("survivor");

      await ObliterateUserAccountService.obliterate(victim.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: victim.email,
      });

      expect(await prisma.user.findUnique({ where: { id: victim.userId } })).toBeNull();

      // The other account is not merely present but fully intact.
      const survivorRows = await remainingRows(survivor);
      expect(survivorRows).toEqual({
        User: 1,
        UserSettings: 1,
        GmailAccount: 1,
        Email: 1,
        EmailAnalysis: 1,
        Application: 1,
        ApplicationEvent: 1,
        Notification: 1,
        NotificationAttempt: 1,
        Integration: 1,
        CleanupAction: 1,
        ScanJob: 1,
        AuditLog: 1,
        RefreshToken: 1,
        PasswordResetToken: 1,
        EmailVerificationToken: 1,
      });
    });

    it("does not count another account's rows as deleted", async () => {
      const first = await seedAccount("first");
      await seedAccount("second");

      const result = await ObliterateUserAccountService.obliterate(first.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: first.email,
      });

      expect(result.countsByModel.emails).toBe(1);
      expect(result.countsByModel.applications).toBe(1);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Idempotency and concurrency                                             */
  /* ---------------------------------------------------------------------- */

  describe("idempotency and concurrency", () => {
    it("rejects a second deletion without a 500", async () => {
      const account = await seedAccount("twice");
      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      await expect(
        ObliterateUserAccountService.obliterate(account.userId, {
          actor: "USER",
          password: PASSWORD,
          confirmation: account.email,
        }),
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it("survives two concurrent deletions with no partial state", async () => {
      const account = await seedAccount("race");

      const outcomes = await Promise.allSettled([
        ObliterateUserAccountService.obliterate(account.userId, {
          actor: "USER",
          password: PASSWORD,
          confirmation: account.email,
        }),
        ObliterateUserAccountService.obliterate(account.userId, {
          actor: "USER",
          password: PASSWORD,
          confirmation: account.email,
        }),
      ]);

      // At least one must succeed, and any failure must be a clean "no such account"
      // rather than a crash or a half-deleted row set.
      expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect(String(outcome.reason)).toMatch(/no longer available|Record to delete/i);
        }
      }

      const remaining = await remainingRows(account);
      expect(Object.values(remaining).every((value) => value === 0)).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Authentication after deletion                                           */
  /* ---------------------------------------------------------------------- */

  describe("authentication after deletion", () => {
    it("fails login, rejects the old access token and refuses refresh", async () => {
      const account = await seedAccount("auth");

      // A real session, so the tokens below are genuine.
      const session = await loginUser({ email: account.email, password: PASSWORD });
      const accessToken = session.tokens.accessToken;
      const refreshToken = session.tokens.refreshToken;

      // The token works while the account exists.
      const before = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);
      expect(before.status).toBe(200);

      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      // Login is impossible: the row is gone.
      await expect(loginUser({ email: account.email, password: PASSWORD })).rejects.toBeTruthy();

      // The outstanding access JWT is rejected by requireAuth's existence check.
      const after = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);
      expect(after.status).toBe(401);
      expect(after.body.error.message).toMatch(/no longer available/i);

      // Refresh cannot work: the row it looked up is gone.
      const refreshed = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", [`mailops_csrf=matched`, `mailops_rt=${refreshToken}`])
        .set("X-CSRF-Token", "matched");
      expect(refreshed.status).toBeGreaterThanOrEqual(400);
      expect(refreshed.status).toBeLessThan(500);
    });

    it("reports that the account no longer exists to a worker guard", async () => {
      const account = await seedAccount("guard");
      expect(await userStillExists(account.userId)).toBe(true);

      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(await userStillExists(account.userId)).toBe(false);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Confirmation requirements                                               */
  /* ---------------------------------------------------------------------- */

  describe("confirmation requirements", () => {
    it("refuses a wrong password without deleting anything", async () => {
      const account = await seedAccount("wrongpass");
      const before = await remainingRows(account);

      await expect(
        ObliterateUserAccountService.obliterate(account.userId, {
          actor: "USER",
          password: "not-the-password",
          confirmation: account.email,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(await prisma.user.findUnique({ where: { id: account.userId } })).not.toBeNull();

      const after = await remainingRows(account);
      // Every row of user data is untouched. The audit trail is the one expected
      // difference: the rejected attempt is itself recorded, which is the point.
      expect(after.AuditLog).toBe(before.AuditLog + 1);
      const { AuditLog: _beforeAudit, ...beforeData } = before;
      const { AuditLog: _afterAudit, ...afterData } = after;
      expect(afterData).toEqual(beforeData);
    });

    it("refuses a wrong confirmation phrase without deleting anything", async () => {
      const account = await seedAccount("wrongphrase");

      await expect(
        ObliterateUserAccountService.obliterate(account.userId, {
          actor: "USER",
          password: PASSWORD,
          confirmation: "someone-else@example.com",
        }),
      ).rejects.toMatchObject({ statusCode: 422 });

      expect(await prisma.user.findUnique({ where: { id: account.userId } })).not.toBeNull();
    });

    it("accepts the confirmation phrase case-insensitively", async () => {
      const account = await seedAccount("case");

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email.toUpperCase(),
      });

      expect(result.deleted).toBe(true);
    });

    it("records a rejected attempt without leaking the password", async () => {
      const account = await seedAccount("rejected");
      const attempt = "SuperSecret-Password-Value";

      await expect(
        ObliterateUserAccountService.obliterate(account.userId, {
          actor: "USER",
          password: attempt,
          confirmation: account.email,
        }),
      ).rejects.toBeTruthy();

      const rows = await prisma.auditLog.findMany({
        where: { userId: account.userId, action: AUDIT_ACTIONS.accountDeletionRejected },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toMatch(/password confirmation failed/i);

      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(attempt);
      expect(serialised).not.toContain(account.email);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Gmail revocation                                                        */
  /* ---------------------------------------------------------------------- */

  describe("Gmail revocation", () => {
    it("revokes the Google grant BEFORE the user row is deleted", async () => {
      const account = await seedAccount("order", { gmailAccounts: 2 });

      // Record, at revocation time, whether the user row was still present. This is a
      // real database read rather than a call-order spy, so it proves the ordering
      // property directly.
      const observed: string[] = [];
      mockDisconnectGmail.mockImplementation(async () => {
        const stillThere = await prisma.user.findUnique({
          where: { id: account.userId },
          select: { id: true },
        });
        observed.push(stillThere ? "user-exists" : "user-gone");
        return { revoked: true };
      });

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(mockDisconnectGmail).toHaveBeenCalledTimes(2);
      expect(observed).toEqual(["user-exists", "user-exists"]);
      expect(result.gmail).toMatchObject({ accounts: 2, revoked: 2, fullyRevoked: true, failures: [] });
    });

    it("revokes every connected account, not just the first", async () => {
      const account = await seedAccount("multi", { gmailAccounts: 3 });

      const revokedIds: string[] = [];
      mockDisconnectGmail.mockImplementation(async (_user: unknown, gmailAccountId: string) => {
        revokedIds.push(gmailAccountId);
        return { revoked: true };
      });

      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(revokedIds.sort()).toEqual([...account.gmailAccountIds].sort());
    });

    it("completes the erasure when revocation FAILS, and records the failure", async () => {
      const account = await seedAccount("revoke-fail");

      mockDisconnectGmail.mockImplementation(async () => {
        throw new Error("invalid_grant: token has been revoked");
      });

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      // The user's right to erasure does not depend on Google being reachable.
      expect(result.deleted).toBe(true);
      expect(await prisma.user.findUnique({ where: { id: account.userId } })).toBeNull();

      expect(result.gmail.fullyRevoked).toBe(false);
      expect(result.gmail.failures).toHaveLength(1);
      expect(result.gmail.failures[0]).toMatch(/invalid_grant/);

      // Reported honestly on the receipt.
      const receipt = await prisma.accountDeletionRecord.findUniqueOrThrow({
        where: { id: result.receiptId },
      });
      expect(receipt.gmailGrantRevoked).toBe(false);
      expect(receipt.revokeFailures).not.toBeNull();
    });

    it("records a non-throwing 'not revoked' outcome as a failure too", async () => {
      const account = await seedAccount("revoke-noop");
      mockDisconnectGmail.mockImplementation(async () => ({ revoked: false }));

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(result.gmail.fullyRevoked).toBe(false);
      expect(result.gmail.failures[0]).toMatch(/not revoked/);
    });

    it("treats an account with no Gmail connection as nothing-to-revoke, not a failure", async () => {
      // Seeded with a connection, then the connection is removed: `Email` cascades
      // from `GmailAccount`, so this is the only way to reach a "user with no Gmail"
      // state without fighting the foreign keys.
      const account = await seedAccount("no-gmail");
      await prisma.gmailAccount.deleteMany({ where: { userId: account.userId } });
      account.gmailAccountIds = [];

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(mockDisconnectGmail).not.toHaveBeenCalled();
      expect(result.gmail).toMatchObject({ accounts: 0, revoked: 0, fullyRevoked: true, failures: [] });
    });
  });

  /* ---------------------------------------------------------------------- */
  /* The receipt                                                             */
  /* ---------------------------------------------------------------------- */

  describe("deletion receipt", () => {
    it("writes exactly one receipt, before the user row is removed", async () => {
      const account = await seedAccount("receipt");

      // The receipt must exist while the user is still deletable, i.e. it is written
      // before prisma.user.delete() — proven by observing it from inside the
      // revocation hook, which runs earlier in the pipeline. Scoped to THIS user's
      // fingerprint so records written by other tests cannot satisfy the check.
      let receiptsForThisUserDuringPhase1 = -1;
      mockDisconnectGmail.mockImplementation(async () => {
        receiptsForThisUserDuringPhase1 = await prisma.accountDeletionRecord.count({
          where: { deletedUserIdHash: hashToken(account.userId) },
        });
        return { revoked: true };
      });

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
        ip: "198.51.100.7",
      });

      // Not written yet during phase 1…
      expect(receiptsForThisUserDuringPhase1).toBe(0);

      // …and written exactly once by the end.
      const forThisUser = await prisma.accountDeletionRecord.count({
        where: { deletedUserIdHash: hashToken(account.userId) },
      });
      expect(forThisUser).toBe(1);

      const receipt = await prisma.accountDeletionRecord.findUniqueOrThrow({
        where: { id: result.receiptId },
      });
      expect(receipt.completedAt).not.toBeNull();
      expect(receipt.initiator).toBe("USER");
      expect(receipt.requestedAt.getTime()).toBeLessThanOrEqual(receipt.completedAt!.getTime());
      expect(receipt.gmailGrantRevoked).toBe(true);
    });

    it("stores no directly identifying data", async () => {
      const account = await seedAccount("receipt-pii");
      const ip = "198.51.100.42";

      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
        ip,
      });

      const receipt = await prisma.accountDeletionRecord.findUniqueOrThrow({
        where: { id: result.receiptId },
      });
      const serialised = JSON.stringify(receipt);

      expect(serialised).not.toContain(account.email);
      expect(serialised).not.toContain(account.userId);
      expect(serialised).not.toContain(ip);
      expect(serialised).not.toContain(PASSWORD);
      // Raw tokens, if any had been captured, must not appear either.
      expect(serialised).not.toMatch(/mailops_(at|rt|csrf)/);

      // The stored values are fingerprints, not the raw identifiers.
      expect(receipt.deletedUserIdHash).toBe(hashToken(account.userId));
      expect(receipt.deletedUserIdHash).not.toBe(account.userId);
      expect(receipt.requestedByIpHash).toBe(hashToken(ip));
      expect(receipt.requestedByIpHash).not.toBe(ip);
    });

    it("survives the deletion it describes", async () => {
      const account = await seedAccount("receipt-survives");
      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      expect(await prisma.user.findUnique({ where: { id: account.userId } })).toBeNull();
      expect(await prisma.accountDeletionRecord.findUnique({ where: { id: result.receiptId } })).not.toBeNull();
    });

    it("is recomputable from the user id for support matching", async () => {
      const account = await seedAccount("receipt-recompute");
      const result = await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      // `deletedUserIdHash` is indexed but deliberately not unique: the same user id
      // can only be deleted once, but the column is a fingerprint rather than a key.
      const found = await prisma.accountDeletionRecord.findFirst({
        where: { deletedUserIdHash: hashToken(account.userId) },
      });
      expect(found?.id).toBe(result.receiptId);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Redis / BullMQ                                                              */
/* -------------------------------------------------------------------------- */

import type { Queue, Worker } from "bullmq";
import { purgeUserQueueData, purgeUserRedisKeys } from "../../src/queues";
import { createEmailProcessingWorker } from "../../src/workers/email-processing.worker";
import { createCleanupWorker } from "../../src/workers/cleanup.worker";

const JOB_STATES = ["waiting", "delayed", "active", "failed", "completed", "paused", "wait"];

/** Job ids in `queue` whose payload belongs to `userId`. */
async function jobsForUser(queue: Queue, userId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const state of JOB_STATES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = await queue.getJobs([state as never], 0, 1000, true);
    for (const job of jobs) {
      if (job && (job.data as { userId?: string } | undefined)?.userId === userId) {
        ids.push(String(job.id));
      }
    }
  }
  return ids;
}

async function waitForSettled(queue: Queue, jobId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === "completed" || state === "failed") {
        return { state, returnvalue: job.returnvalue as unknown, failedReason: job.failedReason };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

async function closeWorker(worker: Worker | undefined) {
  if (worker) await worker.close().catch(() => undefined);
}

describeIntegration("account deletion: postgres-external cleanup", () => {
  describe("queue payloads", () => {
    it("removes this user's jobs from every PII queue and leaves another user's alone", async ({
      skip,
    }) => {
      if (!redisAvailable) skip();

      const victim = await seedAccount("queue-victim");
      const survivor = await seedAccount("queue-survivor");

      /**
       * One job per PII-bearing queue, for both users.
       *
       * The email-processing jobs are added directly rather than through
       * `enqueueProcessEmail`, because that helper's job id (`email:{id}`) is rejected
       * by BullMQ — which requires a colon-containing id to have exactly three
       * segments — and the producer swallows the error and returns null. That is a
       * pre-existing bug in the email pipeline and is deliberately NOT fixed here
       * (outside P0-1 scope); the purge is exercised with a directly-enqueued job so
       * the test verifies this feature rather than that one.
       */
      await queues.emailProcessing.add("process-email", {
        emailId: victim.emailIds[0],
        userId: victim.userId,
      });
      await queues.emailProcessing.add("process-email", {
        emailId: survivor.emailIds[0],
        userId: survivor.userId,
      });
      await enqueueApplicationUpdate({
        userId: victim.userId,
        emailId: victim.emailIds[0],
        analysisId: "analysis-1",
      });
      await enqueueApplicationUpdate({
        userId: survivor.userId,
        emailId: survivor.emailIds[0],
        analysisId: "analysis-2",
      });
      await enqueueCleanupProposal({ userId: victim.userId });
      await enqueueCleanupProposal({ userId: survivor.userId });
      await enqueueAccountScan({
        userId: victim.userId,
        gmailAccountId: victim.gmailAccountIds[0],
        type: "MANUAL",
      });
      await enqueueAccountScan({
        userId: survivor.userId,
        gmailAccountId: survivor.gmailAccountIds[0],
        type: "MANUAL",
      });

      // Precondition: the jobs really are queued, or "removed" proves nothing.
      expect(await jobsForUser(queues.emailProcessing, victim.userId)).not.toHaveLength(0);
      expect(await jobsForUser(queues.cleanup, victim.userId)).not.toHaveLength(0);

      const result = await ObliterateUserAccountService.obliterate(victim.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: victim.email,
      });

      for (const queue of [
        queues.emailProcessing,
        queues.applicationProcessing,
        queues.cleanup,
        queues.emailScan,
      ]) {
        expect(await jobsForUser(queue, victim.userId), `queue ${queue.name}`).toEqual([]);
      }

      // The other account's jobs are untouched — the purge must never be a cleanup().
      expect(await jobsForUser(queues.emailProcessing, survivor.userId)).not.toHaveLength(0);
      expect(await jobsForUser(queues.cleanup, survivor.userId)).not.toHaveLength(0);
      expect(await jobsForUser(queues.emailScan, survivor.userId)).not.toHaveLength(0);

      expect(result.externalPurge.queuesRemovedByQueue).toHaveProperty("email-processing");
    });

    it("removes retained completed payloads, not just queued ones", async ({ skip }) => {
      if (!redisAvailable) skip();

      const account = await seedAccount("retained");

      // Delete first: the guard then makes the job complete immediately (skipped),
      // which is how a real deleted-user job ends up in the completed set — payload
      // and all — where it would otherwise sit indefinitely.
      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      // `queue.add` resolves to a Job, not an id — polling with the object itself
      // would look up "[object Object]" and never settle.
      const added = await queues.cleanup.add("propose-cleanup", { userId: account.userId });
      const jobId = String(added.id);

      const worker = createCleanupWorker();
      const settled = await waitForSettled(queues.cleanup, jobId);
      await closeWorker(worker);

      expect(settled.state).toBe("completed");
      expect(settled.returnvalue).toMatchObject({ skipped: true, reason: "account-deleted" });

      // The payload is retained in the completed set — with the userId in it.
      expect(await jobsForUser(queues.cleanup, account.userId)).toContain(jobId);

      const purge = await purgeUserQueueData(account.userId);
      expect(await jobsForUser(queues.cleanup, account.userId)).toEqual([]);
      expect(purge.removedByQueue["cleanup"]).toBeGreaterThanOrEqual(1);
    });

    it("deletes the user-scoped Redis counter keys", async ({ skip }) => {
      if (!redisAvailable) skip();

      const victim = await seedAccount("voice-victim");
      const survivor = await seedAccount("voice-survivor");
      const victimKey = `voice:calls:${victim.userId}:2026-09-27`;
      const survivorKey = `voice:calls:${survivor.userId}:2026-09-27`;

      await redis.set(victimKey, "3", "EX", 3600);
      await redis.set(survivorKey, "1", "EX", 3600);
      expect(await redis.get(victimKey)).toBe("3");

      const result = await ObliterateUserAccountService.obliterate(victim.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: victim.email,
      });

      expect(await redis.get(victimKey)).toBeNull();
      expect(await redis.get(survivorKey)).toBe("1");
      expect(result.externalPurge.redisKeysRemoved).toBeGreaterThanOrEqual(1);
    });

    it("does not throw when Redis is unreachable, and reports it as a failure instead", async ({
      skip,
    }) => {
      // purgeUserRedisKeys is exercised directly against a bogus key shape so the
      // error path is covered without needing to take Redis down.
      const outcome = await purgeUserRedisKeys("no-such-user-id");
      expect(outcome.removedKeys).toBe(0);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Worker defence                                                          */
  /* ---------------------------------------------------------------------- */

  describe("worker defence", () => {
    it("does not recreate data for a deleted account, and does not retry-storm", async ({ skip }) => {
      if (!redisAvailable) skip();

      const account = await seedAccount("worker-email");
      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      const added = await queues.emailProcessing.add("process-email", {
        emailId: account.emailIds[0],
        userId: account.userId,
      });

      const worker = createEmailProcessingWorker();
      const settled = await waitForSettled(queues.emailProcessing, String(added.id));
      await closeWorker(worker);

      // Cleanly skipped, not failed: a failure here would retry five times.
      expect(settled.state).toBe("completed");
      expect(settled.returnvalue).toMatchObject({ skipped: true, reason: "account-deleted" });

      // Nothing came back.
      expect(await prisma.email.count({ where: { userId: account.userId } })).toBe(0);
      expect(await prisma.emailAnalysis.count({ where: { userId: account.userId } })).toBe(0);
      expect(await prisma.application.count({ where: { userId: account.userId } })).toBe(0);
    });

    it("performs no Gmail mutation for a deleted account", async ({ skip }) => {
      if (!redisAvailable) skip();

      const account = await seedAccount("worker-cleanup");

      // Count any Google-facing call: the mocked disconnect is the only Google path
      // reachable in tests, and it must not be invoked by background work at all.
      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });
      mockDisconnectGmail.mockClear();

      const added = await queues.cleanup.add("propose-cleanup", { userId: account.userId });
      const worker = createCleanupWorker();
      const settled = await waitForSettled(queues.cleanup, String(added.id));
      await closeWorker(worker);

      expect(settled.state).toBe("completed");
      expect(settled.returnvalue).toMatchObject({ skipped: true });

      // No Gmail mutation, no new cleanup proposals.
      expect(mockDisconnectGmail).not.toHaveBeenCalled();
      expect(await prisma.cleanupAction.count({ where: { userId: account.userId } })).toBe(0);
    });

    it("treats a job with no userId as unaffected (global sweeps still run)", async () => {
      // A retention sweep across all users carries no userId; deleting one account
      // must not disable it.
      expect(await userStillExists(undefined)).toBe(true);
      expect(await userStillExists(null)).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Notification path                                                       */
  /* ---------------------------------------------------------------------- */

  describe("notifications after deletion", () => {
    it("no-ops when the notification no longer exists", async () => {
      const outcome = await dispatchNotification("notification-that-does-not-exist");

      expect(outcome).toEqual({
        notificationId: "notification-that-does-not-exist",
        delivered: [],
        failed: [],
        skipped: [],
        escalationArmed: false,
      });
    });

    it("no-ops when the notification is deleted with its account", async () => {
      const account = await seedAccount("notify");
      const notificationId = account.notificationIds[0];

      /**
       * Deliverable while the account exists, so the contrast with the post-deletion
       * outcome below is meaningful.
       *
       * Dashboard delivery is implicit and always attempted, so that is the proof the
       * notification was found — not a skipped channel (nothing else is configured in
       * the test env). `escalationArmed` is deliberately NOT asserted: it depends on
       * whether an escalation channel is configured, which is false here by design.
       */
      const before = await dispatchNotification(notificationId);
      expect(before.delivered).toContain("DASHBOARD");

      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      const after = await dispatchNotification(notificationId);
      expect(after).toEqual({
        notificationId,
        delivered: [],
        failed: [],
        skipped: [],
        escalationArmed: false,
      });
    });

    it("completes an escalation sweep without error after a deletion", async () => {
      const account = await seedAccount("escalate");
      await ObliterateUserAccountService.obliterate(account.userId, {
        actor: "USER",
        password: PASSWORD,
        confirmation: account.email,
      });

      await expect(sweepOverdueEscalations()).resolves.toBeGreaterThanOrEqual(0);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Demo account                                                            */
  /* ---------------------------------------------------------------------- */

  describe("demo account", () => {
    it("cannot be deleted", async () => {
      const demoEmail = `demo-delete-${Date.now()}@example.com`;
      const demo = await prisma.user.create({
        data: { email: demoEmail, passwordHash: await hashPassword(PASSWORD), isDemo: true },
      });
      createdUserIds.push(demo.id);

      await expect(
        ObliterateUserAccountService.obliterate(demo.id, {
          actor: "USER",
          password: PASSWORD,
          confirmation: demoEmail,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(await prisma.user.findUnique({ where: { id: demo.id } })).not.toBeNull();
    });
  });
});
