import type { Request, Response } from "express";
import { z } from "zod";
import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  DEFAULT_PASSWORD_MIN_LENGTH,
  REFRESH_COOKIE,
  authCookieOptions,
  changePassword as changePasswordService,
  loginUser,
  refreshSession,
  registerUser,
  requestPasswordReset as requestPasswordResetService,
  resendVerification as resendVerificationService,
  resetPassword as resetPasswordService,
  revokeAllSessions,
  revokeRefreshToken,
  toAuthenticatedUser,
  verifyEmail as verifyEmailService,
  type AuthResult,
} from "../services/auth/auth.service";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { currentUserId } from "../middleware/auth";
import { ensureCsrfCookie } from "../middleware/security";
import { getOrCreateSettings } from "../services/settings/settings.service";
import { ObliterateUserAccountService } from "../services/account/deletion.service";
import { ok } from "../utils/http";
import { AUDIT_ACTIONS, recordAudit } from "../services/audit/audit.service";
import { AppError, ERROR_CODES, NotFoundError } from "../utils/errors";

export const registerSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(200),
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().max(64).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

function sanitizeTimezone(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    // Throws for an unknown IANA zone, which is exactly the check we want.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return fallback;
  }
}

/** Sets the httpOnly access + refresh cookies on an auth success. */
function applyAuthCookies(res: Response, result: AuthResult): void {
  res.cookie(
    ACCESS_COOKIE,
    result.tokens.accessToken,
    authCookieOptions(result.tokens.accessTokenExpiresAt.getTime() - Date.now()),
  );
  res.cookie(
    REFRESH_COOKIE,
    result.tokens.refreshToken,
    authCookieOptions(result.tokens.refreshTokenExpiresAt.getTime() - Date.now()),
  );
}

/**
 * CSRF bootstrap.
 *
 * The double-submit token has to exist *before* the first state-changing request,
 * but every endpoint that issues it in the auth flow is itself a POST — and
 * `csrfMiddleware` rejects a POST that has no matching token. That is a deadlock:
 * login can never satisfy the check that login itself needs.
 *
 * This endpoint breaks it without weakening anything:
 *   - it is a GET, so it is exempt as a safe method by construction (there is no
 *     exemption list to maintain and no route is skipped),
 *   - it needs no session and reveals nothing: the response contains only a freshly
 *     generated random token,
 *   - the cookie it sets is readable by design (the client must echo it), exactly
 *     as `ensureCsrfCookie` already did for signed-in users,
 *   - it is idempotent: an existing token is returned unchanged, so calling it
 *     again never invalidates the token a page is already using.
 *
 * Every state-changing endpoint still requires the cookie AND the matching
 * X-CSRF-Token header.
 */
export async function csrf(req: Request, res: Response) {
  return ok(res, { csrfToken: ensureCsrfCookie(req, res), cookieName: CSRF_COOKIE });
}

export async function register(req: Request, res: Response) {
  const body = req.body as z.infer<typeof registerSchema>;
  const timezone = sanitizeTimezone(body.timezone, "UTC");

  const result = await registerUser(
    { ...body, timezone },
    { ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null },
  );
  applyAuthCookies(res, result);

  return ok(res, { user: result.user, csrfToken: ensureCsrfCookie(req, res) }, undefined, 201);
}

export async function login(req: Request, res: Response) {
  const body = req.body as z.infer<typeof loginSchema>;
  const result = await loginUser(body, {
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  applyAuthCookies(res, result);
  return ok(res, { user: result.user, csrfToken: ensureCsrfCookie(req, res) });
}

export async function refresh(req: Request, res: Response) {
  const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? (req.body?.refreshToken as string | undefined);
  if (!token) {
    res.clearCookie(ACCESS_COOKIE, authCookieOptions(0));
    res.clearCookie(REFRESH_COOKIE, authCookieOptions(0));
    return ok(res, { user: null, authenticated: false });
  }

  const result = await refreshSession(token, {
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  applyAuthCookies(res, result);
  return ok(res, { user: result.user, authenticated: true });
}

export async function logout(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) await revokeRefreshToken(token);

  if (req.auth?.userId) {
    await recordAudit({
      userId: req.auth.userId,
      actor: "USER",
      action: AUDIT_ACTIONS.userLogout,
      entityType: "User",
      entityId: req.auth.userId,
      summary: "Signed out",
    });
  }

  res.clearCookie(ACCESS_COOKIE, authCookieOptions(0));
  res.clearCookie(REFRESH_COOKIE, authCookieOptions(0));
  res.clearCookie(CSRF_COOKIE, authCookieOptions(0));

  return ok(res, { signedOut: true });
}

/** Current session bootstrap: user + settings + csrf token in one round trip. */
export async function me(req: Request, res: Response) {
  const userId = currentUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      timezone: true,
      isDemo: true,
      emailVerifiedAt: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });
  if (!user) throw new NotFoundError("User");

  const settings = await getOrCreateSettings(userId);
  const gmailAccounts = await prisma.gmailAccount.findMany({
    where: { userId },
    select: { id: true, emailAddress: true, status: true, lastSyncAt: true, grantedScopes: true },
  });

  return ok(res, {
    user: toAuthenticatedUser(user),
    settings,
    gmailAccounts,
    csrfToken: ensureCsrfCookie(req, res),
    defaults: {
      gmailConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      aiProvider: env.AI_PROVIDER,
    },
  });
}

export async function revokeSessions(req: Request, res: Response) {
  const userId = currentUserId(req);
  const count = await revokeAllSessions(userId);
  res.clearCookie(ACCESS_COOKIE, authCookieOptions(0));
  res.clearCookie(REFRESH_COOKIE, authCookieOptions(0));
  return ok(res, { revoked: count });
}

/** ------------------------------------------------------------------------ */
/** Password lifecycle                                                        */
/** ------------------------------------------------------------------------ */

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(200),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(200),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1).max(400),
  newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(200),
});

