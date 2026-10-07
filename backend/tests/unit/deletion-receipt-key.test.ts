/**
 * Deletion-receipt fingerprint key derivation (F5).
 *
 * The receipt is the one row designed to outlive an account, and it is matched by
 * *recomputing* the digest from a user id. It used to be keyed by `JWT_SECRET` through
 * `hashToken`, so the first rotation of that secret silently made every historical receipt
 * unmatchable — the lookup returned no rows, which reads as "this account was never
 * deleted" rather than as an error.
 *
 * These tests pin the replacement: a dedicated `RECEIPT_HMAC_KEY`, independent of the
 * signing/encryption secrets, with no fallback in any environment.
 *
 * `config/env` is mocked so the key can be varied per test — the whole point is behaviour
 * as a function of the key, which a fixed process-wide `env` cannot express.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: {
    RECEIPT_HMAC_KEY: undefined as string | undefined,
    RECEIPT_HMAC_KEY_PREVIOUS: undefined as string | undefined,
    JWT_SECRET: "jwt-secret-for-signing-tokens-abcdefghijklmnopqr",
    ENCRYPTION_KEY: "encryption-key-for-stored-credentials-abcdefghij",
  },
}));

vi.mock("../../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env")>();
  return { ...actual, env: fakeEnv as unknown as typeof actual.env };
});

import { hashToken, matchesReceiptFingerprint, receiptFingerprint } from "../../src/utils/crypto";
import { AppError } from "../../src/utils/errors";

/** 32 bytes of utf8 (the `-` keeps it off the base64 path), so it satisfies the length rule. */
const key = (label: string): string => `k-${label}-`.padEnd(32, "x");

const KEY_A = key("alpha");
const KEY_B = key("bravo");
const KEY_PREV = key("previous");

const USER_ID = "clz9x8v7b0000abcd1234efgh";
const IP = "198.51.100.42";

beforeEach(() => {
  fakeEnv.RECEIPT_HMAC_KEY = KEY_A;
  fakeEnv.RECEIPT_HMAC_KEY_PREVIOUS = undefined;
  fakeEnv.JWT_SECRET = "jwt-secret-for-signing-tokens-abcdefghijklmnopqr";
  fakeEnv.ENCRYPTION_KEY = "encryption-key-for-stored-credentials-abcdefghij";
});

describe("receiptFingerprint — format and determinism", () => {
  it("emits the versioned v1 format", () => {
    expect(receiptFingerprint(USER_ID)).toMatch(/^v1\.[0-9a-f]{64}$/);
  });

  it("is deterministic for the same key and value", () => {
    expect(receiptFingerprint(USER_ID)).toBe(receiptFingerprint(USER_ID));
    expect(receiptFingerprint(IP)).toBe(receiptFingerprint(IP));
  });

  it("does not embed or reveal the fingerprinted value", () => {
    const digest = receiptFingerprint(USER_ID);
    expect(digest).not.toContain(USER_ID);
    expect(digest.toLowerCase()).not.toContain(USER_ID.toLowerCase());
  });
});

describe("receiptFingerprint — independence from the other secrets", () => {
  it("does not change when JWT_SECRET rotates", () => {
    const before = receiptFingerprint(USER_ID);

    // This is the F5 regression guard. Under the old implementation the digest was a
    // function of JWT_SECRET, so this line would fail.
    fakeEnv.JWT_SECRET = "a-completely-different-signing-secret-0123456789";

    expect(receiptFingerprint(USER_ID)).toBe(before);
  });

  it("does not change when ENCRYPTION_KEY rotates", () => {
    const before = receiptFingerprint(USER_ID);
    fakeEnv.ENCRYPTION_KEY = "another-encryption-key-entirely-0123456789abc";
    expect(receiptFingerprint(USER_ID)).toBe(before);
  });

  it("does change when RECEIPT_HMAC_KEY rotates", () => {
    const before = receiptFingerprint(USER_ID);
    fakeEnv.RECEIPT_HMAC_KEY = KEY_B;

    // Proves the key is genuinely the variable, so the JWT-independence assertions above
    // are about the key and not about a function that ignores its input.
    expect(receiptFingerprint(USER_ID)).not.toBe(before);
  });

  it("is not the JWT_SECRET-keyed token hash", () => {
    // Same input, two different helpers: they must not agree, and the receipt must not
    // simply be the token-hash space under another name.
    expect(receiptFingerprint(USER_ID)).not.toBe(hashToken(USER_ID));
    expect(receiptFingerprint(USER_ID)).not.toContain(hashToken(USER_ID));
  });
});

