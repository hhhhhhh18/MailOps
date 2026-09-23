import { describe, expect, it } from "vitest";
import {
  DUPLICATE_THRESHOLD,
  MATCH_THRESHOLD,
  blendedSimilarity,
  matchApplicationIdentity,
  normalizeUrl,
  tokenSetRatio,
  trigramSimilarity,
} from "../../src/utils/similarity";
import { matchApplicationHeuristically } from "../../src/services/ai/heuristics/match.heuristic";
import { detectDuplicateHeuristically } from "../../src/services/ai/heuristics/duplicate.heuristic";
import { normalizeCompany, normalizeJobId, normalizeRole } from "../../src/utils/text";
import type { CandidateApplication } from "../../src/services/ai/heuristics/match.heuristic";

/**
 * Application matching is what stops MailOps creating a new Application row for
 * every email an employer sends. Getting it wrong is the most visible failure
 * mode in the product, so the boundaries are tested explicitly.
 */

function candidate(overrides: Partial<CandidateApplication> = {}): CandidateApplication {
  return {
    id: "app_1",
    company: "Microsoft",
    role: "Software Engineer",
    jobId: "MS-98231",
    status: "SHORTLISTED",
    appliedDate: "2026-09-08T00:00:00.000Z",
    lastUpdated: "2026-09-16T00:00:00.000Z",
    applicationUrl: "https://careers.microsoft.com/apply/MS-98231",
    companyKey: normalizeCompany("Microsoft"),
    roleKey: normalizeRole("Software Engineer"),
    ...overrides,
  };
}

describe("normalisation", () => {
  it("strips corporate suffixes from company names", () => {
    expect(normalizeCompany("Microsoft Corporation")).toBe("microsoft");
    expect(normalizeCompany("Acme Technologies Pvt Ltd")).toBe("acme");
    expect(normalizeCompany("Deloitte Consulting India")).toBe("deloitte");
  });

  it("strips seniority and employment noise from role titles", () => {
    expect(normalizeRole("Senior Software Engineer")).toBe("software engineer");
    expect(normalizeRole("Sr. Backend Engineer (Remote)")).toBe("backend engineer");
    expect(normalizeRole("Full-time Data Analyst")).toBe("data analyst");
  });

  it("normalises job ids to a comparable key", () => {
    expect(normalizeJobId("MS-98231")).toBe(normalizeJobId("ms_98231"));
  });

  it("ignores tracking parameters in URLs", () => {
    expect(normalizeUrl("https://Careers.Microsoft.com/apply/MS-98231?utm_source=email&ref=abc")).toBe(
      normalizeUrl("https://careers.microsoft.com/apply/MS-98231"),
    );
  });
});

