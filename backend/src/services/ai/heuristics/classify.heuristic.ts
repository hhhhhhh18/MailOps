import { collapseWhitespace } from "../../../utils/text";
import {
  ACK_SIGNALS,
  ASSESSMENT_SIGNALS,
  INTERVIEW_SIGNALS,
  JOB_SIGNALS,
  NEWSLETTER_SIGNALS,
  OFFER_SIGNALS,
  PROMOTIONAL_SIGNALS,
  REJECTION_SIGNALS,
  SHORTLIST_SIGNALS,
  SOCIAL_SIGNALS,
  SPAM_SIGNALS,
  TRANSACTIONAL_SIGNALS,
  isAtsDomain,
  isProtectedSender,
  isSocialDomain,
  matchSignals,
  scoreSignals,
  shapeStats,
  type SignalHit,
  type WeightedSignal,
} from "./signals";

export interface ClassifyInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  body?: string | null;
  labels?: string[];
  isImportant?: boolean;
  receivedAt?: string | null;
}

export interface HeuristicClassification {
  category: string;
  subCategory: string | null;
  priority: string;
  confidence: number;
  requiresAction: boolean;
  needsReview: boolean;
  reasoning: string;
  isUnwanted: boolean;
  unwantedReason: string | null;
  /** Diagnostics retained for tests and the audit trail. */
  signals: Array<{ label: string; weight: number; group: string }>;
}

const ACTION_SUBCATEGORIES = new Set([
  "ASSESSMENT",
  "INTERVIEW",
  "NEXT_ROUND",
  "FINAL_ROUND",
  "OFFER",
  "RECRUITER_CONTACT",
]);

/** Phrases that explicitly put a clock on the user. */
const DEADLINE_PATTERN =
  /\b(?:deadline|due by|due on|before|by \w+day|no later than|within \d+ (?:hours?|days?)|expires? on|last date)\b/i;

function collect(haystack: string, groups: Array<{ name: string; signals: WeightedSignal[] }>) {
  const out: Array<{ label: string; weight: number; group: string }> = [];
  for (const group of groups) {
    for (const hit of matchSignals(haystack, group.signals, 4)) {
      out.push({ label: hit.label, weight: hit.weight, group: group.name });
    }
  }
  return out;
}

/**
 * Deterministic email classification.
 *
 * Returns the same JSON shape the LLM classifier is asked to produce, so both
 * engines are interchangeable behind the classifier service.
 */
