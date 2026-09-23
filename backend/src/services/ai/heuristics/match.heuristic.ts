import {
  MATCH_REVIEW_THRESHOLD,
  MATCH_THRESHOLD,
  matchApplicationIdentity,
  type ApplicationIdentity,
} from "../../../utils/similarity";

export interface CandidateApplication extends ApplicationIdentity {
  id?: string;
  company: string;
  role: string;
  status?: string | null;
  appliedDate?: string | null;
  lastUpdated?: string | null;
}

export interface MatchInput {
  /**
   * Identity of the incoming email. Optional so that a provider payload which
   * omits it (or an LLM path that renders it into the prompt instead) cannot
   * crash the engine — an unknown identity simply scores 0.
   */
  incoming?: Partial<ApplicationIdentity> & { emailSubject?: string | null } | null;
  candidates: CandidateApplication[];
}

export interface HeuristicMatch {
  matchedApplicationIndex: number | null;
  confidence: number;
  rationale: string | null;
  /** Extra diagnostic data — used by the review UI, ignored by the schema. */
  ranked: Array<{ index: number; id?: string; company: string; role: string; score: number; reasons: string[] }>;
  decision: "AUTO_LINK" | "REVIEW" | "NEW_APPLICATION";
}

/**
 * Deterministic matcher: exact job-id or application-URL equality wins outright,
 * otherwise a blended company/role similarity score decides. Thresholds:
 *   >= MATCH_THRESHOLD        auto-link the email to the application
 *   >= REVIEW_THRESHOLD       ask the user instead of guessing
 *   below                     treat as a new application
 */
export function matchApplicationHeuristically(input: MatchInput): HeuristicMatch {
  const candidates = input.candidates ?? [];

  // Defensive normalisation: every field is coerced, so a partial or missing
  // `incoming` yields a zero score rather than a TypeError.
  const incoming: ApplicationIdentity = {
    company: input.incoming?.company ?? "",
    role: input.incoming?.role ?? "",
    jobId: input.incoming?.jobId ?? null,
    applicationUrl: input.incoming?.applicationUrl ?? null,
  };

  if (!candidates.length) {
    return {
      matchedApplicationIndex: null,
      confidence: 0,
      rationale: "No existing applications to match against",
      ranked: [],
      decision: "NEW_APPLICATION",
    };
  }

  const ranked = candidates.map((candidate, index) => {
    const match = matchApplicationIdentity(incoming, candidate);
    return {
      index,
      id: candidate.id,
      company: candidate.company,
      role: candidate.role,
      score: Number(match.score.toFixed(4)),
      reasons: match.reasons,
      exact: match.exact,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];

  if (!best || best.score < MATCH_REVIEW_THRESHOLD) {
    return {
      matchedApplicationIndex: null,
      confidence: Number((best?.score ?? 0).toFixed(3)),
      rationale: "No existing application matched closely enough to link this email",
      ranked,
      decision: "NEW_APPLICATION",
    };
  }

  const decision: HeuristicMatch["decision"] = best.score >= MATCH_THRESHOLD ? "AUTO_LINK" : "REVIEW";

  return {
    matchedApplicationIndex: best.index,
    confidence: Number(best.score.toFixed(3)),
    rationale: best.reasons.length
      ? `Matched on ${best.reasons.join(", ")}`
      : "Company and role are similar to an existing application",
    ranked,
    decision: best.exact ? "AUTO_LINK" : decision,
  };
}
