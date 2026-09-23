import { collapseWhitespace } from "../../../utils/text";
import { sentences } from "./extract.heuristic";

export interface SummarizeInput {
  subject?: string | null;
  fromEmail?: string | null;
  body?: string | null;
}

export interface HeuristicSummary {
  summary: string | null;
  keyPoints: string[];
  confidence: number;
}

const GREETING = /^(hi|hello|hey|dear)\b[^,]{0,40},?$/i;
const SIGNATURE = /\b(regards|sincerely|best regards|warm regards|thanks|yours (?:faithfully|truly)|unsubscribe|copyright)\b/i;
const BOILERPLATE =
  /\b(this (?:email|message) (?:and any|is)|confidential|privileged|do not reply|please do not print|all rights reserved|view (?:this|it) in (?:your )?browser)\b/i;

/**
 * Extractive summarizer used when no LLM is configured (and as the LLM fallback).
 * It only ever re-uses sentences from the email — it cannot hallucinate content.
 */
export function summarizeHeuristically(input: SummarizeInput): HeuristicSummary {
  const body = input.body ?? "";
  const subject = input.subject ?? "";
  const candidates = sentences(body).filter(
    (s) => !GREETING.test(s) && !SIGNATURE.test(s) && !BOILERPLATE.test(s) && s.length >= 25,
  );

  if (!candidates.length) {
    const fallback = collapseWhitespace(body).slice(0, 240);
    return {
      summary: fallback || (subject ? `Email regarding: ${subject}` : null),
      keyPoints: subject ? [subject.slice(0, 200)] : [],
      confidence: fallback ? 0.42 : 0.25,
    };
  }

  // Score sentences: earlier sentences matter more, plus a bonus for actionable or
  // status-bearing language.
  const scored = candidates.slice(0, 25).map((sentence, index) => {
    let score = 1 - index * 0.05;
    if (/\b(pleased|regret|shortlist|interview|assessment|offer|deadline|next step|action)\b/i.test(sentence)) score += 0.35;
    if (/\b(please|kindly|complete|confirm|schedule|respond)\b/i.test(sentence)) score += 0.25;
    if (/\d{1,2}\s*(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(sentence)) score += 0.15;
    if (sentence.length > 320) score -= 0.1;
    return { sentence, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3).map((s) => s.sentence);

  const summary = collapseWhitespace(top.join(" ")).slice(0, 320);
  const keyPoints = top
    .slice(0, 3)
    .map((s) => collapseWhitespace(s).slice(0, 180))
    .filter((s, i, arr) => arr.indexOf(s) === i);

  return {
    summary: summary || null,
    keyPoints,
    confidence: Math.min(0.9, 0.5 + keyPoints.length * 0.12),
  };
}
