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
