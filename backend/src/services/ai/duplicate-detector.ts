import { buildDuplicateDetectorUser, duplicateDetectorSystemPrompt, PROMPTS } from "./prompts";
import { duplicateDetectorOutputSchema } from "./schemas";
import { runAiTask, type AiRunMeta } from "./runner";
import { DUPLICATE_THRESHOLD, type ApplicationIdentity } from "../../utils/similarity";
import type { CandidateApplication } from "./heuristics/match.heuristic";

export interface DuplicateDetectionInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  body?: string | null;
  receivedAt?: string | null;
  /** Identity of the incoming email, used by the deterministic fallback engine. */
  incoming?: Partial<ApplicationIdentity> | null;
  candidates: CandidateApplication[];
}

export interface DuplicateDetectionResult {
  isDuplicate: boolean;
  confidence: number;
  matchedApplicationId: string | null;
  previous: CandidateApplication | null;
  rationale: string | null;
  meta: AiRunMeta;
}

/**
 * Responsibility: DUPLICATE DETECTOR.
 *
 * Advisory only. Even at high confidence MailOps never blocks the user from
 * applying — it surfaces the earlier application and lets the user continue.
 */
export async function detectDuplicateApplication(input: DuplicateDetectionInput): Promise<DuplicateDetectionResult> {
  const candidates = input.candidates ?? [];

  if (!candidates.length) {
    return {
      isDuplicate: false,
      confidence: 0,
      matchedApplicationId: null,
      previous: null,
      rationale: null,
      meta: {
        provider: "none",
        model: "none",
        promptVersion: PROMPTS.duplicateDetector.version,
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
    task: "duplicate",
    system: duplicateDetectorSystemPrompt,
    user: buildDuplicateDetectorUser(data, serializedCandidates),
    promptVersion: PROMPTS.duplicateDetector.version,
    schema: duplicateDetectorOutputSchema,
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

  const isDuplicate = output.isDuplicate && output.confidence >= DUPLICATE_THRESHOLD && index !== null;

  return {
    isDuplicate,
    confidence: output.confidence,
    matchedApplicationId: isDuplicate && index !== null ? (candidates[index].id ?? null) : null,
    previous: isDuplicate && index !== null ? candidates[index] : null,
    rationale: output.rationale,
    meta: result.meta,
  };
}
