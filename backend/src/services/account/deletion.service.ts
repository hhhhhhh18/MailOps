import type { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { hashToken, verifyPassword } from "../../utils/crypto";
import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  describeError,
} from "../../utils/errors";
import { redactSecrets } from "../../utils/redact";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import { disconnectGmailAccount } from "../gmail/oauth.service";
import { revokeAllSessions } from "../auth/auth.service";
import { purgeUserExternalData } from "../../queues";

/**
 * Account deletion / complete data erasure.
 *
 * Architecture (deliberately this order — each step depends on the previous one):
 *
 *   1. REVOKE EXTERNAL GRANTS   — while the encrypted tokens still exist
 *   2. WRITE DE-IDENTIFIED RECEIPT — before the row it describes is gone
 *   3. DELETE THE USER ROW      — one statement; PostgreSQL FK cascades do the rest
 *   4. PURGE REDIS / BULLMQ     — everything that lives outside PostgreSQL
 *
 * Why the order is not negotiable:
 *
 *  - **Revocation must come first.** The refresh token lives in `GmailAccount`, which
 *    the cascade destroys. Delete first and the Google grant stays live in the user's
 *    account with nothing left to revoke it with.
 *  - **The receipt must be written before the delete.** It is the only row that
 *    survives; `AuditLog` is cascaded away with the user, so it cannot serve as the
 *    proof of erasure.
 *  - **Google availability must never gate erasure.** A failed revocation is recorded
 *    and reported, but it does not stop the deletion. A user's right to erase their
 *    MailOps account does not depend on a third party being reachable.
 *
 * The bulk erasure is intentionally left to the database. Enumerating 16 models by
 * hand means the 17th user-owned model added later leaks data *silently*; with the
 * FK cascade the same mistake fails *loudly* (FK violation). See the schema's
 * `onDelete` clauses and tests/unit/schema-deletion-coverage.test.ts.
 */

/** HMAC-SHA256 fingerprint. Deterministic and recomputable, but not reversible. */
function fingerprint(value: string): string {
  return hashToken(value);
}

/** Failure notes must never carry a token, even accidentally, and stay short. */
function sanitizeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).replace(/\s+/g, " ").slice(0, 200);
}

/** -------------------------------------------------------------------------- */
/** Manual revocation guidance                                                   */
/** -------------------------------------------------------------------------- */

export interface RevocationGuidance {
  id: string;
  label: string;
  /** True when MailOps revokes it automatically as part of the deletion. */
  automatic: boolean;
  detail: string;
}

/**
 * What MailOps can and cannot revoke.
 *
 * Only Gmail has a programmatic revocation API wired up (Google's token revocation
 * endpoint). Everything else is a credential we hold a copy of — deleting our copy
 * does not kill the credential in the provider's system. Saying so plainly is the
 * honest position; implying otherwise would be a lie the user only discovers later.
 */
export const MANUAL_REVOCATION_GUIDANCE: RevocationGuidance[] = [
  {
    id: "gmail",
    label: "Gmail / Google",
    automatic: true,
    detail:
      "MailOps revokes its Google OAuth grant for every connected account and deletes the stored tokens. Your Gmail mailbox itself is never modified or deleted by MailOps.",
  },
  {
    id: "slack",
    label: "Slack",
    automatic: false,
    detail:
      "MailOps deletes the webhook URL it stored. The incoming webhook itself lives in your Slack workspace and must be removed by a workspace admin.",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    automatic: false,
    detail:
      "MailOps deletes the stored Cloud API credentials and the recipient number. Revoking the Meta credential itself must be done in Meta Business Manager.",
  },
  {
    id: "voice",
    label: "Voice (Twilio)",
    automatic: false,
    detail:
      "MailOps deletes the stored Twilio credentials. Those credentials belong to your own Twilio account and remain under your control.",
  },
  {
    id: "email",
    label: "Email channel",
    automatic: false,
    detail: "MailOps deletes the stored SMTP credentials and any configured recipients.",
  },
  {
    id: "ai",
    label: "AI provider",
    automatic: false,
    detail:
      "MailOps deletes the stored provider API key. The key itself stays valid until you rotate or revoke it with the provider.",
  },
  {
    id: "delivered",
    label: "Already delivered messages",
    automatic: false,
    detail:
      "Messages MailOps has already sent to Slack, WhatsApp, email or voice cannot be recalled or removed from the receiving system.",
  },
];

/** Stated once, in one place, so no surface can imply mailbox deletion. */
export const MAILBOX_NOTICE =
  "MailOps stores its own copy of email metadata and (optionally) bodies. Deleting your account erases that copy. It does not delete messages from your Gmail mailbox.";

