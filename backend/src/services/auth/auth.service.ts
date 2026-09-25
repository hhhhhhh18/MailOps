import jwt, { type SignOptions } from "jsonwebtoken";
import type { User, UserSettings } from "@prisma/client";
import { env, isProduction } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { hashPassword, hashToken, randomToken, verifyPassword } from "../../utils/crypto";
import { AppError, ERROR_CODES, UnauthenticatedError, ValidationError, describeError } from "../../utils/errors";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import { sendTransactionalEmail } from "../notifications/channels/email.channel";

/**
 * Authentication.
 *
 * - Passwords are hashed with bcrypt (cost 12; 4 under test).
 * - The access token is a short-lived JWT delivered in an httpOnly, SameSite=Lax
 *   cookie so it is not readable by JavaScript.
 * - Refresh tokens are random 48-byte values stored only as HMAC-SHA256 hashes,
 *   rotated on every use, so a database leak cannot be replayed.
 * - Nothing here logs credentials or tokens.
 */

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
  isDemo: boolean;
  /** Derived from `emailVerifiedAt`. Unverified users may still sign in (policy). */
  emailVerified: boolean;
  emailVerifiedAt: string | null;
}

export interface AuthResult {
  user: AuthenticatedUser;
  tokens: IssuedTokens;
}

export const DEFAULT_PASSWORD_MIN_LENGTH = 10;

/**
 * The single password policy, shared by register, change and reset.
 *
 * One implementation on purpose: a weaker check on the reset path would silently
 * become the cheapest way into an account.
 */
export function assertPasswordPolicy(password: string): void {
  if (password.length < DEFAULT_PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`Password must be at least ${DEFAULT_PASSWORD_MIN_LENGTH} characters long`);
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new ValidationError("Password must contain at least one letter and one number");
  }
}

export async function registerUser(
  input: {
    email: string;
    password: string;
    name?: string | null;
    timezone?: string;
  },
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("Enter a valid email address");
  }
  assertPasswordPolicy(input.password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Do not disclose whether the account exists beyond the necessary signal.
    throw new AppError("An account with this email already exists. Try signing in instead.", {
      statusCode: 409,
      code: ERROR_CODES.CONFLICT,
    });
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name?.trim() || null,
      passwordHash,
      timezone: input.timezone ?? "UTC",
      settings: { create: {} },
      integrations: {
        create: [
          { kind: "SLACK", status: "DISCONNECTED" },
          { kind: "WHATSAPP", status: "DISCONNECTED" },
          { kind: "VOICE", status: "DISCONNECTED" },
          { kind: "EMAIL", status: "DISCONNECTED" },
          { kind: "AI", status: "CONNECTED", displayName: env.AI_PROVIDER },
        ],
      },
    },
  });

  await recordAudit({
    userId: user.id,
    actor: "USER",
    action: AUDIT_ACTIONS.userRegistered,
    entityType: "User",
    entityId: user.id,
    summary: "Account created",
  });

  /**
   * Verification email, best effort.
   *
   * The account is unusable-by-nobody until this succeeds, but registration must not
   * fail because mail is down: the user can sign in and resend. The delivery
   * outcome is recorded in the audit log by issueEmailVerification.
   */
  await issueEmailVerification(user, context);

  const tokens = await issueTokens(user, {});
  return { user: toAuthenticatedUser(user), tokens };
}

export async function loginUser(
  input: { email: string; password: string },
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  // Compare against a dummy hash when the user is missing so response timing does
  // not reveal account existence.
  const valid = user
    ? await verifyPassword(input.password, user.passwordHash)
    : await verifyPassword(input.password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin");

  if (!user || !valid) {
    logger.warn({ email: email.replace(/(.{2}).*(@.*)/, "$1***$2") }, "failed login attempt");
    throw new UnauthenticatedError("Incorrect email or password");
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  await recordAudit({
    userId: user.id,
    actor: "USER",
    action: AUDIT_ACTIONS.userLogin,
    entityType: "User",
    entityId: user.id,
    summary: "Signed in",
    ip: context.ip,
    userAgent: context.userAgent,
  });

  const tokens = await issueTokens(user, context);
  return { user: toAuthenticatedUser(user), tokens };
}

export async function issueTokens(
  user: Pick<User, "id" | "email">,
  context: { ip?: string | null; userAgent?: string | null },
): Promise<IssuedTokens> {
  const accessTokenExpiresAt = new Date(Date.now() + env.JWT_ACCESS_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);

  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, typ: "access" },
    env.JWT_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL_SECONDS } as SignOptions,
  );

  const refreshToken = randomToken(48);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshTokenExpiresAt,
      ip: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
    },
  });

  return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt };
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  typ: string;
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AccessTokenClaims;
    if (decoded.typ !== "access") throw new Error("wrong token type");
    return decoded;
  } catch {
    throw new UnauthenticatedError("Your session has expired. Please sign in again.");
  }
}

