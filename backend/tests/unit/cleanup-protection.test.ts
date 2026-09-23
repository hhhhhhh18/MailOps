import { describe, expect, it } from "vitest";
import { checkProtection } from "../../src/services/cleanup/cleanup.service";
import { isProtectedSender } from "../../src/services/ai/heuristics/signals";

/**
 * Deletion is the only irreversible action MailOps can take on a user's mailbox,
 * so protection is defended in depth: the classifier refuses to mark protected
 * mail as unwanted, the decision engine refuses to propose it, and the executor
 * re-checks immediately before touching Gmail.
 *
 * These tests cover that final guard, which is the one that actually matters.
 */

const defaultSettings = {
  protectJobEmails: true,
  protectPersonal: true,
  protectFinancial: true,
  protectGovernment: true,
  autoCleanupEnabled: false,
};

describe("checkProtection — absolute rules", () => {
  it("protects every job email, from any sender", () => {
    const result = checkProtection(
      { category: "JOB", subCategory: "REJECTION", fromEmail: "deals@shopmart.com" },
      defaultSettings,
    );

    expect(result.protected).toBe(true);
    expect(result.reason).toMatch(/never deleted automatically/i);
  });

  it("protects an email that is linked to an application", () => {
    const result = checkProtection(
      { category: "PROMOTIONAL", subCategory: null, applicationId: "app_1", fromEmail: "deals@shopmart.com" },
      defaultSettings,
    );

    expect(result.protected).toBe(true);
    expect(result.reason).toMatch(/supporting evidence/i);
  });

  it("protects mail from bank, tax and government senders", () => {
    for (const sender of ["alerts@hdfcbank.com", "noreply@incometax.gov.in", "service@paypal.com"]) {
      const result = checkProtection({ category: "PROMOTIONAL", subCategory: null, fromEmail: sender }, defaultSettings);
      expect(result.protected).toBe(true);
    }
  });

  it("protects starred and Gmail-important messages", () => {
    expect(
      checkProtection({ category: "PROMOTIONAL", subCategory: null, labels: ["INBOX", "STARRED"] }, defaultSettings).protected,
    ).toBe(true);

    expect(
      checkProtection({ category: "PROMOTIONAL", subCategory: null, labels: ["INBOX", "IMPORTANT"] }, defaultSettings).protected,
    ).toBe(true);
  });

  it("protects personal correspondence when the user keeps that rule on", () => {
    const result = checkProtection({ category: "PERSONAL", subCategory: null }, defaultSettings);
    expect(result.protected).toBe(true);
    expect(result.reason).toMatch(/personal/i);
  });

  it("protects transactional mail while financial protection is enabled", () => {
    const result = checkProtection({ category: "TRANSACTIONAL", subCategory: null }, defaultSettings);
    expect(result.protected).toBe(true);
  });
});

describe("checkProtection — permitted cleanup", () => {
  it("allows promotional mail with no protection triggers", () => {
    const result = checkProtection(
      { category: "PROMOTIONAL", subCategory: null, fromEmail: "deals@shopmart.com" },
      defaultSettings,
    );

    expect(result.protected).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("allows spam", () => {
    expect(checkProtection({ category: "SPAM", subCategory: null, fromEmail: "x@y.biz" }, defaultSettings).protected).toBe(false);
  });

  it("allows newsletters", () => {
    expect(
      checkProtection({ category: "NEWSLETTER", subCategory: null, fromEmail: "digest@techweekly.com" }, defaultSettings)
        .protected,
    ).toBe(false);
  });

  it("still protects personal mail when the user turns the rule off only for finance", () => {
    const settings = { ...defaultSettings, protectFinancial: false };
    expect(checkProtection({ category: "TRANSACTIONAL", subCategory: null }, settings).protected).toBe(true);
  });
});

describe("isProtectedSender", () => {
  it("recognises financial and government domains", () => {
    expect(isProtectedSender("alerts@hdfcbank.com")).toBe(true);
    expect(isProtectedSender("noreply@uidai.gov.in")).toBe(true);
    expect(isProtectedSender("billing@stripe.com")).toBe(true);
  });

  it("does not flag an ordinary marketing sender", () => {
    expect(isProtectedSender("deals@shopmart.com")).toBe(false);
    expect(isProtectedSender("news@dailystack.dev")).toBe(false);
  });

  it("handles missing addresses", () => {
    expect(isProtectedSender(null)).toBe(false);
    expect(isProtectedSender(undefined)).toBe(false);
  });
});

describe("cleanup safety invariants", () => {
  it("never permits deletion of an interview invitation", () => {
    const result = checkProtection(
      { category: "JOB", subCategory: "INTERVIEW", fromEmail: "no-reply@hire.lever.co" },
      { ...defaultSettings, autoCleanupEnabled: true },
    );

    expect(result.protected).toBe(true);
  });

  it("never permits deletion of an offer letter", () => {
    const result = checkProtection({ category: "JOB", subCategory: "OFFER" }, { ...defaultSettings, autoCleanupEnabled: true });
    expect(result.protected).toBe(true);
  });

  it("protects an unknown email with no category signal when it carries an application link", () => {
    const result = checkProtection({ category: "OTHER", subCategory: null, applicationId: "app_9" }, defaultSettings);
    expect(result.protected).toBe(true);
  });
});
