import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { env, isTest } from "../config/env";
import { AppError, ERROR_CODES } from "./errors";

/**
 * Envelope encryption for credentials at rest (OAuth tokens, integration secrets).
 *
 * Format: v1.<iv-b64>.<authTag-b64>.<ciphertext-b64>
 * Algorithm: AES-256-GCM, random 12-byte IV per record, auth tag verified on read.
 *
 * Keys are NEVER logged. `describeKey()` exists solely for operational diagnostics.
 */

const KEY_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function resolveKey(): Buffer {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new AppError("ENCRYPTION_KEY is required in production", {
        code: ERROR_CODES.INTERNAL_ERROR,
      });
    }
    // Development/test fallback: deterministic, obviously-insecure key derived
    // from JWT_SECRET so local runs work without extra setup.
    return crypto.createHash("sha256").update(`mailops-dev::${env.JWT_SECRET}`).digest();
  }
  const key = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 43 ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
  if (key.length !== 32) {
    throw new AppError("ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)", {
      code: ERROR_CODES.INTERNAL_ERROR,
    });
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, resolveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== KEY_VERSION) {
    throw new AppError("Stored credential has an unsupported format", {
      code: ERROR_CODES.INTERNAL_ERROR,
    });
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, resolveKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (error) {
    throw new AppError("Unable to decrypt stored credential (wrong key or corrupted data)", {
      code: ERROR_CODES.INTERNAL_ERROR,
      cause: error,
    });
  }
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value ?? {}));
}

export function decryptJson<T = Record<string, unknown>>(payload: string | null | undefined): T | null {
  const raw = decryptSecret(payload);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Non-reversible fingerprint used to look up refresh-token rows. */
export function hashToken(token: string): string {
  return crypto.createHmac("sha256", env.JWT_SECRET).update(token).digest("hex");
}

/** Prefix on every receipt fingerprint. Lets a future rotation be detected, not silent. */
const RECEIPT_KEY_VERSION = "v1";

/**
 * Parses a receipt key without any fallback.
 *
 * `ENCRYPTION_KEY` may fall back to a JWT_SECRET-derived value in development; a receipt
 * key must not, because the whole point is to stop the permanent receipt from depending on
 * a rotatable secret. So a missing or too-short key throws here, in every environment.
 */
function resolveReceiptKey(raw: string | undefined, name: string): Buffer {
  if (!raw) {
    throw new AppError(`${name} is required to fingerprint account-deletion receipts`, {
      code: ERROR_CODES.INTERNAL_ERROR,
    });
  }
  const key = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 43 ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
  if (key.length < 32) {
    throw new AppError(`${name} must provide at least 32 bytes (256 bits) of key material`, {
      code: ERROR_CODES.INTERNAL_ERROR,
    });
  }
  return key;
}

/**
 * Fingerprint for the permanent account-deletion receipt.
 *
 * Format: `v1.<64 lowercase hex>` — HMAC-SHA256 of `value` under `RECEIPT_HMAC_KEY`.
 *
 * Deliberately NOT `hashToken`. That helper is keyed by `JWT_SECRET`, which is expected to
 * be rotated and which also signs access tokens and fingerprints refresh/reset/verification
 * tokens. A deletion receipt is permanent and is matched by recomputing the digest, so a
 * rotatable key makes every historical receipt unmatchable after the first rotation — and
 * because the lookup simply returns no rows, that failure is silent and is easy to misread
 * as "this account was never deleted".
 */
export function receiptFingerprint(value: string): string {
  const key = resolveReceiptKey(env.RECEIPT_HMAC_KEY, "RECEIPT_HMAC_KEY");
  return `${RECEIPT_KEY_VERSION}.${crypto.createHmac("sha256", key).update(value).digest("hex")}`;
}

/**
 * Does `value` produce the stored receipt fingerprint?
 *
 * Accepts a digest written under the current key, or — during a two-phase rotation — under
 * `RECEIPT_HMAC_KEY_PREVIOUS`. The comparison is timing-safe.
 *
 * Legacy bare-hex values (written by the old `hashToken`/JWT_SECRET scheme, before the
 * `v1.` prefix existed) return `false` here by design. Re-deriving a JWT_SECRET hash in
 * this function would put the rotatable key back on the verification path, which is the
 * coupling this change removes; those records are verified with the documented legacy
 * procedure instead (see SECURITY.md).
 */
export function matchesReceiptFingerprint(stored: string, value: string): boolean {
  if (!stored.startsWith(`${RECEIPT_KEY_VERSION}.`)) return false;

  // Deliberately awaited first: a missing current key must surface as an error rather
  // than being swallowed into a "no match" answer.
  if (safeEqual(stored, receiptFingerprint(value))) return true;

  const previousRaw = env.RECEIPT_HMAC_KEY_PREVIOUS;
  if (!previousRaw) return false;

  const previousKey = resolveReceiptKey(previousRaw, "RECEIPT_HMAC_KEY_PREVIOUS");
  const previous = `${RECEIPT_KEY_VERSION}.${crypto.createHmac("sha256", previousKey).update(value).digest("hex")}`;
  return safeEqual(stored, previous);
}

export async function hashPassword(password: string): Promise<string> {
  const rounds = isTest ? 4 : 12;
  return bcrypt.hash(password, rounds);
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function generateOpaqueId(prefix: string, size = 10): string {
  return `${prefix}_${crypto.randomBytes(size).toString("hex")}`;
}

/** Timing-safe comparison for state parameters. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Operational diagnostics only — never returns key material. */
export function describeKey(): { configured: boolean; length: number; fingerprint: string } {
  const raw = env.ENCRYPTION_KEY;
  const key = resolveKey();
  return {
    configured: Boolean(raw),
    length: key.length,
    fingerprint: crypto.createHash("sha256").update(key).digest("hex").slice(0, 8),
  };
}