/**
 * Authenticated password change.
 *
 * The refresh token of the calling session is passed through so the service can
 * keep this session alive while revoking every other one.
 */
export async function changePassword(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = req.body as z.infer<typeof changePasswordSchema>;

  const result = await changePasswordService(
    userId,
    {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepRefreshToken: (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? null,
    },
    { ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null },
  );

  return ok(res, { changed: true, revokedSessions: result.revokedSessions });
}

/**
 * Password reset request.
 *
 * Returns the service's single generic message regardless of whether the address
 * exists, whether the account is the demo account, or whether delivery succeeded.
 * The delivery outcome is recorded in the audit log only.
 */
export async function forgotPassword(req: Request, res: Response) {
  const body = req.body as z.infer<typeof forgotPasswordSchema>;

  const result = await requestPasswordResetService({
    email: body.email,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  return ok(res, { message: result.message });
}

/** ------------------------------------------------------------------------ */
/** Email verification                                                        */
/** ------------------------------------------------------------------------ */

export const verifyEmailQuerySchema = z.object({
  token: z.string().trim().min(1).max(400),
});

/**
 * Email verification landing endpoint.
 *
 * Public by necessity: the link is opened from an email, often on a different
 * device or browser than the one that registered. The token *is* the credential,
 * so no session is required — and the response returns only the verdict, never the
 * token and never anything about the account.
 */
export async function verifyEmail(req: Request, res: Response) {
  const query = req.query as z.infer<typeof verifyEmailQuerySchema>;

  const { status } = await verifyEmailService({
    token: query.token,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  if (status === "VERIFIED" || status === "ALREADY_VERIFIED") {
    return ok(res, { status, emailVerified: true });
  }

  // `details.status` lets the result page distinguish expired from invalid without
  // revealing anything about the token beyond the verdict.
  throw new AppError(
    status === "EXPIRED"
      ? "This verification link has expired. Request a new one from Settings."
      : "This verification link is not valid.",
    { statusCode: 400, code: ERROR_CODES.VALIDATION_ERROR, details: { status } },
  );
}

/**
 * Resend the verification email.
 *
 * Authenticated, so there is no enumeration surface — the caller can only act on
 * their own account. The message is still generic, and `emailVerified` reports the
 * caller's own state so the UI can drop its banner without a refetch.
 */
export async function resendVerification(req: Request, res: Response) {
  const userId = currentUserId(req);

  const result = await resendVerificationService(userId, {
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  return ok(res, { message: result.message, emailVerified: result.emailVerified, sent: result.sent });
}

/**
 * Password reset completion.
 *
 * On success every session is already revoked by the service, so the caller's own
 * cookies are cleared here to force a clean re-authentication.
 */
export async function resetPassword(req: Request, res: Response) {
  const body = req.body as z.infer<typeof resetPasswordSchema>;

  const result = await resetPasswordService({
    token: body.token,
    newPassword: body.newPassword,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  res.clearCookie(ACCESS_COOKIE, authCookieOptions(0));
  res.clearCookie(REFRESH_COOKIE, authCookieOptions(0));

  return ok(res, { reset: true, revokedSessions: result.revokedSessions });
}

/** ------------------------------------------------------------------------ */
/** Account deletion                                                         */
/** ------------------------------------------------------------------------ */

/**
 * `.strict()` is load-bearing, not cosmetic.
 *
 * The schema accepts exactly two fields, so a request that tries to smuggle a
 * `userId` (or anything else) is rejected with 422 rather than being silently
 * ignored. The account being deleted comes only from the authenticated session —
 * there is no code path that reads a target id from the body.
 */
export const deleteAccountSchema = z
  .object({
    password: z.string().min(1).max(200),
    confirmation: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * Delete the authenticated user's account and erase all stored data.
 *
 * The service performs password re-authentication and the email confirmation check
 * itself, then revokes external grants, writes the de-identified receipt, deletes the
 * user row (the database cascades the rest) and purges Redis. This handler is
 * deliberately thin: orchestration ordering lives in one place, where it is testable.
 *
 * Session cleanup: `revokeAllSessions` runs inside the service while the rows still
 * exist, and the cookies are cleared here. Outstanding access JWTs are already
 * rejected by `requireAuth`'s database existence check, so nothing further is needed.
 */
export async function deleteAccount(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = req.body as z.infer<typeof deleteAccountSchema>;

  const result = await ObliterateUserAccountService.obliterate(userId, {
    actor: "USER",
    // Never logged, never echoed into an audit row.
    password: body.password,
    confirmation: body.confirmation,
    ip: req.ip ?? null,
  });

  res.clearCookie(ACCESS_COOKIE, authCookieOptions(0));
  res.clearCookie(REFRESH_COOKIE, authCookieOptions(0));
  res.clearCookie(CSRF_COOKIE, authCookieOptions(0));

  return ok(res, result);
}
