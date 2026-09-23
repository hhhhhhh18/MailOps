import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { env, isProduction } from "../config/env";
import { logger } from "../config/logger";
import { AppError, ERROR_CODES, isAppError, type ErrorCode } from "../utils/errors";
import { redactSecrets } from "../utils/redact";

/**
 * Central error handler.
 *
 * Contract with clients:
 *   { success: false, error: { code, message, details?, retryable, degraded, requestId } }
 *
 * Two guarantees matter here:
 *  1. Internal messages are never leaked in production — a Prisma failure becomes
 *     a generic 500, not a SQL fragment.
 *  2. Integration failures are reported as *degraded* rather than fatal, so the UI
 *     can say "Slack failed, WhatsApp escalation is still available" instead of
 *     showing a crash screen.
 */

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(`No route matches ${req.method} ${req.path}`, {
      statusCode: 404,
      code: ERROR_CODES.NOT_FOUND,
    }),
  );
}

interface ErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    retryable: boolean;
    degraded: boolean;
    requestId: string;
  };
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = getRequestId(req);

  const { statusCode, code, message, details, retryable, degraded } = normalise(error);

  const level = statusCode >= 500 ? "error" : statusCode === 429 ? "warn" : "debug";
  logger[level](
    {
      requestId,
      method: req.method,
      path: req.path,
      statusCode,
      code,
      // Message is redacted defensively: an integration error may echo provider text.
      message: redactSecrets(message).slice(0, 500),
      ...(isProduction ? {} : { stack: error instanceof Error ? error.stack : undefined }),
    },
    "request failed",
  );

  const body: ErrorBody = {
    success: false,
    error: {
      code,
      message: statusCode >= 500 && isProduction && !isAppError(error) ? "Something went wrong on our side." : message,
      ...(details && !isProduction ? { details } : {}),
      retryable,
      degraded,
      requestId,
    },
  };

  if (res.headersSent) return;
  res.status(statusCode).json(body);
}

interface Normalised {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  retryable: boolean;
  degraded: boolean;
}

function normalise(error: unknown): Normalised {
  if (isAppError(error)) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: error.retryable,
      degraded: error.degraded,
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 422,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: "The request contains invalid data",
      details: error.flatten(),
      retryable: false,
      degraded: false,
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") {
      return {
        statusCode: 404,
        code: ERROR_CODES.NOT_FOUND,
        message: "That record no longer exists",
        retryable: false,
        degraded: false,
      };
    }
    if (error.code === "P2002") {
      return {
        statusCode: 409,
        code: ERROR_CODES.CONFLICT,
        message: "That record already exists",
        details: isProduction ? undefined : error.meta,
        retryable: false,
        degraded: false,
      };
    }
    if (["P1001", "P1002", "P1017"].includes(error.code)) {
      return {
        statusCode: 503,
        code: ERROR_CODES.DATABASE_UNAVAILABLE,
        message: "The database is temporarily unavailable. Please retry in a moment.",
        retryable: true,
        degraded: true,
      };
    }
    return {
      statusCode: 500,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "A database error occurred",
      details: isProduction ? undefined : { prismaCode: error.code },
      retryable: false,
      degraded: false,
    };
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"].includes(code)) {
      return {
        statusCode: 503,
        code: ERROR_CODES.REDIS_UNAVAILABLE,
        message: "A background dependency is unreachable. MailOps will retry automatically.",
        retryable: true,
        degraded: true,
      };
    }
  }

  return {
    statusCode: 500,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : "Unexpected error",
    retryable: false,
    degraded: false,
  };
}

function getRequestId(req: Request): string {
  const existing = (req as Request & { id?: string }).id;
  return existing ?? `req_${Math.random().toString(36).slice(2, 10)}`;
}

/** Populates req.id for correlation between logs and client error reports. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers["x-request-id"] as string | undefined) ?? `req_${Math.random().toString(36).slice(2, 10)}`;
  (req as Request & { id?: string }).id = id;
  res.setHeader("x-request-id", id);
  next();
}

export const errorHandlerOptions = { env: env.NODE_ENV };
