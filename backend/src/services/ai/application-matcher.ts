import { buildApplicationMatcherUser, applicationMatcherSystemPrompt, PROMPTS } from "./prompts";
import { applicationMatcherOutputSchema } from "./schemas";
import { runAiTask, type AiRunMeta } from "./runner";
import { MATCH_REVIEW_THRESHOLD, MATCH_THRESHOLD, type ApplicationIdentity } from "../../utils/similarity";
import type { CandidateApplication } from "./heuristics/match.heuristic";

export interface MatchEmailInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  body?: string | null;
  receivedAt?: string | null;
  /**
   * Identity of the incoming email (company / role / job id / application URL).
   * Required for the deterministic fallback engine to score candidates — without
   * it every candidate scores 0 and the matcher can never auto-link.
   */
  incoming?: Partial<ApplicationIdentity> | null;
  candidates: CandidateApplication[];
}

export type MatchDecision = "AUTO_LINK" | "REVIEW" | "NEW_APPLICATION";

export interface ApplicationMatchResult {
  /** Index into the supplied candidate array, or null. */
  matchedIndex: number | null;
  matchedApplicationId: string | null;
  decision: MatchDecision;
  confidence: number;
  rationale: string | null;
  meta: AiRunMeta;
}

/**
 * Responsibility: APPLICATION MATCHER.
 *
 * Decides whether an incoming recruitment email belongs to an existing
 * application. This is what prevents a new Application row being created for
 * every email from the same employer (product rule: the same company can send
 * many emails about one application).
 */
export async function matchEmailToApplication(input: MatchEmailInput): Promise<ApplicationMatchResult> {
  const candidates = input.candidates ?? [];

  if (!candidates.length) {
    return {
      matchedIndex: null,
      matchedApplicationId: null,
      decision: "NEW_APPLICATION",
      confidence: 0,
      rationale: "No existing applications to compare against",
      meta: {
        provider: "none",
        model: "none",
        promptVersion: PROMPTS.applicationMatcher.version,
        latencyMs: 0,
        warnings: [],
        fallbackUsed: false,
        validationAttempts: 0,
      },
    };
  }

  const data = {
    subject: input.subject ?? "",
    fromEmail: input.fromEmail ?? "",
    fromName: input.fromName ?? "",
    body: input.body ?? "",
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  };

  /** The deterministic engine consumes `incoming` directly from the payload. */
  const incoming: ApplicationIdentity = {
    company: input.incoming?.company ?? "",
    role: input.incoming?.role ?? "",
    jobId: input.incoming?.jobId ?? null,
    applicationUrl: input.incoming?.applicationUrl ?? null,
  };

  const serializedCandidates = candidates.map((c) => ({
    id: c.id,
    company: c.company,
    role: c.role,
    jobId: c.jobId ?? null,
    status: c.status ?? null,
    appliedDate: c.appliedDate ?? null,
    lastUpdated: c.lastUpdated ?? null,
    applicationUrl: c.applicationUrl ?? null,
  }));

  const result = await runAiTask({
    task: "match",
    system: applicationMatcherSystemPrompt,
    user: buildApplicationMatcherUser(data, serializedCandidates),
    promptVersion: PROMPTS.applicationMatcher.version,
    schema: applicationMatcherOutputSchema,
    data: { ...data, incoming, candidates: serializedCandidates },
    context: { candidates: serializedCandidates },
    temperature: 0,
    maxTokens: 300,
  });

  const output = result.data;
  const index =
    output.matchedApplicationIndex !== null &&
    output.matchedApplicationIndex >= 0 &&
    output.matchedApplicationIndex < candidates.length
      ? output.matchedApplicationIndex
      : null;

  if (index === null) {
    return {
      matchedIndex: null,
      matchedApplicationId: null,
      decision: "NEW_APPLICATION",
      confidence: output.confidence,
      rationale: output.rationale ?? "No existing application matched this email",
      meta: result.meta,
    };
  }

  // The AI's confidence is informative but the deterministic thresholds are
  // authoritative: an uncertain match always routes to human review.
  const decision: MatchDecision = output.confidence >= MATCH_THRESHOLD ? "AUTO_LINK" : "REVIEW";
  if (decision === "REVIEW") {
    result.meta.warnings.push(
      `Match confidence ${(output.confidence * 100).toFixed(0)}% is between ${MATCH_REVIEW_THRESHOLD} and ${MATCH_THRESHOLD}; the link needs user confirmation.`,
    );
  }

  return {
    matchedIndex: index,
    matchedApplicationId: candidates[index].id ?? null,
    decision,
    confidence: output.confidence,
    rationale: output.rationale,
    meta: result.meta,
  };
}
