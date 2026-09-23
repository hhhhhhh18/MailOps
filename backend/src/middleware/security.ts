import type { NextFunction, Request, RequestHandler, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env, isProduction } from "../config/env";
import { AppError, ERROR_CODES, ForbiddenError } from "../utils/errors";
import { randomToken, safeEqual } from "../utils/crypto";
import { CSRF_COOKIE } from "../services/auth/auth.service";

/**
 * Security middleware stack.
 *
 * Layers, in order:
 *   helmet            secure headers + a CSP that permits only local assets
 *   cors              strict origin allow-list (no wildcard with credentials)
 *   rate limiting     global + a tighter bucket for auth endpoints
 *   cookies           httpOnly access/refresh cookies + a readable CSRF token
 *   CSRF              double-submit token on state-changing methods
 */

export const securityHeaders = helmet({
  contentSecurityPolicy: isProduction
    ? {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'", env.WEB_BASE_URL],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      }
    : false, // The dev server needs inline scripts for React refresh.
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  frameguard: { action: "deny" },
  noSniff: true,
});

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Same-origin/non-browser callers have no Origin header.
    if (!origin) return callback(null, true);
    const allowed = [env.WEB_BASE_URL, "http://localhost:3000", "http://127.0.0.1:3000"];
    if (allowed.includes(origin)) return callback(null, true);
    callback(new ForbiddenError(`Origin ${origin} is not allowed to call the MailOps API`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Request-Id"],
  exposedHeaders: ["X-Request-Id", "RateLimit-Remaining", "Retry-After"],
  maxAge: 600,
});

export const cookiesMiddleware = cookieParser();

export const globalRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Health checks must never be throttled.
  skip: (req) => req.path === "/health" || req.path === "/health/live",
  handler: (_req, _res, next) => {
    next(new AppError("Too many requests. Please slow down and try again shortly.", {
      statusCode: 429,
      code: ERROR_CODES.RATE_LIMITED,
      retryable: true,
    }));
  },
});

export const authRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (_req, _res, next) => {
    next(
      new AppError("Too many sign-in attempts. Please wait a minute before trying again.", {
        statusCode: 429,
        code: ERROR_CODES.RATE_LIMITED,
        retryable: true,
      }),
    );
  },
});

/**
 * Double-submit CSRF protection.
 *
 * A random token is written to a readable cookie; the client echoes it in the
 * X-CSRF-Token header. Because a cross-site attacker cannot read the cookie, it
 * cannot forge the header. Safe methods are exempt.
 */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Machine-to-machine callers using a bearer token are not cookie-authenticated
  // and therefore not CSRF-reachable.
  if (req.headers.authorization?.startsWith("Bearer ")) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const headerToken = (req.headers["x-csrf-token"] as string | undefined) ?? (req.body?._csrf as string | undefined);

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    next(new ForbiddenError("Your session could not be verified. Refresh the page and try again."));
    return;
  }

  next();
}

export function ensureCsrfCookie(req: Request, res: Response): string {
  const existing = req.cookies?.[CSRF_COOKIE] as string | undefined;
  if (existing) return existing;
  const token = randomToken(24);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // must be readable by the client to be echoed back
    sameSite: "lax",
    secure: isProduction || env.COOKIE_SECURE,
    path: "/",
    maxAge: 86_400_000,
  });
  return token;
}

/** Guards the interactive Gmail OAuth start endpoint against open redirects. */
export function safeRedirectPath(value: unknown, fallback = "/settings?section=gmail"): string {
  if (typeof value !== "string") return fallback;
  // Only same-app absolute paths are permitted.
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\") || value.includes("\n")) return fallback;
  return value;
}

export type Middleware = RequestHandler;
