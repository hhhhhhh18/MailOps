import { describe, expect, it } from "vitest";
import { classifyHeuristically } from "../../src/services/ai/heuristics/classify.heuristic";
import { classifierOutputSchema, validateAiOutput } from "../../src/services/ai/schemas";

/**
 * Email classification is the highest-leverage decision in MailOps: everything
 * downstream (applications, notifications, calls) depends on it being right.
 * These cases mirror the real inbox shapes described in the product spec.
 */

function classify(input: Parameters<typeof classifyHeuristically>[0]) {
  return classifyHeuristically(input);
}

describe("classifyHeuristically — categories", () => {
  it("classifies an ATS shortlist email as JOB / SHORTLISTED with high confidence", () => {
    const result = classify({
      subject: "Congratulations! You've been shortlisted",
      fromEmail: "careers@microsoft.com",
      fromName: "Microsoft Careers",
      body:
        "Congratulations! We are pleased to inform you that your profile has been shortlisted for the Software Engineer position at Microsoft. Our recruiter will contact you shortly.",
      receivedAt: "2026-09-16T09:00:00.000Z",
    });

    expect(result.category).toBe("JOB");
    expect(result.subCategory).toBe("SHORTLISTED");
    expect(result.priority).toBe("HIGH");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.reasoning).toMatch(/shortlist/i);
  });

  it("classifies an interview invitation with a deadline as CRITICAL and actionable", () => {
    const result = classify({
      subject: "Interview invitation — Software Engineer",
      fromEmail: "no-reply@hire.lever.co",
      body:
        "We would like to invite you to a technical interview. Please book a slot before September 25, 2026. This is a Google Meet video call.",
    });

    expect(result.category).toBe("JOB");
    expect(result.subCategory).toBe("INTERVIEW");
    expect(result.priority).toBe("CRITICAL");
    expect(result.requiresAction).toBe(true);
  });

  it("classifies an assessment request as ASSESSMENT", () => {
    const result = classify({
      subject: "Your online assessment for the Backend Engineer role",
      fromEmail: "assessments@hackerrank.com",
      body: "Please complete the coding challenge for the Backend Engineer position. The assessment must be completed within 5 days.",
    });

    expect(result.category).toBe("JOB");
    expect(result.subCategory).toBe("ASSESSMENT");
    expect(result.requiresAction).toBe(true);
  });

  it("classifies a rejection email as JOB / REJECTION", () => {
    const result = classify({
      subject: "Update on your application",
      fromEmail: "talent@deloitte.com",
      body:
        "We regret to inform you that we will not be moving forward with your application. We wish you the best in your search.",
    });

    expect(result.category).toBe("JOB");
    expect(result.subCategory).toBe("REJECTION");
    expect(result.requiresAction).toBe(false);
  });

  it("classifies an offer letter as JOB / OFFER at CRITICAL priority", () => {
    const result = classify({
      subject: "Your offer letter from Amazon",
      fromEmail: "talent@amazon.com",
      body:
        "We are pleased to offer you the Cloud Engineer position. Please review the offer of employment and respond within 7 days.",
    });

    expect(result.category).toBe("JOB");
    expect(result.subCategory).toBe("OFFER");
    expect(result.priority).toBe("CRITICAL");
  });

  it("does not treat a promotional offer as a job offer", () => {
    const result = classify({
      subject: "Limited time offer — flat 50% off everything",
      fromEmail: "deals@shopmart.com",
      body:
        "Mega sale! Save up to 60% on all items. Shop now and use coupon code SAVE60. Free shipping on orders above ₹999. Unsubscribe from this list.",
    });

    expect(result.category).toBe("PROMOTIONAL");
    expect(result.subCategory).toBeNull();
    expect(result.isUnwanted).toBe(true);
    expect(result.requiresAction).toBe(false);
  });

  it("classifies a job alert digest as JOB / JOB_ALERT without action", () => {
    const result = classify({
      subject: "New jobs matching your search — weekly digest",
      fromEmail: "alerts@naukri.com",
      body: "Here are new jobs matching your profile. Apply now to roles you may like.",
    });

    expect(result.category).toBe("JOB");
    expect(result.subCategory).toBe("JOB_ALERT");
    expect(result.requiresAction).toBe(false);
    expect(result.priority).toBe("LOW");
  });

  it("classifies a newsletter as NEWSLETTER", () => {
    const result = classify({
      subject: "Weekly digest — issue #212",
      fromEmail: "digest@techweekly.com",
      body: "This week in software: top stories. You are receiving this because you subscribed. Unsubscribe.",
    });

    expect(result.category).toBe("NEWSLETTER");
    expect(result.isUnwanted).toBe(true);
  });

  it("classifies an automated social notification as SOCIAL", () => {
    const result = classify({
      subject: "You have 12 new connection requests",
      fromEmail: "notifications@linkedin.com",
      body: "Someone viewed your profile and mentioned you in a post.",
    });

    expect(result.category).toBe("SOCIAL");
  });

  it("classifies a spam prize claim as SPAM", () => {
    const result = classify({
      subject: "YOU HAVE WON $500,000!!!",
      fromEmail: "winner@lucky-draw.biz",
      body: "You have won the lottery. Claim your prize now. Wire transfer details required. Click here to claim!!!",
    });

    expect(result.category).toBe("SPAM");
    expect(result.isUnwanted).toBe(true);
  });

  it("classifies a bank transaction alert as TRANSACTIONAL and never cleanup-worthy", () => {
    const result = classify({
      subject: "Transaction alert: ₹2,499 debited",
      fromEmail: "alerts@hdfcbank.com",
      body: "A transaction of ₹2,499 has been debited from your account. This is an automated account statement.",
    });

    expect(["TRANSACTIONAL", "OTHER", "PERSONAL"]).toContain(result.category);
    expect(result.isUnwanted).toBe(false);
  });

  it("classifies a short message from an individual as PERSONAL", () => {
    const result = classify({
      subject: "Re: Weekend plans?",
      fromEmail: "arjun.menon@gmail.com",
      body: "Sure, let's meet around 6. I'll book a table.",
    });

    expect(result.category).toBe("PERSONAL");
    expect(result.isUnwanted).toBe(false);
  });
});

