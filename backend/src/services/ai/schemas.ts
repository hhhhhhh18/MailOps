import { z } from "zod";

/**
 * Structured output contracts for each AI responsibility.
 *
 * Product rule #2/#3/#4: never invent information, never fabricate deadlines,
 * never claim a status without evidence. These schemas make that enforceable:
 *  - every optional field is nullable and defaults to null
 *  - the model must supply an `evidence` snippet for status-bearing claims
 *  - unknown enum values are rejected rather than coerced
 */

export const EMAIL_CATEGORIES = [
  "JOB",
  "PROMOTIONAL",
  "SPAM",
  "NEWSLETTER",
  "SOCIAL",
  "PERSONAL",
  "TRANSACTIONAL",
  "OTHER",
] as const;

export const JOB_SUBCATEGORIES = [
  "APPLICATION_RECEIVED",
  "APPLICATION_ACKNOWLEDGED",
  "SHORTLISTED",
  "ASSESSMENT",
  "INTERVIEW",
  "NEXT_ROUND",
  "FINAL_ROUND",
  "RECRUITER_CONTACT",
  "OFFER",
  "OFFER_ACCEPTED",
  "REJECTION",
  "WITHDRAWN",
  "JOB_ALERT",
  "OTHER_JOB",
] as const;

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const APPLICATION_STATUSES = [
  "APPLIED",
  "ACKNOWLEDGED",
  "SHORTLISTED",
  "ASSESSMENT",
  "INTERVIEW",
  "FINAL_ROUND",
  "OFFER",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
  "ON_HOLD",
  "NO_RESPONSE",
] as const;

/**
 * A trimmed, validated string.
 *
 * Omission and explicit null are treated identically. That matters: an LLM that
 * simply leaves a key out is expressing the same thing as one that writes null,
 * and rejecting the whole response for a missing optional key would waste a
 * retry and then fall back to the deterministic engine unnecessarily.
 */
const nullableString = (max = 400) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return null;
      const trimmed = v.replace(/\s+/g, " ").trim();
      return trimmed.length === 0 ? null : trimmed.slice(0, max);
    });

/** Accepts 0-1 or 0-100 and clamps; a missing confidence degrades to 0. */
const confidence = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "number" ? v : Number.parseFloat(v);
    if (Number.isNaN(n)) return 0;
    return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
  })
  .pipe(z.number().min(0).max(1));

/** Accepts only ISO-ish dates; anything else (including prose) collapses to null. */
const isoDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (!v) return null;
    const trimmed = v.trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(trimmed)) return null;
    const d = new Date(trimmed.length === 10 ? `${trimmed}T23:59:59.000Z` : trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  });

/** ------------------------------------------------------------------------ */
/** Classifier                                                                 */
/** ------------------------------------------------------------------------ */

export const classifierOutputSchema = z.object({
  category: z.enum(EMAIL_CATEGORIES),
  subCategory: z.enum(JOB_SUBCATEGORIES).nullable().default(null),
  priority: z.enum(PRIORITIES),
  confidence,
  requiresAction: z.boolean(),
  needsReview: z.boolean().optional().default(false),
  /** Short user-facing explanation. Never chain-of-thought. */
  reasoning: nullableString(320),
  isUnwanted: z.boolean().optional().default(false),
  unwantedReason: nullableString(200),
});
export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

/** ------------------------------------------------------------------------ */
/** Extractor                                                                  */
/** ------------------------------------------------------------------------ */

export const extractedFieldsSchema = z.object({
  company: nullableString(160),
  role: nullableString(160),
  jobId: nullableString(64),
  applicationId: nullableString(64),
  location: nullableString(120),
  employmentType: nullableString(60),
  appliedDate: isoDate,
  emailDate: isoDate,
  applicationStatus: z.enum(APPLICATION_STATUSES).nullable().default(null),
  interviewDate: isoDate,
  assessmentDeadline: isoDate,
  responseDeadline: isoDate,
  recruiterName: nullableString(120),
  recruiterEmail: nullableString(160),
  salary: nullableString(160),
  applicationUrl: nullableString(500),
  jobUrl: nullableString(500),
  requiredAction: nullableString(240),
  importantDates: z
    .array(
      z.object({
        label: nullableString(120),
        date: isoDate,
      }),
    )
    .max(10)
    .optional()
    .default([]),
  /** Verbatim snippet from the email supporting the extracted status or deadline. */
  evidence: nullableString(400),
  confidence,
});

