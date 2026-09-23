import type { z } from "zod";
import { logger } from "../../config/logger";
import { describeError, IntegrationError, ERROR_CODES } from "../../utils/errors";
import { extractJson, getAiProvider, type AiContextHint, type AiProvider, type AiTask } from "./provider";
import { validateAiOutput } from "./schemas";

export interface AiRunMeta {
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  warnings: string[];
  /** True when the deterministic engine produced the result without an LLM. */
  fallbackUsed: boolean;
  validationAttempts: number;
}

export interface AiRunResult<T> {
  data: T;
  meta: AiRunMeta;
}

export interface RunAiTaskOptions<T extends z.ZodTypeAny> {
  task: AiTask;
  system: string;
  user: string;
  promptVersion: string;
  schema: T;
  data: Record<string, unknown>;
  context?: AiContextHint;
  temperature?: number;
  maxTokens?: number;
  /**
   * Post-schema business rules. Returning warnings never rejects the result;
   * throwing rejects the attempt so the runner can retry.
   */
  refine?: (value: z.infer<T>) => { value: z.infer<T>; warnings: string[] } | Promise<{ value: z.infer<T>; warnings: string[] }>;
}

/**
 * Executes one AI responsibility with the full reliability chain:
 *
 *   AI -> structural validation -> business-rule validation -> confidence gate
 *
 * A malformed response is retried once with an explicit repair instruction. If
 * the LLM remains unusable the deterministic engine answers instead, so a
 * provider outage degrades quality rather than stalling the pipeline.
 */
export async function runAiTask<T extends z.ZodTypeAny>(options: RunAiTaskOptions<T>): Promise<AiRunResult<z.infer<T>>> {
  const primary = getAiProvider();
  const warnings: string[] = [];
  let validationAttempts = 0;
  let lastErrors: string[] = [];

  const attemptWith = async (provider: AiProvider, extraInstruction?: string) => {
    const startedAt = Date.now();
    const response = await provider.completeJson({
      task: options.task,
      system: options.system,
      user: extraInstruction ? `${options.user}\n\n${extraInstruction}` : options.user,
      promptVersion: options.promptVersion,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      context: options.context,
      data: options.data,
    });

    validationAttempts += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.raw);
    } catch {
      lastErrors = ["response was not valid JSON"];
      throw new IntegrationError("AI response was not valid JSON", ERROR_CODES.AI_INVALID_OUTPUT, { retryable: true });
    }

    const validation = validateAiOutput(options.schema, parsed);
    if (!validation.valid || !validation.data) {
      lastErrors = validation.errors;
      throw new IntegrationError("AI response failed schema validation", ERROR_CODES.AI_INVALID_OUTPUT, {
        retryable: true,
        details: validation.errors,
      });
    }

    let value = validation.data as z.infer<T>;
    if (options.refine) {
      const refined = await options.refine(value);
      value = refined.value;
      warnings.push(...refined.warnings);
    }

    return {
      data: value,
      meta: {
        provider: response.provider,
        model: response.model,
        promptVersion: options.promptVersion,
        latencyMs: response.latencyMs ?? Date.now() - startedAt,
        usage: response.usage,
        warnings,
        fallbackUsed: provider.name === "heuristic",
        validationAttempts,
      } satisfies AiRunMeta,
    };
  };

  try {
    return await attemptWith(primary);
  } catch (error) {
    const isValidation = error instanceof IntegrationError && error.code === ERROR_CODES.AI_INVALID_OUTPUT;
    logger.debug(
      { task: options.task, errors: lastErrors, ...describeError(error) },
      "ai attempt failed; retrying",
    );

    if (isValidation) {
      try {
        return await attemptWith(
          primary,
          `Your previous response was rejected: ${lastErrors.slice(0, 5).join("; ")}. Respond again with ONLY a valid JSON object matching the required shape.`,
        );
      } catch (secondError) {
        logger.warn({ task: options.task, ...describeError(secondError) }, "ai repair attempt failed; using deterministic engine");
      }
    }

    if (primary.name === "heuristic") {
      throw error;
    }

    // Degradation path.
    warnings.push("The AI provider was unavailable; a deterministic analysis was used instead.");
    const { HeuristicProvider } = await import("./providers/heuristic.provider");
    return await attemptWith(new HeuristicProvider());
  }
}

export { extractJson };