describe("classifyHeuristically — confidence and review gating", () => {
  it("flags a low-signal job-ish email for review instead of guessing", () => {
    const result = classify({
      subject: "Quick question",
      fromEmail: "someone@unknown-company.io",
      body: "Hi, are you open to new opportunities? Let me know.",
    });

    // Either it lands in JOB with low confidence, or it stays OTHER — but it must
    // never present itself as a confident classification.
    expect(result.confidence).toBeLessThan(0.75);
    if (result.category === "JOB") {
      expect(result.needsReview).toBe(true);
    }
  });

  it("prefers recruitment evidence over a marketing footer in the same email", () => {
    const result = classify({
      subject: "Thank you for applying to Google",
      fromEmail: "no-reply@google.com",
      body:
        "Thank you for applying. We have received your application for the Software Engineer role. Unsubscribe from this list at any time. This is a promotional footer.",
    });

    expect(result.category).toBe("JOB");
  });
});

describe("classifier output contract", () => {
  it("produces JSON that satisfies the classifier schema", () => {
    const raw = classifyHeuristically({
      subject: "Online assessment for your Data Analyst application",
      fromEmail: "assessments@hackerrank.com",
      body: "Please complete the online test for the Data Analyst role. The deadline is September 25, 2026.",
    });

    const validation = validateAiOutput(classifierOutputSchema, {
      category: raw.category,
      subCategory: raw.subCategory,
      priority: raw.priority,
      confidence: raw.confidence,
      requiresAction: raw.requiresAction,
      needsReview: raw.needsReview,
      reasoning: raw.reasoning,
      isUnwanted: raw.isUnwanted,
      unwantedReason: raw.unwantedReason,
    });

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("rejects an invented category from an AI provider", () => {
    const validation = validateAiOutput(classifierOutputSchema, {
      category: "RECRUITMENT_OPPORTUNITY",
      priority: "HIGH",
      confidence: 0.9,
      requiresAction: true,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/category/i);
  });

  it("clamps an out-of-range confidence into [0,1] rather than rejecting the response", () => {
    // Models sometimes emit a percentage (96) or an out-of-scale value (4.2).
    // Both are recoverable, and discarding an otherwise valid classification over
    // a numeric scale difference would waste a retry and lose the analysis.
    const asPercent = validateAiOutput(classifierOutputSchema, {
      category: "JOB",
      priority: "HIGH",
      confidence: 96,
      requiresAction: false,
    });
    expect(asPercent.valid).toBe(true);
    expect(asPercent.data?.confidence).toBeCloseTo(0.96, 2);

    const outOfScale = validateAiOutput(classifierOutputSchema, {
      category: "JOB",
      priority: "HIGH",
      confidence: 4.2,
      requiresAction: false,
    });
    expect(outOfScale.valid).toBe(true);
    expect(outOfScale.data?.confidence).toBeGreaterThanOrEqual(0);
    expect(outOfScale.data?.confidence).toBeLessThanOrEqual(1);
  });

  it("defaults a missing confidence to 0 instead of failing validation", () => {
    const validation = validateAiOutput(classifierOutputSchema, {
      category: "JOB",
      priority: "HIGH",
      requiresAction: false,
    });

    expect(validation.valid).toBe(true);
    expect(validation.data?.confidence).toBe(0);
  });
});
