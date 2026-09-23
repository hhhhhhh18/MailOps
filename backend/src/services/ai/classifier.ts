import { env } from "../../config/env";
import { classifierSystemPrompt, buildClassifierUser } from "./prompts";
import { PROMPTS } from "./prompts";
import { classifierOutputSchema, type ClassifierOutput } from "./schemas";
import { runAiTask, type AiRunMeta } from "./runner";

export interface ClassifyEmailInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  body?: string | null;
  labels?: string[];
  isImportant?: boolean;
  receivedAt?: string | null;
}

export interface ClassificationResult {
  output: ClassifierOutput;
  /** Final gate: should a human confirm this before it drives state changes? */
  needsReview: boolean;
  meta: AiRunMeta;
}

/**
 * Responsibility: CLASSIFIER.
 * Decides the category, job sub-category, priority and whether the email needs
 * action or human review. It performs no database writes and no side effects.
 */
export async function classifyEmail(input: ClassifyEmailInput): Promise<ClassificationResult> {
  const data = {
    subject: input.subject ?? "",
    fromEmail: input.fromEmail ?? "",
    fromName: input.fromName ?? "",
    body: input.body ?? "",
    labels: input.labels ?? [],
    isImportant: input.isImportant ?? false,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  };

  const result = await runAiTask({
    task: "classify",
    system: classifierSystemPrompt,
    user: buildClassifierUser(data),
    promptVersion: PROMPTS.classifier.version,
    schema: classifierOutputSchema,
    data,
    temperature: 0,
    maxTokens: 500,
  });

  const output = result.data;

  // Confidence gate. Low confidence never silently drives the application state.
  const lowConfidence = output.confidence < env.AI_MIN_CONFIDENCE;
  const belowReview = output.confidence < env.AI_REVIEW_THRESHOLD;
  const needsReview = output.needsReview || lowConfidence || belowReview;

  if (belowReview) {
    result.meta.warnings.push(
      `Confidence ${(output.confidence * 100).toFixed(0)}% is below the review threshold; this email is queued for confirmation.`,
    );
  }

  return { output, needsReview, meta: result.meta };
}