/** -------------------------------------------------------------------------- */
/** Counting                                                                     */
/** -------------------------------------------------------------------------- */

/**
 * Prisma model name → the key used in `countsByModel`.
 *
 * This table is the deletion architecture's explicit statement of what a user owns.
 * It is not documentation: `countOne` below switches over it exhaustively, so a
 * model added here without a counter is a TypeScript error, and
 * `tests/unit/schema-deletion-coverage.test.ts` reads the Prisma DMMF and fails if
 * the real schema grows a `userId` that is missing from this table.
 *
 * `NotificationAttempt` is the model that matters most here: it has no `userId` of
 * its own and is reachable only through `Notification`, so it is exactly the row a
 * hand-written inventory forgets — and leaving it behind would mean erasure that
 * silently was not complete.
 */
export const USER_OWNED_MODEL_KEYS = {
  User: "user",
  UserSettings: "userSettings",
  GmailAccount: "gmailAccounts",
  Email: "emails",
  EmailAnalysis: "emailAnalyses",
  Application: "applications",
  ApplicationEvent: "applicationEvents",
  Notification: "notifications",
  NotificationAttempt: "notificationAttempts",
  Integration: "integrations",
  CleanupAction: "cleanupActions",
  ScanJob: "scanJobs",
  AuditLog: "auditLogs",
  RefreshToken: "refreshTokens",
  PasswordResetToken: "passwordResetTokens",
  EmailVerificationToken: "emailVerificationTokens",
} as const;

export type UserOwnedModel = keyof typeof USER_OWNED_MODEL_KEYS;

/** Exhaustive per-model counter. The `never` check makes a missing case a build error. */
function countOne(model: UserOwnedModel, userId: string): Promise<number> {
  switch (model) {
    case "User":
      return prisma.user.count({ where: { id: userId } });
    case "UserSettings":
      return prisma.userSettings.count({ where: { userId } });
    case "GmailAccount":
      return prisma.gmailAccount.count({ where: { userId } });
    case "Email":
      return prisma.email.count({ where: { userId } });
    case "EmailAnalysis":
      return prisma.emailAnalysis.count({ where: { userId } });
    case "Application":
      return prisma.application.count({ where: { userId } });
    case "ApplicationEvent":
      return prisma.applicationEvent.count({ where: { userId } });
    case "Notification":
      return prisma.notification.count({ where: { userId } });
    case "NotificationAttempt":
      // Reached through its parent — the whole reason this table is explicit.
      return prisma.notificationAttempt.count({ where: { notification: { userId } } });
    case "Integration":
      return prisma.integration.count({ where: { userId } });
    case "CleanupAction":
      return prisma.cleanupAction.count({ where: { userId } });
    case "ScanJob":
      return prisma.scanJob.count({ where: { userId } });
    case "AuditLog":
      return prisma.auditLog.count({ where: { userId } });
    case "RefreshToken":
      return prisma.refreshToken.count({ where: { userId } });
    case "PasswordResetToken":
      return prisma.passwordResetToken.count({ where: { userId } });
    case "EmailVerificationToken":
      return prisma.emailVerificationToken.count({ where: { userId } });
    default: {
      const exhaustive: never = model;
      throw new Error(`Unhandled user-owned model: ${String(exhaustive)}`);
    }
  }
}

/**
 * Row counts for every user-owned model.
 *
 * Derived from `USER_OWNED_MODEL_KEYS` so the two cannot drift apart.
 */
