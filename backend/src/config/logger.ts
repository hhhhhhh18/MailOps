import pino from "pino";
import { env, isProduction } from "./env";

/**
 * Structured logging with mandatory redaction.
 *
 * The following must NEVER appear in logs:
 *   OAuth access tokens, OAuth refresh tokens, full private email bodies,
 *   passwords, API secrets, cookies, authorization headers.
 *
 * Redaction is applied centrally so no call site can opt out by accident.
 */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "password",
  "passwordHash",
  "password_hash",
  "newPassword",
  "currentPassword",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "accessTokenEnc",
  "refreshTokenEnc",
  "idToken",
  "id_token",
  "clientSecret",
  "client_secret",
  "apiKey",
  "api_key",
  "apiKeyEnc",
  "secretsEnc",
  "secret",
  "authorization",
  "body",
  "bodyText",
  "bodyHtml",
  "raw",
  "rawBody",
  "html",
  "text",
  "content",
  "emailBody",
  "snippet",
  "payload",
  "credential",
  "credentials",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.body",
  "*.bodyText",
  "*.secretsEnc",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
  base: { service: "mailops-api", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProduction
    ? undefined
    : {
        target: "pino/file",
        options: { destination: 1 },
      },
});

export type Logger = typeof logger;

/**
 * Defensive helper for places where a whole object might be logged and we cannot
 * rely on pino path redaction (e.g. objects nested in arrays).
 */
export function safeLogObject(input: unknown): unknown {
  const SENSITIVE = /(token|secret|password|authorization|cookie|api[-_]?key|body|credential)/i;
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.slice(0, 50).map(safeLogObject);
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? "[REDACTED]" : safeLogObject(v);
    }
    return out;
  }
  if (typeof input === "string" && input.length > 500) return `${input.slice(0, 500)}…[truncated]`;
  return input;
}
