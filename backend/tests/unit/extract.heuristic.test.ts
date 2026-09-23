import { describe, expect, it } from "vitest";
import { extractHeuristically } from "../../src/services/ai/heuristics/extract.heuristic";
import { applyExtractionGuards, extractorOutputSchema, validateAiOutput } from "../../src/services/ai/schemas";

/**
 * Extraction must be grounded. The single most important property these tests
 * enforce: when the email does not say something, the field is null — MailOps
 * never invents a company, a role or a deadline.
 */

describe("extractHeuristically — grounded extraction", () => {
  it("extracts company, role and job id from a shortlist email", () => {
    const result = extractHeuristically({
      subject: "Congratulations! You've been shortlisted",
      fromEmail: "careers@microsoft.com",
      body:
        "Congratulations! Your profile has been shortlisted for the Software Engineer position at Microsoft. Job ID: MS-98231. Location: Hyderabad. This is a full-time role.",
      receivedAt: "2026-09-16T09:00:00.000Z",
    });

    expect(result.company).toBe("Microsoft");
    expect(result.role).toBe("Software Engineer");
    expect(result.jobId?.toUpperCase()).toContain("MS-98231");
    expect(result.location).toContain("Hyderabad");
    expect(result.employmentType).toBe("Full-time");
  });

  it("returns null for fields the email does not state", () => {
    const result = extractHeuristically({
      subject: "Update on your application",
      fromEmail: "talent@deloitte.com",
      body: "We regret to inform you that we will not be moving forward with your application.",
      receivedAt: "2026-09-10T09:00:00.000Z",
    });

    // A rejection email rarely names the role — the engine must not guess one.
    expect(result.role).toBeNull();
    expect(result.interviewDate).toBeNull();
    expect(result.assessmentDeadline).toBeNull();
    expect(result.salary).toBeNull();
    expect(result.applicationStatus).toBe("REJECTED");
    expect(result.evidence).toContain("regret to inform");
  });

  it("derives a company from the sender domain for an ATS sender", () => {
    const result = extractHeuristically({
      subject: "Interview invitation",
      fromEmail: "no-reply@greenhouse.io",
      body: "We would like to schedule a technical interview for the Backend Engineer role.",
      receivedAt: "2026-09-16T09:00:00.000Z",
    });

    expect(result.role).toBe("Backend Engineer");
    // Greenhouse is the platform, not the employer; if no employer is named the
    // company stays null rather than being set to the platform name.
    expect(result.company).not.toBe("Greenhouse");
  });

  it("prefers a company the user already has applications with", () => {
    const result = extractHeuristically({
      subject: "Interview invitation",
      fromEmail: "no-reply@workday.com",
      body: "We would like to invite you for an interview for the Software Engineer role.",
      receivedAt: "2026-09-16T09:00:00.000Z",
      companyHints: ["Oracle", "Microsoft"],
    });

    expect(result.company).toBeNull();
  });

  it("parses an explicit deadline into an ISO date", () => {
    const result = extractHeuristically({
      subject: "Online assessment",
      fromEmail: "assessments@hackerrank.com",
      body:
        "Please complete the online assessment for the Cloud Engineer position. The assessment must be completed before September 25, 2026.",
      receivedAt: "2026-09-16T09:00:00.000Z",
    });

    expect(result.assessmentDeadline).toBeTruthy();
    expect(new Date(result.assessmentDeadline as string).toISOString().slice(0, 10)).toBe("2026-09-25");
  });

  it("resolves a relative deadline against the received date", () => {
    const result = extractHeuristically({
      subject: "Complete your assessment",
      fromEmail: "assessments@hackerrank.com",
      body: "Please complete the online test for the DevOps Engineer role within 5 days.",
      receivedAt: "2026-09-16T09:00:00.000Z",
    });

    const deadline = new Date(result.assessmentDeadline as string);
    expect(deadline.getTime()).toBeGreaterThan(new Date("2026-09-16T00:00:00.000Z").getTime());
    expect(deadline.getTime()).toBeLessThan(new Date("2026-09-25T00:00:00.000Z").getTime());
  });

  it("extracts recruiter contact details and salary when explicitly present", () => {
    const result = extractHeuristically({
      subject: "Offer discussion",
      fromEmail: "priya.nair@amazon.com",
      body:
        "Hi, this is Priya Nair from Amazon regarding the Cloud Engineer position. The CTC for this role is ₹32,00,000 per annum.\nRegards,\nPriya Nair\nTalent Acquisition",
      receivedAt: "2026-09-20T09:00:00.000Z",
    });

    expect(result.salary).toMatch(/32,00,000|LPA|per annum/i);
    expect(result.recruiterName).toBeTruthy();
    expect(result.recruiterEmail).toBe("priya.nair@amazon.com");
  });

  it("never infers a deadline from an email that has none", () => {
    const result = extractHeuristically({
      subject: "Thanks for applying",
      fromEmail: "no-reply@infosys.com",
      body: "Thank you for applying. We have received your application and will review it.",
      receivedAt: "2026-09-16T09:00:00.000Z",
    });

    expect(result.assessmentDeadline).toBeNull();
    expect(result.responseDeadline).toBeNull();
    expect(result.interviewDate).toBeNull();
    expect(result.importantDates).toEqual([]);
  });
});