/** Rotating refresh: the presented token is revoked and a new pair is issued. */
export async function refreshSession(
  refreshToken: string,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<AuthResult> {
  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });

  if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
    if (stored && !stored.revokedAt && stored.expiresAt.getTime() < Date.now()) {
      await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    }
    throw new UnauthenticatedError("Your session has expired. Please sign in again.");
  }

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

  const tokens = await issueTokens(stored.user, context);
  return { user: toAuthenticatedUser(stored.user), tokens };
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await prisma.refreshToken
    .updateMany({ where: { tokenHash: hashToken(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function getUserById(userId: string): Promise<(User & { settings: UserSettings | null }) | null> {
  return prisma.user.findUnique({ where: { id: userId }, include: { settings: true } });
}

export function toAuthenticatedUser(
  user: Pick<User, "id" | "email" | "name" | "timezone" | "isDemo" | "emailVerifiedAt">,
): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    isDemo: user.isDemo,
    emailVerified: user.emailVerifiedAt !== null,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
  };
}

/**
 * ---------------------------------------------------------------------------
 * Password lifecycle
 * ---------------------------------------------------------------------------
 *
 * Reset tokens are 48 random bytes (384 bits) stored only as HMAC-SHA256 hashes,
 * single-use via `usedAt`, and short-lived via PASSWORD_RESET_TTL_MINUTES. The raw
 * value exists only inside the email. Every reset failure returns one identical
 * error so the endpoint cannot be used to probe tokens or accounts.
 *
 * Changing or resetting a password revokes refresh tokens. The current session is
 * preserved only for an authenticated change, because the user is demonstrably
 * signed in on that device.
 */

export interface PasswordChangeResult {
  revokedSessions: number;
}

/** The single response for every forgot-password outcome (enumeration guard). */
export const GENERIC_RESET_REQUEST_MESSAGE =
  "If an account exists for this email, a password reset link has been sent.";

/** One error for unknown, used and expired tokens alike. */
export const INVALID_RESET_TOKEN_MESSAGE = "This password reset link is invalid or has expired";

/**
 * Security notification sent after a successful password change.
 *
 * Best effort by design: the caller has already changed the password and revoked
 * the other sessions, so a mail outage must not turn a completed change into an
 * error. Failures are reported to the caller (and recorded on the audit entry)
 * rather than thrown.
 *
 * The body carries no password, hash, token or session material — only the fact
 * that the change happened and what to do if it was not the user.
 */
async function sendPasswordChangedEmail(
  user: Pick<User, "email">,
  context: { ip?: string | null },
): Promise<{ sent: boolean; provider: string | null; reason: string | null }> {
  const when = new Date().toUTCString();
  const where = context.ip ? ` from IP address ${context.ip}` : "";

  try {
    const delivery = await sendTransactionalEmail({
      to: user.email,
      subject: "Your MailOps password was changed",
      kind: "password-changed",
      text: [
        `The password for your MailOps account was changed at ${when}${where}.`,
        "",
        "If you made this change, no action is needed. Your other signed-in devices have been signed out.",
        "",
        "If you did NOT change your password, someone else may have access to your account:",
        '1. Choose "Forgot password?" on the sign-in page and set a new password.',
        "2. Review your connected Gmail account and notification settings.",
        "",
        "MailOps will never ask you for your password by email.",
      ].join("\n"),
      html: [
        `<p>The password for your MailOps account was changed at ${when}${where}.</p>`,
        "<p>If you made this change, no action is needed. Your other signed-in devices have been signed out.</p>",
        "<p><strong>If you did NOT change your password</strong>, someone else may have access to your account:</p>",
        '<ol><li>Choose "Forgot password?" on the sign-in page and set a new password.</li>',
        "<li>Review your connected Gmail account and notification settings.</li></ol>",
        "<p>MailOps will never ask you for your password by email.</p>",
      ].join(""),
    });

    return {
      sent: delivery.ok,
      provider: delivery.provider,
      reason: delivery.ok ? null : (delivery.error ?? "not delivered"),
    };
  } catch (error) {
    // The provider contract returns failures rather than throwing; this guards
    // against a future provider that does not.
    logger.warn({ kind: "password-changed" }, "password change security email threw");
    return { sent: false, provider: null, reason: describeError(error).message };
  }
}

export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string; keepRefreshToken?: string | null },
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<PasswordChangeResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new UnauthenticatedError("Your session has expired. Please sign in again.");
  }
  if (!user.passwordHash) {
    throw new ValidationError("This account has no password set, so it cannot be changed here.");
  }

  const currentValid = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!currentValid) {
    // A 400, deliberately not a 401: the client reacts to 401 by attempting a
    // token refresh, which would mask the real problem behind a redirect.
    throw new ValidationError("Your current password is incorrect");
  }

  assertPasswordPolicy(input.newPassword);

  if (await verifyPassword(input.newPassword, user.passwordHash)) {
    throw new ValidationError("Your new password must be different from your current password");
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Revoke every other session; keep the one making this request so the user is
  // not signed out of the device they are already using.
  const keepHash = input.keepRefreshToken ? hashToken(input.keepRefreshToken) : null;
  const revoked = await prisma.refreshToken.updateMany({
    where: {
      userId: user.id,
      revokedAt: null,
      ...(keepHash ? { tokenHash: { not: keepHash } } : {}),
    },
    data: { revokedAt: new Date() },
  });

  /**
   * Only reached once the password and the session set have actually changed.
   * Every rejection above (wrong current password, policy failure, reuse) returns
   * before this point, so no security email is sent for a change that did not
   * happen, and a database failure prevents it too.
   */
  const securityEmail = await sendPasswordChangedEmail(user, context);

  await recordAudit({
    userId: user.id,
    actor: "USER",
    action: AUDIT_ACTIONS.passwordChanged,
    entityType: "User",
    entityId: user.id,
    summary: "Password changed",
    metadata: {
      revokedSessions: revoked.count,
      keptCurrentSession: Boolean(keepHash),
      // Delivery outcome recorded via the existing audit mechanism: the change
      // stands even when the notification could not be delivered.
      securityEmail: {
        attempted: true,
        sent: securityEmail.sent,
        provider: securityEmail.provider,
        reason: securityEmail.reason,
      },
    },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return { revokedSessions: revoked.count };
}

export interface ResetRequestResult {
  message: string;
  /** Internal only — never surfaced to the caller. */
  delivered: boolean;
  emailSentTo: string | null;
}

export async function requestPasswordReset(input: {
  email: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ResetRequestResult> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  /**
   * Unknown address, and the shared demo account, both return the generic message
   * and perform no work. The demo account is intentionally excluded: it is a
   * read-only shared login, so issuing resettable credentials for it would let one
   * visitor lock everyone else out of the demo.
   */
  if (!user || user.isDemo) {
    return { message: GENERIC_RESET_REQUEST_MESSAGE, delivered: false, emailSentTo: null };
  }

  // At most one live reset link per account: retire anything outstanding first.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = randomToken(48);
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt,
      requestedByIp: input.ip ?? null,
    },
  });

  const resetUrl = `${env.WEB_BASE_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const minutes = env.PASSWORD_RESET_TTL_MINUTES;

  /**
   * Only the URL is sent — never the user's email content, and never the token in
   * isolation. The transport decides what may be logged (see email.channel.ts).
   */
  const delivery = await sendTransactionalEmail({
    to: user.email,
    subject: "Reset your MailOps password",
    kind: "password-reset",
    text: [
      "Someone asked to reset the password for this MailOps account.",
      "",
      `Open this link to choose a new password: ${resetUrl}`,
      "",
      `The link expires in ${minutes} minutes and can be used once.`,
      "If you did not request this, you can ignore this email — your password will not change.",
    ].join("\n"),
    html: [
      "<p>Someone asked to reset the password for this MailOps account.</p>",
      `<p><a href="${resetUrl}">Choose a new password</a></p>`,
      `<p>The link expires in ${minutes} minutes and can be used once.</p>`,
      "<p>If you did not request this, you can ignore this email — your password will not change.</p>",
    ].join(""),
  });

  await recordAudit({
    userId: user.id,
    actor: "SYSTEM",
    action: AUDIT_ACTIONS.passwordResetRequested,
    entityType: "User",
    entityId: user.id,
    // No token, no hash, no URL — only the fact that a link was issued.
    summary: "Password reset link issued",
    metadata: { delivered: delivery.ok, provider: delivery.provider, expiresInMinutes: minutes },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { message: GENERIC_RESET_REQUEST_MESSAGE, delivered: delivery.ok, emailSentTo: user.email };
}

export async function resetPassword(input: {
  token: string;
  newPassword: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<PasswordChangeResult> {
  const token = input.token.trim();
  const invalid = () => new ValidationError(INVALID_RESET_TOKEN_MESSAGE);

  if (!token) throw invalid();

  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    if (record) {
      // Attributable failure (used or expired) — worth an audit trail. An unknown
      // token is logged without any value so the log cannot be replayed.
      await recordAudit({
        userId: record.userId,
        actor: "SYSTEM",
        action: AUDIT_ACTIONS.passwordResetRejected,
        entityType: "PasswordResetToken",
        entityId: record.id,
        summary: record.usedAt ? "Reset token already used" : "Reset token expired",
        ip: input.ip,
        userAgent: input.userAgent,
      });
    } else {
      logger.warn({ ip: input.ip ?? null }, "password reset attempted with an unknown token");
    }
    throw invalid();
  }

  assertPasswordPolicy(input.newPassword);
  const passwordHash = await hashPassword(input.newPassword);

  /**
   * Consume the token, rotate the credential and revoke every session in one
   * transaction: a partially applied reset would either leave the old password
   * valid or leave sessions alive against a password that no longer exists.
   */
  const [, , revoked] = await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await recordAudit({
    userId: record.userId,
    actor: "USER",
    action: AUDIT_ACTIONS.passwordResetCompleted,
    entityType: "User",
    entityId: record.userId,
    summary: "Password reset with a one-time link",
    metadata: { revokedSessions: revoked.count },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { revokedSessions: revoked.count };
}

/**
 * ---------------------------------------------------------------------------
 * Email verification
 * ---------------------------------------------------------------------------
 *
 * Same token discipline as password reset: 48 random bytes, stored only as an
 * HMAC-SHA256 hash, single-use via `usedAt`, expiring. At most one live link per
 * account, because a new request retires the previous one.
 *
 * Policy: an unverified address does NOT block sign-in. Verification gates
 * nothing yet — it establishes that the user controls the address (needed for
 * account recovery and for any future outbound mail), and the UI surfaces the
 * state until it is resolved.
 */

export type EmailVerificationStatus = "VERIFIED" | "ALREADY_VERIFIED" | "EXPIRED" | "INVALID";

export interface VerificationDelivery {
  sent: boolean;
  provider: string | null;
  reason: string | null;
}

/** One response for every resend outcome, so the endpoint reveals nothing extra. */
export const GENERIC_VERIFICATION_MESSAGE =
  "If this account still needs verification, a new verification email has been sent.";

async function deliverVerificationEmail(
  to: string,
  verifyUrl: string,
  expiresAt: Date,
): Promise<VerificationDelivery> {
  const hours = Math.max(1, Math.round(env.EMAIL_VERIFICATION_TTL_MINUTES / 60));
  const expires = expiresAt.toUTCString();

  try {
    const delivery = await sendTransactionalEmail({
      to,
      subject: "Verify your MailOps email address",
      kind: "email-verification",
      text: [
        "Welcome to MailOps — the agent that turns your recruitment inbox into an organised application timeline.",
        "",
        "Confirm this email address to finish setting up your account:",
        verifyUrl,
        "",
        `This link expires on ${expires} (about ${hours} hours) and can be used once.`,
        "If you did not create a MailOps account, you can ignore this email.",
      ].join("\n"),
      html: [
        "<p>Welcome to <strong>MailOps</strong> — the agent that turns your recruitment inbox into an organised application timeline.</p>",
        "<p>Confirm this email address to finish setting up your account:</p>",
        `<p><a href="${verifyUrl}">Verify my email address</a></p>`,
        `<p>This link expires on ${expires} (about ${hours} hours) and can be used once.</p>`,
        "<p>If you did not create a MailOps account, you can ignore this email.</p>",
      ].join(""),
    });

    return {
      sent: delivery.ok,
      provider: delivery.provider,
      reason: delivery.ok ? null : (delivery.error ?? "not delivered"),
    };
  } catch (error) {
    logger.warn({ kind: "email-verification" }, "verification email threw");
    return { sent: false, provider: null, reason: describeError(error).message };
  }
}

/**
 * Issues a fresh verification link, retiring any outstanding one.
 *
 * Never returns or records the raw token: it exists only in the email body.
 */
async function issueEmailVerification(
  user: Pick<User, "id" | "email">,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<VerificationDelivery> {
  await prisma.emailVerificationToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = randomToken(48);
  const expiresAt = new Date(Date.now() + env.EMAIL_VERIFICATION_TTL_MINUTES * 60_000);

  await prisma.emailVerificationToken.create({
    data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt },
  });

  const verifyUrl = `${env.WEB_BASE_URL.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const outcome = await deliverVerificationEmail(user.email, verifyUrl, expiresAt);

  await recordAudit({
    userId: user.id,
    actor: "SYSTEM",
    action: AUDIT_ACTIONS.emailVerificationRequested,
    entityType: "User",
    entityId: user.id,
    // No token, no hash, no URL — only the fact that a link was issued.
    summary: "Email verification link issued",
    metadata: {
      delivered: outcome.sent,
      provider: outcome.provider,
      reason: outcome.reason,
      expiresInMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
    },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return outcome;
}

export async function verifyEmail(input: {
  token: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ status: EmailVerificationStatus }> {
  const token = input.token.trim();
  if (!token) return { status: "INVALID" };

  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, emailVerifiedAt: true } } },
  });

  if (!record) {
    // Unknown token: nothing to attribute, and the token must never be logged.
    logger.warn({ ip: input.ip ?? null }, "email verification attempted with an unknown token");
    return { status: "INVALID" };
  }

  /**
   * Already used.
   *
   * If the account is verified, this is almost always the same user opening the
   * link twice (or a mail client prefetching it), so report success rather than an
   * error — the outcome the user wanted is true. If the account is *not* verified,
   * the record and the user disagree, which should not silently verify anyone.
   */
  if (record.usedAt) {
    return { status: record.user.emailVerifiedAt ? "ALREADY_VERIFIED" : "INVALID" };
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    await recordAudit({
      userId: record.userId,
      actor: "SYSTEM",
      action: AUDIT_ACTIONS.emailVerificationRejected,
      entityType: "EmailVerificationToken",
      entityId: record.id,
      summary: "Verification link expired",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return { status: "EXPIRED" };
  }

  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    // Preserve the first verification time if it is somehow already set.
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: record.user.emailVerifiedAt ?? new Date() },
    }),
  ]);

  await recordAudit({
    userId: record.userId,
    actor: "USER",
    action: AUDIT_ACTIONS.emailVerificationCompleted,
    entityType: "User",
    entityId: record.userId,
    summary: "Email address verified",
    metadata: { previouslyVerified: record.user.emailVerifiedAt !== null },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { status: "VERIFIED" };
}

export async function resendVerification(
  userId: string,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ message: string; emailVerified: boolean; sent: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new UnauthenticatedError("Your session has expired. Please sign in again.");
  }

  // Already verified: the same generic message, and no new link is issued.
  if (user.emailVerifiedAt) {
    return { message: GENERIC_VERIFICATION_MESSAGE, emailVerified: true, sent: false };
  }

  const outcome = await issueEmailVerification(user, context);
  return { message: GENERIC_VERIFICATION_MESSAGE, emailVerified: false, sent: outcome.sent };
}

/**
 * Cookie options. `secure` is mandatory in production; `sameSite: "lax"` still
 * permits the top-level OAuth redirect back from Google while blocking CSRF from
 * cross-site form posts.
 */
export function authCookieOptions(maxAgeMs: number): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
  domain?: string;
} {
  return {
    httpOnly: true,
    secure: isProduction || env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeMs,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export const ACCESS_COOKIE = "mailops_at";
export const REFRESH_COOKIE = "mailops_rt";
export const CSRF_COOKIE = "mailops_csrf";
