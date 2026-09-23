import { daysBetween } from "../../../utils/dates";
import { DUPLICATE_THRESHOLD } from "../../../utils/similarity";
import { matchApplicationHeuristically, type CandidateApplication, type MatchInput } from "./match.heuristic";

export interface DuplicateInput extends MatchInput {
  candidates: CandidateApplication[];
}

export interface HeuristicDuplicateResult {
  isDuplicate: boolean;
  confidence: number;
  matchedApplicationIndex: number | null;
  rationale: string | null;
  previous?: {
    id?: string;
    company: string;
    role: string;
    status?: string | null;
    appliedDate?: string | null;
    daysAgo: number | null;
  };
}

/**
 * Duplicate-application detection.
 *
 * A match is escalated to "possible duplicate" when the similarity is high AND
 * the previous application is meaningfully older than the new one — re-applying
 * to the same company months after a rejection is the canonical case MailOps
 * must surface. Detection is advisory only: the user always decides
 * (product rule: do not prevent the user from applying).
 */
export function detectDuplicateHeuristically(input: DuplicateInput): HeuristicDuplicateResult {
  const match = matchApplicationHeuristically(input);
  const best = match.ranked[0];

  if (!best || best.score < DUPLICATE_THRESHOLD) {
    return {
      isDuplicate: false,
      confidence: Number((best?.score ?? 0).toFixed(3)),
      matchedApplicationIndex: null,
      rationale: null,
    };
  }

  const candidate = input.candidates[best.index];
  const previousApplied = candidate?.appliedDate ? new Date(candidate.appliedDate) : null;
  const daysAgo = previousApplied ? Math.abs(daysBetween(previousApplied, new Date())) : null;

  const wasRejectedOrWithdrawn = ["REJECTED", "WITHDRAWN"].includes((candidate?.status ?? "").toUpperCase());
  // A very recent application to the same role is usually just the same event
  // being re-processed, not a genuine duplicate — do not nag the user about it.
  const meaningfullyOlder = daysAgo === null || daysAgo >= 14;

  if (!meaningfullyOlder) {
    return {
      isDuplicate: false,
      confidence: Number(best.score.toFixed(3)),
      matchedApplicationIndex: null,
      rationale: "A near-identical application already exists and was created recently",
    };
  }

  return {
    isDuplicate: true,
    confidence: Number(best.score.toFixed(3)),
    matchedApplicationIndex: best.index,
    rationale: wasRejectedOrWithdrawn
      ? `You previously applied to ${candidate.company} for ${candidate.role}, which was ${(candidate.status ?? "").toLowerCase()}${
          daysAgo !== null ? ` about ${daysAgo} days ago` : ""
        }`
      : `A very similar application to ${candidate.company} for ${candidate.role} already exists${
          daysAgo !== null ? ` (${daysAgo} days ago)` : ""
        }`,
    previous: {
      id: candidate?.id,
      company: candidate?.company ?? "",
      role: candidate?.role ?? "",
      status: candidate?.status ?? null,
      appliedDate: candidate?.appliedDate ?? null,
      daysAgo,
    },
  };
}