export function classifyHeuristically(input: ClassifyInput): HeuristicClassification {
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const haystack = `${subject}\n${body}\n${input.fromName ?? ""}`.toLowerCase();
  const subjectHaystack = subject.toLowerCase();
  const stats = shapeStats({ subject, fromEmail: input.fromEmail, body });
  const ats = isAtsDomain(stats.domain);

  const jobScore = scoreSignals(haystack, JOB_SIGNALS);
  const spam = scoreSignals(haystack, SPAM_SIGNALS);
  const promo = scoreSignals(haystack, PROMOTIONAL_SIGNALS);
  const newsletter = scoreSignals(haystack, NEWSLETTER_SIGNALS);
  const social = scoreSignals(haystack, SOCIAL_SIGNALS);
  const transactional = scoreSignals(haystack, TRANSACTIONAL_SIGNALS);

  /**
   * Status lexicons are computed up front because they are themselves strong
   * evidence that a message is recruitment mail. "We regret to inform you that
   * we will not be moving forward with your application" contains no generic job
   * keyword, yet it is unmistakably a rejection — without this, the classifier
   * would file it as OTHER and lose the application history.
   */
  const rejection = scoreSignals(haystack, REJECTION_SIGNALS);
  const offer = scoreSignals(haystack, OFFER_SIGNALS);
  const assessment = scoreSignals(haystack, ASSESSMENT_SIGNALS);
  const interview = scoreSignals(haystack, INTERVIEW_SIGNALS);
  const shortlist = scoreSignals(haystack, SHORTLIST_SIGNALS);
  const ack = scoreSignals(haystack, ACK_SIGNALS);

  const bestStatusScore = Math.max(
    rejection.score,
    offer.score,
    assessment.score,
    interview.score,
    shortlist.score,
    ack.score,
  );

  // --- Category ------------------------------------------------------------
  let jobEvidence = jobScore.score + Math.min(0.5, bestStatusScore * 0.8);
  if (ats) jobEvidence += 0.4; // applicant-tracking sender domains are decisive
  if (/^\[?(external|job|careers?)\]?/i.test(subject)) jobEvidence += 0.1;
  if (input.labels?.includes("CATEGORY_PERSONAL")) jobEvidence -= 0.05;

  const spamEvidence = spam.score + (stats.allCapsSubject ? 0.15 : 0) + (stats.exclamationCount >= 3 ? 0.1 : 0);
  const socialEvidence = social.score + (isSocialDomain(stats.domain) ? 0.35 : 0);
  const newsletterEvidence = newsletter.score + (stats.hasUnsubscribe ? 0.12 : 0);
  const promoEvidence = promo.score + (stats.linkCount >= 8 ? 0.08 : 0);

  const scores: Array<{ category: string; score: number }> = [
    { category: "JOB", score: jobEvidence },
    { category: "SPAM", score: spamEvidence },
    { category: "SOCIAL", score: socialEvidence },
    { category: "NEWSLETTER", score: newsletterEvidence },
    { category: "PROMOTIONAL", score: promoEvidence },
    { category: "TRANSACTIONAL", score: transactional.score },
  ];

  // A recruitment email frequently also carries an unsubscribe footer. When job
  // evidence is strong, job wins regardless of marketing markers.
  const socialFloor = socialEvidence >= 0.5 ? 0.62 : 0.4;
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const second = scores[1];

  let category = "OTHER";
  if (best.score >= 0.32) {
    category = best.category;
  } else if (stats.isFreeMail && stats.bodyLength < 2500 && stats.linkCount <= 2 && !stats.hasUnsubscribe) {
    category = "PERSONAL";
  }

  // Guard rails: a domain-based social notification should not be outranked by a
  // single coincidental job keyword, and vice versa for ATS senders.
  if (socialEvidence >= 0.5 && jobEvidence < 0.5) category = "SOCIAL";
  if (ats && jobEvidence >= 0.4) category = "JOB";

  // --- Job sub-category ----------------------------------------------------
  let subCategory: string | null = null;
  let subCategoryScore = 0;
  const subSignals: Array<{ label: string; weight: number; group: string }> = [];

  if (category === "JOB") {
    const offerAccepted = /\b(accepted your offer|offer acceptance|you have accepted)\b/i.test(haystack);
    const nextRound = /\b(next round|round 2|2nd round|second round)\b/i.test(haystack);
    const finalRound = /\b(final round|final interview|last round)\b/i.test(haystack);
    const jobAlert =
      /\b(job alert|jobs matching your|recommended jobs|new jobs you may|weekly job digest|job recommendations)\b/i.test(
        haystack,
      );
    const recruiterTone =
      /\b(recruiter|talent acquisition|sourcing specialist|hiring team|i came across your (profile|resume))\b/i.test(
        haystack,
      ) && !ack.hits.length;

    // Ordered decision: the most advanced / most consequential state wins.
    if (rejection.score >= 0.4) {
      subCategory = "REJECTION";
      subCategoryScore = rejection.score;
      subSignals.push(...rejection.hits.map((h) => ({ ...h, group: "rejection" })));
    } else if (offerAccepted) {
      subCategory = "OFFER_ACCEPTED";
      subCategoryScore = 0.8;
    } else if (offer.score >= 0.4) {
      subCategory = "OFFER";
      subCategoryScore = offer.score;
      subSignals.push(...offer.hits.map((h) => ({ ...h, group: "offer" })));
    } else if (finalRound) {
      subCategory = "FINAL_ROUND";
      subCategoryScore = 0.62;
    } else if (interview.score >= 0.35) {
      subCategory = "INTERVIEW";
      subCategoryScore = interview.score;
      subSignals.push(...interview.hits.map((h) => ({ ...h, group: "interview" })));
    } else if (assessment.score >= 0.35) {
      subCategory = "ASSESSMENT";
      subCategoryScore = assessment.score;
      subSignals.push(...assessment.hits.map((h) => ({ ...h, group: "assessment" })));
    } else if (shortlist.score >= 0.35) {
      subCategory = "SHORTLISTED";
      subCategoryScore = shortlist.score;
      subSignals.push(...shortlist.hits.map((h) => ({ ...h, group: "shortlist" })));
    } else if (nextRound) {
      subCategory = "NEXT_ROUND";
      subCategoryScore = 0.58;
    } else if (recruiterTone) {
      subCategory = "RECRUITER_CONTACT";
      subCategoryScore = 0.5;
    } else if (ack.score >= 0.3) {
      subCategory = "APPLICATION_ACKNOWLEDGED";
      subCategoryScore = ack.score;
      subSignals.push(...ack.hits.map((h) => ({ ...h, group: "ack" })));
    } else if (/\b(application (has been )?(received|submitted)|we have received your application)\b/i.test(haystack)) {
      subCategory = "APPLICATION_RECEIVED";
      subCategoryScore = 0.55;
    } else if (jobAlert) {
      subCategory = "JOB_ALERT";
      subCategoryScore = 0.5;
    } else {
      subCategory = "OTHER_JOB";
      subCategoryScore = Math.max(0.36, jobEvidence * 0.6);
    }
  }

  // --- Priority ------------------------------------------------------------
  const hasDeadline = DEADLINE_PATTERN.test(haystack);
  let priority = "LOW";
  if (category === "JOB") {
    if (["OFFER", "OFFER_ACCEPTED"].includes(subCategory ?? "")) {
      priority = "CRITICAL";
    } else if (["INTERVIEW", "FINAL_ROUND", "ASSESSMENT"].includes(subCategory ?? "") && hasDeadline) {
      priority = "CRITICAL";
    } else if (["INTERVIEW", "FINAL_ROUND", "NEXT_ROUND", "ASSESSMENT", "SHORTLISTED"].includes(subCategory ?? "")) {
      priority = "HIGH";
    } else if (subCategory === "RECRUITER_CONTACT") {
      priority = "HIGH";
    } else if (subCategory === "REJECTION") {
      priority = "MEDIUM";
    } else if (["APPLICATION_ACKNOWLEDGED", "APPLICATION_RECEIVED"].includes(subCategory ?? "")) {
      priority = "MEDIUM";
    } else {
      priority = "LOW";
    }
  } else if (["PERSONAL", "TRANSACTIONAL"].includes(category)) {
    priority = "MEDIUM";
  }

  // --- Action + confidence -------------------------------------------------
  const requiresAction =
    category === "JOB" &&
    (ACTION_SUBCATEGORIES.has(subCategory ?? "") || (hasDeadline && subCategory !== "JOB_ALERT"));

  const topScore = best.score;
  const margin = Math.max(0, topScore - (second?.score ?? 0));

  let confidence = 0.42 + Math.min(0.45, topScore * 0.85) + Math.min(0.1, margin * 0.5);
  if (category === "JOB" && subCategory) confidence += Math.min(0.12, subCategoryScore * 0.2);
  if (ats && category === "JOB") confidence += 0.06;
  if (category === "SPAM" && spamEvidence >= 0.55) confidence += 0.06;
  confidence = Math.max(0.3, Math.min(0.97, confidence));

  // Ambiguous middle ground must be reviewed by a human, never auto-applied.
  const ambiguousJob =
    category === "JOB" && jobEvidence >= 0.3 && jobEvidence < 0.5 && subCategory === "OTHER_JOB";
  const needsReview = confidence < 0.55 || ambiguousJob || (category === "JOB" && !subCategory);

  const reasoning = buildReasoning(category, subCategory, {
    ats,
    hasDeadline,
    jobHits: jobScore.hits,
    spamHits: spam.hits,
    promoHits: promo.hits,
    newsletterHits: newsletter.hits,
    socialHits: social.hits,
    transactionalHits: transactional.hits,
    subSignals,
  });

  const isUnwanted =
    ["PROMOTIONAL", "SPAM", "NEWSLETTER"].includes(category) || (category === "SOCIAL" && isSocialDomain(stats.domain));

  const unwantedReason = isUnwanted
    ? category === "SPAM"
      ? "Matches known spam patterns and is not protected"
      : category === "NEWSLETTER"
        ? "Broadcast newsletter with an unsubscribe footer"
        : category === "SOCIAL"
          ? "Automated social-platform notification"
          : "Bulk marketing content"
    : null;

  return {
    category: isProtectedSender(input.fromEmail) && category === "OTHER" ? "TRANSACTIONAL" : category,
    subCategory,
    priority,
    confidence: Number(confidence.toFixed(3)),
    requiresAction,
    needsReview,
    reasoning,
    isUnwanted,
    unwantedReason,
    signals: collect(haystack, [
      { name: "job", signals: JOB_SIGNALS },
      { name: "offer", signals: OFFER_SIGNALS },
      { name: "rejection", signals: REJECTION_SIGNALS },
      { name: "promo", signals: PROMOTIONAL_SIGNALS },
    ]).slice(0, 12),
  };
}

