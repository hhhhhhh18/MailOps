import { buildSummarizerUser, summarizerSystemPrompt, PROMPTS } from "./prompts";
import { summarizerOutputSchema, type SummarizerOutput } from "./schemas";
import { runAiTask, type AiRunMeta } from "./runner";

export interface SummarizeEmailInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  body?: string | null;
  receivedAt?: string | null;
}

export interface SummaryResult {
  output: SummarizerOutput;
  meta: AiRunMeta;
}

/**
 * Responsibility: SUMMARIZER.
 * Produces the dashboard-facing one-liner. Deliberately separate from the
 * classifier so summarisation quality can be tuned without touching decisions.
 */
export async function summarizeEmail(input: SummarizeEmailInput): Promise<SummaryResult> {
  const data = {
    subject: input.subject ?? "",
    fromEmail: input.fromEmail ?? "",
    fromName: input.fromName ?? "",
    body: input.body ?? "",
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  };

  const result = await runAiTask({
    task: "summarize",
    system: summarizerSystemPrompt,
    user: buildSummarizerUser(data),
    promptVersion: PROMPTS.summarizer.version,
    schema: summarizerOutputSchema,
    data,
    temperature: 0,
    maxTokens: 300,
  });

  return { output: result.data, meta: result.meta };
}
