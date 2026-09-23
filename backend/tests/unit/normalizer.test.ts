import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import { minimizeMessage, normalizeGmailMessage, parseAddress } from "../../src/services/gmail/normalizer";
import { buildScanQuery } from "../../src/services/gmail/client";
import { auditGrantedScopes, GMAIL_SCOPES } from "../../src/services/gmail/scopes";
import { encryptSecret, decryptSecret, encryptJson, decryptJson, hashToken, safeEqual } from "../../src/utils/crypto";
import { redactSecrets, maskEmail, sanitizeForAudit } from "../../src/utils/redact";

/**
 * Gmail normalisation and credential handling. Both are security-sensitive: the
 * normaliser decides what content MailOps is allowed to keep, and the crypto
 * helpers protect the refresh token that grants mailbox access.
 */

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function message(overrides: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message {
  return {
    id: "18f2a1b2c3d4e5f6",
    threadId: "thread_1",
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    snippet: "Congratulations! You have been shortlisted for the Software Engineer position.",
    internalDate: String(new Date("2026-09-16T09:30:00.000Z").getTime()),
    sizeEstimate: 48_213,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Microsoft Careers <careers@microsoft.com>" },
        { name: "To", value: "candidate@example.com" },
        { name: "Subject", value: "Congratulations! You've been shortlisted" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: encode("Congratulations! Your profile has been shortlisted for the Software Engineer position at Microsoft.") } },
        { mimeType: "text/html", body: { data: encode("<p>Congratulations!</p><p>Your profile has been shortlisted.</p>") } },
      ],
    },
    ...overrides,
  };
}

describe("parseAddress", () => {
  it("parses a display name with an address", () => {
    expect(parseAddress("Microsoft Careers <careers@microsoft.com>")).toEqual({
      name: "Microsoft Careers",
      email: "careers@microsoft.com",
    });
  });

  it("parses a quoted display name", () => {
    expect(parseAddress('"Nair, Priya" <priya.nair@amazon.com>')).toEqual({
      name: "Nair, Priya",
      email: "priya.nair@amazon.com",
    });
  });

  it("parses a bare address", () => {
    expect(parseAddress("talent@deloitte.com")).toEqual({ name: null, email: "talent@deloitte.com" });
  });

  it("handles missing input", () => {
    expect(parseAddress(null)).toEqual({ name: null, email: null });
  });
});

describe("normalizeGmailMessage", () => {
  it("extracts headers, labels and a plain-text body", () => {
    const normalized = normalizeGmailMessage(message());

    expect(normalized).not.toBeNull();
    expect(normalized!.gmailMessageId).toBe("18f2a1b2c3d4e5f6");
    expect(normalized!.fromEmail).toBe("careers@microsoft.com");
    expect(normalized!.fromName).toBe("Microsoft Careers");
    expect(normalized!.subject).toBe("Congratulations! You've been shortlisted");
    expect(normalized!.labels).toContain("INBOX");
    expect(normalized!.isImportant).toBe(true);
    expect(normalized!.isUnread).toBe(true);
    expect(normalized!.bodyText).toContain("shortlisted");
    expect(normalized!.receivedAt.toISOString()).toBe("2026-09-16T09:30:00.000Z");
  });

  it("falls back to stripped HTML when there is no text/plain part", () => {
    const htmlOnly = message({
      payload: {
        mimeType: "text/html",
        headers: [{ name: "Subject", value: "Interview" }],
        body: { data: encode("<div><h1>Interview invitation</h1><p>Please confirm.</p></div>") },
      },
    });

    const normalized = normalizeGmailMessage(htmlOnly);
    expect(normalized!.bodyText).toContain("Interview invitation");
    expect(normalized!.bodyText).toContain("Please confirm.");
    expect(normalized!.bodyText).not.toContain("<");
  });

  it("detects attachments", () => {
    const withAttachment = message({
      payload: {
        mimeType: "multipart/mixed",
        headers: [],
        parts: [
          { mimeType: "text/plain", body: { data: encode("Please find the offer letter attached.") } },
          { mimeType: "application/pdf", filename: "offer.pdf", body: { size: 120_000 } },
        ],
      },
    });

    expect(normalizeGmailMessage(withAttachment)!.hasAttachments).toBe(true);
  });

  it("builds a thread key from the subject", () => {
    const normalized = normalizeGmailMessage(message({ payload: { ...message().payload, headers: [{ name: "Subject", value: "Re: Fwd: Interview — Microsoft" }] } }));
    expect(normalized!.threadKey).toContain("interview");
  });

  it("returns null when the message has no id", () => {
    expect(normalizeGmailMessage({ id: undefined })).toBeNull();
  });

  it("tolerates a missing internalDate", () => {
    const normalized = normalizeGmailMessage(message({ internalDate: undefined }));
    expect(normalized!.receivedAt).toBeInstanceOf(Date);
  });
});

