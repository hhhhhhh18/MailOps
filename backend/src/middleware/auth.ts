import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { ACCESS_COOKIE, verifyAccessToken } from "../services/auth/auth.service";
import { ForbiddenError, UnauthenticatedError } from "../utils/errors";

/**
 * Authentication + authorization middleware.
 *
 * The access token is read from the httpOnly cookie first, then from the
 * Authorization header (so service-to-service callers and tests can use a bearer
 * token). A request is never authenticated by a query-string token, which would
 * leak into logs and referrers.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        email: string;
        isDemo: boolean;
      };
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const cookieToken = req.cookies?.[ACCESS_COOKIE] as string | undefined;
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const token = cookieToken ?? bearer;

    if (!token) throw new UnauthenticatedError();

    const claims = verifyAccessToken(token);

    // Cheap existence check; keeps deleted/disabled accounts from holding a valid
    // signing key for the token's lifetime.
    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, isDemo: true },
    });
    if (!user) throw new UnauthenticatedError("Your account is no longer available.");

    req.auth = { userId: user.id, email: user.email, isDemo: user.isDemo };
    next();
  } catch (error) {
    next(error);
  }
}

/** Attaches auth when present, but never rejects. Used for optional endpoints. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.cookies?.[ACCESS_COOKIE] as string | undefined) ?? undefined;
    if (token) {
      const claims = verifyAccessToken(token);
      req.auth = { userId: claims.sub, email: claims.email, isDemo: false };
    }
  } catch {
    // Ignore invalid tokens on optional routes.
  }
  next();
}

export function currentUserId(req: Request): string {
  if (!req.auth?.userId) throw new UnauthenticatedError();
  return req.auth.userId;
}

/**
 * Demo accounts are read-mostly: they may explore every screen but must not
 * connect real integrations or trigger irreversible actions.
 */
export function blockDemoWrites(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.isDemo && req.method !== "GET") {
    next(new ForbiddenError("The demo account is read-only. Create your own account to make changes."));
    return;
  }
  next();
}
