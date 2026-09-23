import { env } from "../../config/env";
import { buildExtractorUser, extractorSystemPrompt, PROMPTS } from "./prompts";
import { applyExtractionGuards, extractorOutputSchema, type ExtractorOutput } from "./schemas";
import { runAiTask, type AiRunMeta } from "./runner";

export interface ExtractEmailInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  body?: string | null;
  receivedAt?: string | null;
  companyHints?: string[];
}

export interface ExtractionResult {
  output: ExtractorOutput;
  needsReview: boolean;
  meta: AiRunMeta;
}

/**
 * Responsibility: EXTRACTOR.
 * Produces grounded, structured application facts. Fields that cannot be
 * verified are null. Business-rule guards run after schema validation to strip
 * implausible dates and unproven statuses.
 */
export async function extractEmail(input: ExtractEmailInput): Promise<ExtractionResult> {
  const data = {
    subject: input.subject ?? "",
    fromEmail: input.fromEmail ?? "",
    fromName: input.fromName ?? "",
    body: input.body ?? "",
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  };

  const result = await runAiTask({
    task: "extract",
    system: extractorSystemPrompt,
    user: buildExtractorUser(data, input.companyHints ?? []),
    promptVersion: PROMPTS.extractor.version,
    schema: extractorOutputSchema,
    data,
    context: { companyHints: input.companyHints ?? [] },
    temperature: 0,
    maxTokens: 800,
    refine: (value) => {
      const { output, warnings } = applyExtractionGuards(value);
      return { value: output, warnings };
    },
  });

  const output = result.data;
  const needsReview =
    output.needsReview ||
    output.confidence < env.AI_MIN_CONFIDENCE ||
    output.confidence < env.AI_REVIEW_THRESHOLD;

  return { output, needsReview, meta: result.meta };
}
