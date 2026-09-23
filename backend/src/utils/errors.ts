export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",

  GMAIL_NOT_CONNECTED: "GMAIL_NOT_CONNECTED",
  GMAIL_CONNECTION_EXPIRED: "GMAIL_CONNECTION_EXPIRED",
  GMAIL_API_UNAVAILABLE: "GMAIL_API_UNAVAILABLE",
  GMAIL_INVALID_TOKEN: "GMAIL_INVALID_TOKEN",

  AI_PROVIDER_UNAVAILABLE: "AI_PROVIDER_UNAVAILABLE",
  AI_INVALID_OUTPUT: "AI_INVALID_OUTPUT",
  AI_LOW_CONFIDENCE: "AI_LOW_CONFIDENCE",

  SLACK_DISCONNECTED: "SLACK_DISCONNECTED",
  WHATSAPP_UNAVAILABLE: "WHATSAPP_UNAVAILABLE",
  VOICE_UNAVAILABLE: "VOICE_UNAVAILABLE",
  EMAIL_CHANNEL_UNAVAILABLE: "EMAIL_CHANNEL_UNAVAILABLE",

  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  REDIS_UNAVAILABLE: "REDIS_UNAVAILABLE",
  QUEUE_UNAVAILABLE: "QUEUE_UNAVAILABLE",

  PROTECTED_EMAIL: "PROTECTED_EMAIL",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  INTEGRATION_NOT_CONFIGURED: "INTEGRATION_NOT_CONFIGURED",

  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Error contract returned to clients. `degraded` signals that MailOps continued
 * operating in a reduced capacity rather than failing the whole request.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly degraded: boolean;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: ErrorCode;
      details?: unknown;
      retryable?: boolean;
      degraded?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? ERROR_CODES.INTERNAL_ERROR;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.degraded = options.degraded ?? false;
    if (options.cause) this.cause = options.cause;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request payload", details?: unknown) {
    super(message, { statusCode: 422, code: ERROR_CODES.VALIDATION_ERROR, details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, { statusCode: 401, code: ERROR_CODES.UNAUTHENTICATED });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super(message, { statusCode: 403, code: ERROR_CODES.FORBIDDEN });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource", message?: string) {
    super(message ?? `${resource} not found`, { statusCode: 404, code: ERROR_CODES.NOT_FOUND });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict", details?: unknown) {
    super(message, { statusCode: 409, code: ERROR_CODES.CONFLICT, details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super(message, { statusCode: 429, code: ERROR_CODES.RATE_LIMITED, retryable: true });
  }
}

/** Raised when Redis/BullMQ is unreachable but the request itself is valid. */
export class QueueUnavailableError extends AppError {
  constructor(message = "Background processing is temporarily unavailable. Please retry shortly.") {
    super(message, {
      statusCode: 503,
      code: ERROR_CODES.QUEUE_UNAVAILABLE,
      retryable: true,
      degraded: true,
    });
  }
}

export class IntegrationError extends AppError {
  constructor(
    message: string,
    code: ErrorCode,
    options: { retryable?: boolean; degraded?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, {
      statusCode: 502,
      code,
      retryable: options.retryable ?? true,
      degraded: options.degraded ?? true,
      details: options.details,
      cause: options.cause,
    });
  }
}

/** A destructive action blocked by a protection rule. */
export class ProtectedResourceError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { statusCode: 409, code: ERROR_CODES.PROTECTED_EMAIL, details });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError(error.message, { cause: error });
  }
  return new AppError("Unexpected error");
}

/** Normalises unknown thrown values into a loggable shape. */
export function describeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error), name: "UnknownError" };
}
