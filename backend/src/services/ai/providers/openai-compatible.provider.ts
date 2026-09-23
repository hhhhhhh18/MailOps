import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { describeError, IntegrationError, ERROR_CODES } from "../../../utils/errors";
import { extractJson, type AiCompletionRequest, type AiCompletionResponse, type AiProvider } from "../provider";

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Works with OpenAI, Azure OpenAI-compatible gateways, Groq, Together, vLLM and
 * local Ollama (`AI_BASE_URL=http://localhost:11434/v1`). Because the heuristic
 * provider remains available, an outage here degrades quality but never breaks
 * the pipeline — see pipeline.ts, which falls back on retry exhaustion.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = "openai-compatible";
  readonly available: boolean;

  constructor(
    private readonly config = {
      baseUrl: env.AI_BASE_URL.replace(/\/$/, ""),
      apiKey: env.AI_API_KEY ?? "",
      model: env.AI_MODEL,
      timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    },
  ) {
    this.available = Boolean(this.config.apiKey);
  }

  async completeJson(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    if (!this.available) {
      throw new IntegrationError("AI provider is not configured (missing AI_API_KEY)", ERROR_CODES.AI_PROVIDER_UNAVAILABLE, {
        degraded: true,
      });
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens ?? 900,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new IntegrationError("AI provider rate limit exceeded", ERROR_CODES.AI_PROVIDER_UNAVAILABLE, {
          retryable: true,
        });
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new IntegrationError(
          `AI provider returned ${response.status}`,
          ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
          { retryable: response.status >= 500, details: { status: response.status, body: text.slice(0, 200) } },
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        model?: string;
      };

      const content = payload.choices?.[0]?.message?.content ?? "";
      const raw = extractJson(content);

      return {
        raw,
        model: payload.model ?? this.config.model,
        provider: this.name,
        latencyMs: Date.now() - startedAt,
        usage: payload.usage
          ? {
              promptTokens: payload.usage.prompt_tokens,
              completionTokens: payload.usage.completion_tokens,
              totalTokens: payload.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      logger.warn({ ...describeError(error), task: request.task }, "ai provider call failed");
      throw new IntegrationError(
        error instanceof Error && error.name === "AbortError"
          ? "AI provider request timed out"
          : "AI provider is unavailable",
        ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