describe("minimizeMessage — data minimisation", () => {
  it("drops the body when the user has body storage disabled", () => {
    const normalized = normalizeGmailMessage(message())!;
    const minimized = minimizeMessage(normalized, false);

    expect(minimized.bodyText).toBeNull();
    expect(minimized.snippet).toBe(normalized.snippet);
    expect(minimized.subject).toBe(normalized.subject);
  });

  it("keeps the body when body storage is enabled", () => {
    const normalized = normalizeGmailMessage(message())!;
    expect(minimizeMessage(normalized, true).bodyText).not.toBeNull();
  });
});

describe("buildScanQuery", () => {
  it("excludes sent, drafts, chats and MailOps-ignored mail", () => {
    const query = buildScanQuery({ lookbackDays: 120 });
    expect(query).toContain("newer_than:120d");
    expect(query).toContain("-in:sent");
    expect(query).toContain("-in:draft");
    expect(query).toContain("-in:chat");
    expect(query).toContain("-label:mailops-ignored");
  });

  it("does not exclude promotions, because cleanup depends on seeing them", () => {
    const query = buildScanQuery({});
    expect(query).not.toContain("-category:promotions");
  });
});

describe("Gmail scopes", () => {
  it("requests read + modify + email, and never full mailbox access", () => {
    expect(GMAIL_SCOPES).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(GMAIL_SCOPES).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(GMAIL_SCOPES).not.toContain("https://mail.google.com/");
    expect(GMAIL_SCOPES).not.toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("detects a missing scope in a partial grant", () => {
    const audit = auditGrantedScopes(["https://www.googleapis.com/auth/userinfo.email", "openid"]);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("accepts a complete grant", () => {
    expect(auditGrantedScopes([...GMAIL_SCOPES]).ok).toBe(true);
  });
});

describe("credential encryption", () => {
  it("round-trips a secret", () => {
    const ciphertext = encryptSecret("ya29.super-secret-refresh-token");
    expect(ciphertext).not.toContain("super-secret");
    expect(ciphertext.startsWith("v1.")).toBe(true);
    expect(decryptSecret(ciphertext)).toBe("ya29.super-secret-refresh-token");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext", () => {
    const ciphertext = encryptSecret("original");
    const parts = ciphertext.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("round-trips JSON", () => {
    const payload = { webhookUrl: "https://hooks.slack.com/services/xyz", channel: "#jobs" };
    expect(decryptJson(encryptJson(payload))).toEqual(payload);
  });

  it("returns null for empty input", () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptJson(undefined)).toBeNull();
  });

  it("hashes tokens deterministically and irreversibly", () => {
    const hash = hashToken("refresh-token-value");
    expect(hash).toBe(hashToken("refresh-token-value"));
    expect(hash).not.toContain("refresh-token-value");
    expect(hash).toHaveLength(64);
  });

  it("compares strings safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("redaction", () => {
  it("strips bearer tokens and API keys from free text", () => {
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")).toContain("[REDACTED]");
    expect(redactSecrets("access_token=ya29.a0AfH6SMabcdefghij")).toContain("[REDACTED]");
    expect(redactSecrets("api_key: sk-live-abcdef123456")).not.toContain("sk-live-abcdef123456");
  });

  it("masks the local part of an email address but keeps the domain", () => {
    expect(maskEmail("jane.doe@corp.com")).toBe("j***e@corp.com");
  });

  it("handles short local parts without leaking them", () => {
    expect(maskEmail("ab@corp.com")).toBe("a@corp.com");
    expect(maskEmail("a@corp.com")).toBe("a@corp.com");
  });

  it("handles missing and malformed addresses", () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("not-an-address")).toBe("[redacted]");
  });

  it("drops body fields from audit metadata", () => {
    const sanitized = sanitizeForAudit({
      company: "Microsoft",
      bodyText: "Full private email body content",
      refreshToken: "1//0abcdef",
      nested: { accessToken: "ya29.xyz", note: "ok" },
    }) as Record<string, unknown>;

    expect(sanitized.company).toBe("Microsoft");
    expect(sanitized.bodyText).toBe("[REDACTED]");
    expect(sanitized.refreshToken).toBe("[REDACTED]");
    expect((sanitized.nested as Record<string, unknown>).accessToken).toBe("[REDACTED]");
    expect((sanitized.nested as Record<string, unknown>).note).toBe("ok");
  });

  it("truncates very long values instead of storing them", () => {
    const sanitized = sanitizeForAudit({ note: "x".repeat(1000) }) as Record<string, string>;
    expect(sanitized.note.length).toBeLessThanOrEqual(301);
  });
});