export async function countUserOwnedRows(userId: string): Promise<Record<string, number>> {
  const entries = await Promise.all(
    (Object.keys(USER_OWNED_MODEL_KEYS) as UserOwnedModel[]).map(async (model) => {
      const key = USER_OWNED_MODEL_KEYS[model];
      return [key, await countOne(model, userId)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export interface AccountDeletionPreview {
  counts: Record<string, number>;
  totalRows: number;
  gmailAccounts: Array<{ id: string; emailAddress: string; status: string }>;
  revocation: RevocationGuidance[];
  mailbox: string;
}

/**
 * What deleting this account would remove, plus what MailOps cannot reach.
 *
 * Backs the privacy endpoint so the destructive action is preceded by an inventory
 * rather than a vague warning. Carries counts only — never contents.
 */
export async function previewAccountDeletion(userId: string): Promise<AccountDeletionPreview> {
  const [counts, accounts] = await Promise.all([
    countUserOwnedRows(userId),
    prisma.gmailAccount.findMany({
      where: { userId },
      select: { id: true, emailAddress: true, status: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const totalRows = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return {
    counts,
    totalRows,
    gmailAccounts: accounts,
    revocation: MANUAL_REVOCATION_GUIDANCE,
    mailbox: MAILBOX_NOTICE,
  };
}

/** -------------------------------------------------------------------------- */
/** Obliteration                                                                 */
/** -------------------------------------------------------------------------- */

export interface ObliterateOptions {
  actor?: "USER" | "ADMIN";
  /** Current account password. Required: a live session is not proof of intent. */
  password: string;
  /** Must equal the authenticated account's email address. */
  confirmation: string;
  ip?: string | null;
}

export interface ObliterationResult {
  deleted: true;
  receiptId: string;
  countsByModel: Record<string, number>;
  totalRowsDeleted: number;
  sessionsRevoked: number;
  gmail: {
    accounts: number;
    revoked: number;
    failures: string[];
    /** True when nothing failed to revoke (including "there was nothing to revoke"). */
    fullyRevoked: boolean;
  };
  externalPurge: {
    queuesRemoved: number;
    queuesRemovedByQueue: Record<string, number>;
    redisKeysRemoved: number;
    failures: string[];
  };
  revocation: RevocationGuidance[];
  mailbox: string;
}

async function reject(
  userId: string,
  reason: "PASSWORD_MISMATCH" | "CONFIRMATION_MISMATCH" | "DEMO_ACCOUNT",
  ip: string | null | undefined,
): Promise<void> {
  // The account still exists at this point, so a normal audit row is valid — and a
  // rejected attempt to destroy an account is security-relevant.
  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.accountDeletionRejected,
    entityType: "User",
    entityId: userId,
    summary:
      reason === "DEMO_ACCOUNT"
        ? "Account deletion rejected: demo account is read-only"
        : reason === "PASSWORD_MISMATCH"
          ? "Account deletion rejected: password confirmation failed"
          : "Account deletion rejected: email confirmation did not match",
    // Reason code only. Never the password, the typed phrase, or any token.
    metadata: { reason },
    ip: ip ?? null,
  });
}

/**
 * Erase a MailOps account completely, and record that it happened.
 *
 * @param userId Taken from the authenticated session (`currentUserId`), never from
 *   the request body — there is no way to aim this at another account.
 */
async function obliterate(userId: string, options: ObliterateOptions): Promise<ObliterationResult> {
  const actor = options.actor ?? "USER";
  const requestedAt = new Date();

  /* ------------------------------------------------------------------------ */
  /* PHASE 0 — PRE-FLIGHT                                                     */
  /* ------------------------------------------------------------------------ */

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthenticatedError("Your account is no longer available.");

  if (user.isDemo) {
    await reject(userId, "DEMO_ACCOUNT", options.ip);
    throw new ForbiddenError(
      "The demo account is read-only. Create your own account to manage deletion.",
    );
  }

  const passwordOk = await verifyPassword(options.password, user.passwordHash);
  if (!passwordOk) {
    await reject(userId, "PASSWORD_MISMATCH", options.ip);
    throw new ForbiddenError("That password is not correct. Your account was not deleted.");
  }

  // Emails are stored lower-cased (auth.service normalises on write), so compare the
  // same way — the user should not have to match capitalisation exactly.
  const expected = user.email.trim().toLowerCase();
  if (!options.confirmation.trim() || options.confirmation.trim().toLowerCase() !== expected) {
    await reject(userId, "CONFIRMATION_MISMATCH", options.ip);
    throw new ValidationError(
      "Type your account email address exactly to confirm deletion.",
    );
  }

  const counts = await countUserOwnedRows(userId);

  /* ------------------------------------------------------------------------ */
  /* PHASE 1 — REVOKE EXTERNAL GRANTS (before any row is deleted)             */
  /* ------------------------------------------------------------------------ */

  const gmailAccounts = await prisma.gmailAccount.findMany({
    where: { userId },
    select: { id: true },
  });

  const revokeFailures: string[] = [];
  let revoked = 0;

  for (const account of gmailAccounts) {
    try {
      // Reuses the established disconnect path, whose contract is already
      // "revocation failure is logged and non-fatal".
      const result = await disconnectGmailAccount(user as User, account.id);
      if (result.revoked) revoked += 1;
      else revokeFailures.push(`google-grant(${account.id}): not revoked`);
    } catch (error) {
      revokeFailures.push(`google-grant(${account.id}): ${sanitizeFailure(error)}`);
    }
  }

  const fullyRevoked = revokeFailures.length === 0;

  // Revoke sessions while the rows still exist: it makes the count meaningful, and
  // it means the sessions are killed even if the delete below somehow fails.
  const sessionsRevoked = await revokeAllSessions(userId);

  /* ------------------------------------------------------------------------ */
  /* PHASE 2 — RECEIPT, THEN ERASURE                                          */
  /* ------------------------------------------------------------------------ */

  const receipt = await prisma.accountDeletionRecord.create({
    data: {
      deletedUserIdHash: fingerprint(userId),
      requestedAt,
      initiator: actor,
      countsByModel: counts,
      gmailGrantRevoked: fullyRevoked,
      revokeFailures: revokeFailures.length ? revokeFailures : undefined,
      requestedByIpHash: options.ip ? fingerprint(options.ip) : null,
    },
  });

  /**
   * Written before the delete so it survives if the delete throws — an attempted
   * erasure that failed is worth keeping. On success it is cascaded away with the
   * rest of the audit trail, which is the intended outcome (see the audit-retention
   * decision in the P0-1 audit): the durable record is the receipt, not this row.
   */
  await recordAudit({
    userId,
    actor: actor === "ADMIN" ? "SYSTEM" : "USER",
    action: AUDIT_ACTIONS.accountDeleted,
    entityType: "User",
    entityId: userId,
    summary: "Account deleted and all stored data erased",
    metadata: {
      receiptId: receipt.id,
      initiator: actor,
      totalRows: Object.values(counts).reduce((sum, value) => sum + value, 0),
      gmailRevoked: fullyRevoked,
      sessionsRevoked,
    },
    ip: options.ip ?? null,
  });

  /**
   * The erasure itself: one statement, one implicit transaction.
   *
   * Not an interactive transaction — a large account cascading 16 tables can exceed
   * Prisma's 5s interactive default and would leave a half-deleted user. As a single
   * statement it either removes the user or does not.
   *
   * Not enumerated per model — see the header comment.
   */
  await prisma.user.delete({ where: { id: userId } });

  /**
   * Confirm completion. Best-effort on purpose: this must never be able to roll back
   * the erasure, so it is not in the same transaction as the delete. A receipt left
   * with `completedAt: null` means "requested, not confirmed" — the truth.
   */
  await prisma.accountDeletionRecord
    .update({ where: { id: receipt.id }, data: { completedAt: new Date() } })
    .catch((error) => {
      logger.error(
        { receiptId: receipt.id, err: sanitizeFailure(error) },
        "account deletion completed but the receipt could not be marked complete",
      );
    });

  /* ------------------------------------------------------------------------ */
  /* PHASE 3 — PURGE REDIS / BULLMQ                                           */
  /* ------------------------------------------------------------------------ */

  const external = await purgeUserExternalData(userId);

  /**
   * Operator-visible record of the erasure. No AuditLog row survives this by design
   * (it is cascaded away), so the durable proof is the receipt and the observable
   * trail is the structured log. Deliberately carries no user id, no email and no
   * request IP — only the receipt id, which is already non-identifying.
   */
  logger.info(
    {
      action: AUDIT_ACTIONS.accountDeleted,
      receiptId: receipt.id,
      totalRows: Object.values(counts).reduce((sum, value) => sum + value, 0),
      gmailRevoked: fullyRevoked,
      queuesRemoved: external.queues.totalRemoved,
      redisKeysRemoved: external.redisKeys.removedKeys,
      externalFailures: external.failures.length,
    },
    "account erased",
  );

  return {
    deleted: true,
    receiptId: receipt.id,
    countsByModel: counts,
    totalRowsDeleted: Object.values(counts).reduce((sum, value) => sum + value, 0),
    sessionsRevoked,
    gmail: {
      accounts: gmailAccounts.length,
      revoked,
      failures: revokeFailures,
      fullyRevoked,
    },
    externalPurge: {
      queuesRemoved: external.queues.totalRemoved,
      queuesRemovedByQueue: external.queues.removedByQueue,
      redisKeysRemoved: external.redisKeys.removedKeys,
      failures: external.failures,
    },
    revocation: MANUAL_REVOCATION_GUIDANCE,
    mailbox: MAILBOX_NOTICE,
  };
}

/**
 * Public entry point, named for the operation rather than the implementation.
 *
 * `obliterate` is the destructive path; `preview` is its read-only counterpart and
 * is what the privacy endpoint renders.
 */
export const ObliterateUserAccountService = {
  obliterate,
  preview: previewAccountDeletion,
  counts: countUserOwnedRows,
};
