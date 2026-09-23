import jwt, { type SignOptions } from "jsonwebtoken";
import type { User, UserSettings } from "@prisma/client";
import { env, isProduction } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { hashPassword, hashToken, randomToken, verifyPassword } from "../../utils/crypto";
import { AppError, ERROR_CODES, UnauthenticatedError, ValidationError } from "../../utils/errors";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";

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
}

export interface AuthResult {
  user: AuthenticatedUser;
  tokens: IssuedTokens;
}

export const DEFAULT_PASSWORD_MIN_LENGTH = 10;

export async function registerUser(input: {
  email: string;
  password: string;
  name?: string | null;
  timezone?: string;
}): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("Enter a valid email address");
  }
  if (input.password.length < DEFAULT_PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`Password must be at least ${DEFAULT_PASSWORD_MIN_LENGTH} characters long`);
  }
  if (!/[A-Za-z]/.test(input.password) || !/\d/.test(input.password)) {
    throw new ValidationError("Password must contain at least one letter and one number");
  }

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

export function toAuthenticatedUser(user: Pick<User, "id" | "email" | "name" | "timezone" | "isDemo">): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    isDemo: user.isDemo,
  };
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