describe("extraction guards", () => {
  it("clears an implausible deadline and downgrades confidence", () => {
    const parsed = extractorOutputSchema.parse({
      company: "Microsoft",
      role: "Software Engineer",
      assessmentDeadline: "2099-01-01",
      confidence: 0.95,
      evidence: "Complete the assessment before January 1, 2099.",
    });

    const { output, warnings } = applyExtractionGuards(parsed);
    expect(output.assessmentDeadline).toBeNull();
    expect(warnings.join(" ")).toMatch(/implausible/i);
  });

  it("refuses to assert REJECTED without supporting evidence", () => {
    const parsed = extractorOutputSchema.parse({
      company: "Acme",
      role: "Analyst",
      applicationStatus: "REJECTED",
      evidence: null,
      confidence: 0.9,
    });

    const { output, warnings } = applyExtractionGuards(parsed);
    expect(output.applicationStatus).toBeNull();
    expect(warnings.join(" ")).toMatch(/without evidence/i);
  });

  it("drops a malformed recruiter email", () => {
    const parsed = extractorOutputSchema.parse({
      company: "Acme",
      role: "Analyst",
      recruiterEmail: "not-an-email",
      confidence: 0.9,
    });

    const { output } = applyExtractionGuards(parsed);
    expect(output.recruiterEmail).toBeNull();
  });

  it("reduces confidence when a deadline has no evidence", () => {
    const parsed = extractorOutputSchema.parse({
      company: "Acme",
      role: "Analyst",
      assessmentDeadline: "2026-10-01",
      evidence: null,
      confidence: 0.95,
    });

    const { output } = applyExtractionGuards(parsed);
    expect(output.confidence).toBeLessThanOrEqual(0.55);
  });
});

describe("extractor output contract", () => {
  it("schema accepts a fully-null extraction (nothing invented)", () => {
    const validation = validateAiOutput(extractorOutputSchema, {
      company: null,
      role: null,
      confidence: 0.3,
    });

    expect(validation.valid).toBe(true);
    expect(validation.data?.company).toBeNull();
  });

  it("schema rejects a non-ISO deadline", () => {
    const validation = validateAiOutput(extractorOutputSchema, {
      company: "Acme",
      role: "Analyst",
      assessmentDeadline: "next Friday afternoon",
      confidence: 0.8,
    });

    expect(validation.valid).toBe(true); // coerced to null rather than failing
    expect(validation.data?.assessmentDeadline).toBeNull();
  });
});