export const extractorOutputSchema = extractedFieldsSchema.extend({
  needsReview: z.boolean().optional().default(false),
  missingCriticalFields: z.array(z.string()).max(10).optional().default([]),
});
export type ExtractorOutput = z.infer<typeof extractorOutputSchema>;
export type ExtractedFields = z.infer<typeof extractedFieldsSchema>;

/** ------------------------------------------------------------------------ */
/** Summarizer                                                                 */
/** ------------------------------------------------------------------------ */

export const summarizerOutputSchema = z.object({
  summary: nullableString(320),
  keyPoints: z.array(z.string().max(200)).max(6).optional().default([]),
  confidence,
});
export type SummarizerOutput = z.infer<typeof summarizerOutputSchema>;

/** ------------------------------------------------------------------------ */
/** Duplicate detector                                                         */
/** ------------------------------------------------------------------------ */

export const duplicateDetectorOutputSchema = z.object({
  isDuplicate: z.boolean(),
  confidence,
  matchedApplicationIndex: z.number().int().min(-1).max(50).nullable().default(null),
  rationale: nullableString(300),
});
export type DuplicateDetectorOutput = z.infer<typeof duplicateDetectorOutputSchema>;

/** ------------------------------------------------------------------------ */
/** Application matcher                                                        */
/** ------------------------------------------------------------------------ */

export const applicationMatcherOutputSchema = z.object({
  matchedApplicationIndex: z.number().int().min(-1).max(100).nullable().default(null),
  confidence,
  rationale: nullableString(300),
});
export type ApplicationMatcherOutput = z.infer<typeof applicationMatcherOutputSchema>;

/** ------------------------------------------------------------------------ */
/** Voice script                                                               */
/** ------------------------------------------------------------------------ */

export const voiceScriptOutputSchema = z.object({
  script: z.string().max(1200),
  confidence,
});
export type VoiceScriptOutput = z.infer<typeof voiceScriptOutputSchema>;

/** ------------------------------------------------------------------------ */
/** Validation helpers                                                         */
/** ------------------------------------------------------------------------ */

export interface AiValidationResult<T> {
  valid: boolean;
  data: T | null;
  errors: string[];
}

export function validateAiOutput<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
): AiValidationResult<z.infer<T>> {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { valid: true, data: result.data, errors: [] };
  }
  return {
    valid: false,
    data: null,
    errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

/**
 * Business-rule validation applied *after* schema validation.
 * AI output is never trusted to perform a destructive or state-changing action
 * without passing this layer (product rule: AI -> Validation -> Confidence ->
 * Decision engine -> User approval -> Action).
 */
export function applyExtractionGuards(input: ExtractorOutput): {
  output: ExtractorOutput;
  warnings: string[];
} {
  const warnings: string[] = [];
  const now = Date.now();
  const maxFutureMs = 400 * 86_400_000; // ~13 months
  const maxPastMs = 3 * 365 * 86_400_000;

  for (const field of ["interviewDate", "assessmentDeadline", "responseDeadline"] as const) {
    const value = input[field];
    if (!value) continue;
    const ts = new Date(value).getTime();
    if (Number.isNaN(ts)) {
      (input as Record<string, unknown>)[field] = null;
      warnings.push(`${field} was not a valid date and has been cleared`);
      continue;
    }
    if (ts - now > maxFutureMs || now - ts > maxPastMs) {
      (input as Record<string, unknown>)[field] = null;
      warnings.push(`${field} was implausible and has been cleared`);
    }
  }

  // A dates-bearing claim without evidence is downgraded rather than dropped.
  if (!input.evidence && (input.interviewDate || input.assessmentDeadline || input.responseDeadline)) {
    warnings.push("deadline present without supporting evidence; confidence reduced");
    input.confidence = Math.min(input.confidence, 0.55);
  }

  if (input.recruiterEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.recruiterEmail)) {
    input.recruiterEmail = null;
    warnings.push("recruiterEmail failed format validation and has been cleared");
  }

  if (input.applicationStatus === "REJECTED" && !input.evidence) {
    // Never assert a rejection without quoted evidence.
    input.applicationStatus = null;
    warnings.push("rejection status claimed without evidence; not applied");
  }

  return { output: input, warnings };
}