function buildReasoning(
  category: string,
  subCategory: string | null,
  ctx: {
    ats: boolean;
    hasDeadline: boolean;
    jobHits: SignalHit[];
    spamHits: SignalHit[];
    promoHits: SignalHit[];
    newsletterHits: SignalHit[];
    socialHits: SignalHit[];
    transactionalHits: SignalHit[];
    subSignals: Array<{ label: string }>;
  },
): string {
  const parts: string[] = [];
  if (category === "JOB") {
    if (ctx.ats) parts.push("the sender is a known recruitment platform");
    const primary = ctx.subSignals[0]?.label ?? ctx.jobHits[0]?.label;
    if (primary) parts.push(`the email ${primary}`);
    if (ctx.hasDeadline) parts.push("it states a deadline");
  } else if (category === "SPAM") {
    if (ctx.spamHits[0]) parts.push(`it ${ctx.spamHits[0].label}`);
  } else if (category === "PROMOTIONAL") {
    if (ctx.promoHits[0]) parts.push(`it ${ctx.promoHits[0].label}`);
  } else if (category === "NEWSLETTER") {
    if (ctx.newsletterHits[0]) parts.push(`it ${ctx.newsletterHits[0].label}`);
  } else if (category === "SOCIAL") {
    parts.push("it is an automated social-platform notification");
  } else if (category === "TRANSACTIONAL") {
    if (ctx.transactionalHits[0]) parts.push(`it ${ctx.transactionalHits[0].label}`);
  } else if (category === "PERSONAL") {
    parts.push("it is a short personal message from an individual sender");
  } else {
    parts.push("no strong recruitment or marketing signals were found");
  }

  const subjectLine = parts.length ? `Detected because ${parts.join(" and ")}.` : "";
  const trimmed = collapseWhitespace(subjectLine);
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}…` : trimmed;
}