describe("similarity primitives", () => {
  it("treats identical strings as fully similar", () => {
    expect(trigramSimilarity("software engineer", "software engineer")).toBeCloseTo(1, 5);
    expect(tokenSetRatio("software engineer", "engineer software")).toBeCloseTo(1, 5);
    expect(blendedSimilarity("data analyst", "data analyst")).toBeCloseTo(1, 5);
  });

  it("separates unrelated roles", () => {
    expect(blendedSimilarity("software engineer", "financial accountant")).toBeLessThan(0.5);
  });

  it("ranks related engineering titles well above unrelated ones", () => {
    const related = blendedSimilarity("backend engineer", "back end engineering");
    const unrelated = blendedSimilarity("backend engineer", "financial accountant");

    // Inflected wording scores lower than an exact match but must still be far
    // closer than an unrelated role. On its own that is below MATCH_THRESHOLD —
    // which is correct: role wording alone is never treated as proof.
    expect(related).toBeGreaterThan(unrelated * 1.5);
    expect(related).toBeLessThan(1);
  });

  it("crosses the match threshold when the company also matches", () => {
    // The matcher weights company 0.65 / role 0.35, so a strong company match
    // plus imperfect role wording is still a confident auto-link.
    const match = matchApplicationIdentity(
      { company: "Microsoft", role: "Backend Engineer" },
      {
        company: "Microsoft Corporation",
        role: "Back End Engineering",
        jobId: null,
        applicationUrl: null,
      },
    );

    expect(match.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

describe("matchApplicationIdentity", () => {
  it("treats an identical job ID as a definitive match", () => {
    const match = matchApplicationIdentity(
      { company: "Microsoft", role: "Software Engineer", jobId: "MS-98231" },
      candidate(),
    );

    expect(match.exact).toBe(true);
    expect(match.score).toBe(1);
    expect(match.reasons).toContain("identical job ID");
  });

  it("treats an identical application URL as definitive", () => {
    const match = matchApplicationIdentity(
      {
        company: "Microsoft",
        role: "Engineer",
        applicationUrl: "https://careers.microsoft.com/apply/MS-98231",
      },
      candidate(),
    );

    expect(match.exact).toBe(true);
    expect(match.urlMatch).toBe(true);
  });

  it("scores company + role similarity for fuzzy matches", () => {
    const match = matchApplicationIdentity(
      { company: "Microsoft Corporation", role: "Software Engineer II" },
      candidate({ jobId: null, applicationUrl: null }),
    );

    expect(match.exact).toBe(false);
    expect(match.score).toBeGreaterThan(MATCH_THRESHOLD);
    expect(match.reasons).toContain("company name matches");
  });

  it("does not match a different company with the same role", () => {
    const match = matchApplicationIdentity(
      { company: "Amazon", role: "Software Engineer" },
      candidate({ jobId: null, applicationUrl: null }),
    );

    expect(match.score).toBeLessThan(MATCH_THRESHOLD);
  });
});

describe("matchApplicationHeuristically — decisions", () => {
  it("auto-links when the job ID matches", () => {
    const result = matchApplicationHeuristically({
      incoming: { company: "Microsoft", role: "Software Engineer", jobId: "MS-98231" },
      candidates: [candidate()],
    });

    expect(result.decision).toBe("AUTO_LINK");
    expect(result.matchedApplicationIndex).toBe(0);
    expect(result.confidence).toBe(1);
  });

  it("creates a new application when nothing is close", () => {
    const result = matchApplicationHeuristically({
      incoming: { company: "Netflix", role: "Content Analyst" },
      candidates: [candidate()],
    });

    expect(result.decision).toBe("NEW_APPLICATION");
    expect(result.matchedApplicationIndex).toBeNull();
  });

  it("returns NEW_APPLICATION when the user has no applications yet", () => {
    const result = matchApplicationHeuristically({
      incoming: { company: "Microsoft", role: "Software Engineer" },
      candidates: [],
    });

    expect(result.decision).toBe("NEW_APPLICATION");
    expect(result.ranked).toEqual([]);
  });

  it("picks the best of several candidates for a repeated employer", () => {
    const result = matchApplicationHeuristically({
      incoming: { company: "Microsoft", role: "Data Analyst", jobId: "MS-98104" },
      candidates: [
        candidate({ id: "app_swe", role: "Software Engineer", jobId: "MS-98231" }),
        candidate({ id: "app_da", role: "Data Analyst", jobId: "MS-98104", status: "ACKNOWLEDGED" }),
      ],
    });

    expect(result.matchedApplicationIndex).toBe(1);
    expect(result.ranked[0].id).toBe("app_da");
  });
});

describe("detectDuplicateHeuristically", () => {
  it("flags a re-application to a previously rejected role", () => {
    const result = detectDuplicateHeuristically({
      incoming: { company: "Microsoft", role: "Software Engineer", jobId: "MS-98231" },
      candidates: [
        candidate({
          status: "REJECTED",
          appliedDate: "2026-03-14T00:00:00.000Z",
          lastUpdated: "2026-04-01T00:00:00.000Z",
        }),
      ],
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.matchedApplicationIndex).toBe(0);
    expect(result.rationale).toMatch(/previously applied/i);
    expect(result.previous?.status).toBe("REJECTED");
  });

  it("does not flag a same-cycle update as a duplicate", () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const result = detectDuplicateHeuristically({
      incoming: { company: "Microsoft", role: "Software Engineer", jobId: "MS-98231" },
      candidates: [candidate({ status: "SHORTLISTED", appliedDate: recent, lastUpdated: recent })],
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.rationale).toMatch(/recently|already exists/i);
  });

  it("does not flag unrelated roles", () => {
    const result = detectDuplicateHeuristically({
      incoming: { company: "Deloitte", role: "Financial Accountant" },
      candidates: [candidate({ status: "REJECTED", appliedDate: "2026-01-01T00:00:00.000Z" })],
    });

    expect(result.isDuplicate).toBe(false);
  });

  it("uses a stable threshold constant", () => {
    expect(DUPLICATE_THRESHOLD).toBeGreaterThan(MATCH_THRESHOLD);
  });
});
