import type { AiCompletionRequest, AiCompletionResponse, AiProvider } from "../provider";
import { classifyHeuristically, type ClassifyInput } from "../heuristics/classify.heuristic";
import { extractHeuristically, type ExtractInput } from "../heuristics/extract.heuristic";
import { summarizeHeuristically, type SummarizeInput } from "../heuristics/summarize.heuristic";
import { detectDuplicateHeuristically } from "../heuristics/duplicate.heuristic";
import { matchApplicationHeuristically, type MatchInput } from "../heuristics/match.heuristic";
import { buildVoiceScriptHeuristically, type VoiceInput } from "../heuristics/voice.heuristic";

/**
 * Deterministic, rule-based provider.
 *
 * This is not a stub: it is the default engine, and it is what keeps MailOps
 * fully functional (and fully testable) with no third-party AI dependency, no
 * API key and no per-message cost. When AI_PROVIDER=openai-compatible is set the
 * LLM takes precedence, with this engine used as the degradation path.
 *
 * Every output is derived only from text present in the email — the same
 * "never invent information" constraint that governs the LLM prompts.
 */
export class HeuristicProvider implements AiProvider {
  readonly name = "heuristic";
  readonly available = true;

  async completeJson(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const startedAt = Date.now();
    const data = (request.data ?? {}) as Record<string, never>;

    const result = (() => {
      switch (request.task) {
        case "classify":
          return classifyHeuristically(data as unknown as ClassifyInput);
        case "extract":
          return extractHeuristically(data as unknown as ExtractInput);
        case "summarize":
          return summarizeHeuristically(data as unknown as SummarizeInput);
        case "duplicate":
          return detectDuplicateHeuristically(data as unknown as MatchInput);
        case "match":
          return matchApplicationHeuristically(data as unknown as MatchInput);
        case "voice":
          return buildVoiceScriptHeuristically(data as unknown as VoiceInput);
        default:
          return { error: "unsupported task" };
      }
    })();

    return {
      raw: JSON.stringify(result),
      model: `heuristic:${request.promptVersion}`,
      provider: this.name,
      latencyMs: Date.now() - startedAt,
    };
  }
}
