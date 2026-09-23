import { aiProviderConfigured, env } from "../../config/env";
import { logger } from "../../config/logger";
import { IntegrationError, ERROR_CODES } from "../../utils/errors";
import { HeuristicProvider } from "./providers/heuristic.provider";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";

/**
 * AI provider contract.
 *
 * Responsibilities are deliberately separated (product rule #37). Each task has
 * its own prompt, its own schema and its own version string so that a change to
 * one never silently invalidates the others.
 */
export type AiTask = "classify" | "extract" | "summarize" | "duplicate" | "match" | "voice";

export interface AiContextHint {
  /** Known company names for this user, used to ground extraction. */
  companyHints?: string[];
  /** Compact candidate list for matcher/duplicate tasks. */
  candidates?: Array<Record<string, unknown>>;
}

export interface AiCompletionRequest {
  task: AiTask;
  system: string;
  user: string;
  promptVersion: string;
  temperature?: number;
  maxTokens?: number;
  context?: AiContextHint;
  /**
   * Structured task input. The LLM path renders this into `user`; the heuristic
   * path reads it directly. Both engines therefore consume exactly the same
   * facts, which keeps the deterministic fallback faithful to the LLM contract.
   */
  data?: Record<string, unknown>;
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiCompletionResponse {
  /** Raw JSON text as returned by the provider (already unfenced). */
  raw: string;
  model: string;
  provider: string;
  latencyMs: number;
  usage?: AiUsage;
}

export interface AiProvider {
  readonly name: string;
  readonly available: boolean;
  completeJson(request: AiCompletionRequest): Promise<AiCompletionResponse>;
}

let cached: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (cached) return cached;
  if (env.AI_PROVIDER === "openai-compatible" && aiProviderConfigured) {
    cached = new OpenAiCompatibleProvider();
  } else {
    if (env.AI_PROVIDER === "openai-compatible" && !aiProviderConfigured) {
      logger.warn(
        { configured: env.AI_PROVIDER },
        "AI_PROVIDER=openai-compatible but AI_API_KEY is missing; falling back to the deterministic heuristic provider",
      );
    }
    cached = new HeuristicProvider();
  }
  logger.info({ provider: cached.name, available: cached.available }, "ai provider selected");
  return cached;
}

/** Test seam. */
export function setAiProvider(provider: AiProvider | null): void {
  cached = provider;
}

/**
 * Strips markdown fences and recovers the first balanced JSON object from a
 * model response. Models occasionally wrap JSON in prose; we recover rather than
 * fail, but a response with no JSON at all raises AI_INVALID_OUTPUT.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new IntegrationError("AI response did not contain a JSON object", ERROR_CODES.AI_INVALID_OUTPUT, {
      retryable: true,
    });
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  throw new IntegrationError("AI response contained truncated JSON", ERROR_CODES.AI_INVALID_OUTPUT, {
    retryable: true,
  });
}
