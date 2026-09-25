/**
 * Redaction helpers used by the audit log, notification bodies and analytics
 * exports. Log redaction itself lives in config/logger.ts; this module covers
 * data that is *stored* (audit metadata, notification previews).
 */

const TOKEN_LIKE = /\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|EAA[A-Za-z0-9]+)\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const KEY_VALUE = /\b(access_token|refresh_token|api[_-]?key|client_secret|password)\b\s*[:=]\s*["']?([^\s"',;]{6,})["']?/gi;

/**
 * A one-time token carried in a URL query string or fragment — password reset and
 * invitation links.
 *
 * Scoped deliberately to a URL delimiter before the key, so it cannot rewrite
 * ordinary prose that happens to contain the word "token", while still catching
 * the single most dangerous thing that could reach a log: a live reset URL.
 */
const URL_TOKEN = /([?&#](?:token|reset_token|resetToken|invite_token)=)[A-Za-z0-9._~+%/-]+/gi;

/** Removes anything that looks like credential material from a free-text string. */
export function redactSecrets(input: string): string {
  return input
    .replace(TOKEN_LIKE, "[REDACTED_TOKEN]")
    .replace(BEARER, "$1 [REDACTED]")
    .replace(JWT_LIKE, "[REDACTED_JWT]")
    .replace(URL_TOKEN, "$1[REDACTED]")
    .replace(KEY_VALUE, (_m, key) => `${key}=[REDACTED]`);
}

/** masks an email address: jane.doe@corp.com -> j***e@corp.com */
export function maskEmail(address: string | null | undefined): string | null {
  if (!address) return null;
  const [local, domain] = address.split("@");
  if (!domain) return "[redacted]";
  const visible = local.length <= 2 ? local.slice(0, 1) : `${local[0]}***${local[local.length - 1]}`;
  return `${visible}@${domain}`;
}

/** Masks a phone number, preserving country code and last two digits. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.length <= 4) return "***";
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

export function maskSecretValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/**
 * Email preview safe for notifications: subject-level detail only, no body.
 * The product rule is "do not send sensitive email contents unnecessarily".
 */
export function safeEmailPreview(subject: string | null | undefined, maxLength = 120): string | null {
  if (!subject) return null;
  const cleaned = redactSecrets(subject).replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/**
 * Builds audit metadata from an arbitrary object, dropping body/token fields and
 * truncating long values so the audit log never becomes a shadow inbox.
 */
export function sanitizeForAudit(input: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    const redacted = redactSecrets(input);
    return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
  }
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) return input.slice(0, 25).map((v) => sanitizeForAudit(v, depth + 1));
  if (typeof input === "object") {
    const SENSITIVE = /(token|secret|password|authorization|cookie|api[-_]?key|body|html|raw|credential)/i;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE.test(key) ? "[REDACTED]" : sanitizeForAudit(value, depth + 1);
    }
    return out;
  }
  return "[unserializable]";
}