describe("receiptFingerprint — no fallback to another secret", () => {
  it("fails explicitly when RECEIPT_HMAC_KEY is missing, rather than falling back", () => {
    // JWT_SECRET and ENCRYPTION_KEY are both present and usable, so a fallback would be
    // easy to implement — and would silently reintroduce the rotation defect.
    fakeEnv.RECEIPT_HMAC_KEY = undefined;

    const outcome = (() => {
      try {
        return receiptFingerprint(USER_ID);
      } catch (error) {
        return error;
      }
    })();

    expect(outcome).toBeInstanceOf(AppError);
    expect((outcome as AppError).message).toContain("RECEIPT_HMAC_KEY");
    // The JWT_SECRET digest must not be what comes back.
    expect(outcome).not.toBe(hashToken(USER_ID));
  });

  it("treats an empty key as missing", () => {
    fakeEnv.RECEIPT_HMAC_KEY = "";
    expect(() => receiptFingerprint(USER_ID)).toThrow(/RECEIPT_HMAC_KEY/);
  });

  it("rejects a key shorter than 32 bytes", () => {
    fakeEnv.RECEIPT_HMAC_KEY = "too-short-key";
    expect(() => receiptFingerprint(USER_ID)).toThrow(/at least 32 bytes/);
  });
});

describe("matchesReceiptFingerprint — support matching and rotation", () => {
  it("matches a receipt written under the current key", () => {
    expect(matchesReceiptFingerprint(receiptFingerprint(USER_ID), USER_ID)).toBe(true);
    expect(matchesReceiptFingerprint(receiptFingerprint(IP), IP)).toBe(true);
  });

  it("does not match a different value", () => {
    expect(matchesReceiptFingerprint(receiptFingerprint(USER_ID), "someone-else")).toBe(false);
  });

  it("still matches a receipt written under the previous key during a two-phase rotation", () => {
    // Phase 1: the key is rotated but the old one is retained.
    const writtenUnderOldKey = receiptFingerprint(USER_ID);
    fakeEnv.RECEIPT_HMAC_KEY = KEY_B;
    fakeEnv.RECEIPT_HMAC_KEY_PREVIOUS = KEY_A;

    expect(matchesReceiptFingerprint(writtenUnderOldKey, USER_ID)).toBe(true);
    // New receipts are written under the new key…
    const writtenUnderNewKey = receiptFingerprint(USER_ID);
    expect(writtenUnderNewKey).not.toBe(writtenUnderOldKey);
    expect(matchesReceiptFingerprint(writtenUnderNewKey, USER_ID)).toBe(true);
    // …and both are verifiable while the previous key is retained.
    expect(matchesReceiptFingerprint(writtenUnderOldKey, USER_ID)).toBe(true);
  });

  it("stops matching once the previous key is dropped, as documented", () => {
    const writtenUnderOldKey = receiptFingerprint(USER_ID);
    fakeEnv.RECEIPT_HMAC_KEY = KEY_B;
    fakeEnv.RECEIPT_HMAC_KEY_PREVIOUS = KEY_A;
    expect(matchesReceiptFingerprint(writtenUnderOldKey, USER_ID)).toBe(true);

    // Phase 2, after every receipt has been re-derived or accepted as unverifiable.
    fakeEnv.RECEIPT_HMAC_KEY_PREVIOUS = undefined;
    expect(matchesReceiptFingerprint(writtenUnderOldKey, USER_ID)).toBe(false);
  });

  it("ignores a previous key that happens to be configured while the current key matches", () => {
    fakeEnv.RECEIPT_HMAC_KEY_PREVIOUS = KEY_PREV;
    expect(matchesReceiptFingerprint(receiptFingerprint(USER_ID), USER_ID)).toBe(true);
  });

  it("does not treat a legacy bare-hex value as a match", () => {
    // Values written before the `v1.` prefix came from the old JWT_SECRET scheme. They are
    // verified with the documented legacy procedure, never by re-deriving a JWT_SECRET hash
    // inside this function.
    const legacy = hashToken(USER_ID);
    expect(legacy).not.toMatch(/^v1\./);
    expect(matchesReceiptFingerprint(legacy, USER_ID)).toBe(false);
  });

  it("returns false for malformed input rather than throwing", () => {
    for (const stored of ["", "v1.", "v1.nothex", "nonsense"]) {
      expect(matchesReceiptFingerprint(stored, USER_ID)).toBe(false);
    }
  });
});
