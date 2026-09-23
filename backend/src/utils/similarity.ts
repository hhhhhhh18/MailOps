import { normalizeCompany, normalizeJobId, normalizeRole } from "./text";

/**
 * Similarity primitives used by:
 *  - application matcher (email -> existing application)
 *  - duplicate application detection
 *  - low-confidence candidate ranking for the review UI
 *
 * All functions are pure and return values in [0, 1].
 */

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Dice coefficient over token sets — robust to word order and duplication. */
export function tokenSetRatio(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

/** Character trigram cosine similarity — handles typos and inflection. */
export function trigramSimilarity(a: string, b: string): number {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim()} `;
  const grams = (s: string) => {
    const padded = norm(s);
    const out = new Map<string, number>();
    for (let i = 0; i < padded.length - 2; i += 1) {
      const g = padded.slice(i, i + 3);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  if (ga.size === 0 || gb.size === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [, v] of ga) magA += v * v;
  for (const [, v] of gb) magB += v * v;
  for (const [k, v] of ga) {
    const w = gb.get(k);
    if (w) dot += v * w;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Blended similarity: trigram dominates, token-set rewards word overlap. */
export function blendedSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 0.6 * trigramSimilarity(a, b) + 0.4 * tokenSetRatio(a, b);
}

export interface ApplicationIdentity {
  company: string;
  role: string;
  jobId?: string | null;
  applicationUrl?: string | null;
  companyKey?: string | null;
  roleKey?: string | null;
}

export interface IdentityMatch {
  score: number;
  /** Exactly one field matched with certainty (used to short-circuit). */
  exact: boolean;
  reasons: string[];
  companyScore: number;
  roleScore: number;
  jobIdMatch: boolean;
  urlMatch: boolean;
}

/**
 * Scores how likely an incoming email describes an existing application.
 * Job-id equality is treated as definitive; company+role similarity is a
 * probabilistic signal requiring a threshold decision upstream.
 */
export function matchApplicationIdentity(
  incoming: ApplicationIdentity,
  candidate: ApplicationIdentity,
): IdentityMatch {
  const incomingJobId = normalizeJobId(incoming.jobId);
  const candidateJobId = normalizeJobId(candidate.jobId);
  const jobIdMatch = Boolean(incomingJobId && candidateJobId && incomingJobId === candidateJobId);

  const urlMatch = Boolean(
    incoming.applicationUrl &&
      candidate.applicationUrl &&
      normalizeUrl(incoming.applicationUrl) === normalizeUrl(candidate.applicationUrl),
  );

  const companyScore = blendedSimilarity(
    incoming.companyKey ?? normalizeCompany(incoming.company),
    candidate.companyKey ?? normalizeCompany(candidate.company),
  );
  const roleScore = blendedSimilarity(
    incoming.roleKey ?? normalizeRole(incoming.role),
    candidate.roleKey ?? normalizeRole(candidate.role),
  );

  const reasons: string[] = [];
  if (jobIdMatch) reasons.push("identical job ID");
  if (urlMatch) reasons.push("identical application URL");
  if (companyScore >= 0.85) reasons.push("company name matches");
  if (roleScore >= 0.8) reasons.push("role title matches");

  if (jobIdMatch || urlMatch) {
    return { score: 1, exact: true, reasons, companyScore, roleScore, jobIdMatch, urlMatch };
  }

  // Weighted score: company identity is more reliable than role wording.
  const score = companyScore * 0.65 + roleScore * 0.35;
  return { score, exact: false, reasons, companyScore, roleScore, jobIdMatch, urlMatch };
}

export function normalizeUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url.trim());
    const params = new URLSearchParams(parsed.search);
    for (const key of Array.from(params.keys())) {
      if (/^(utm_|ref|source|trk|tracking|fbclid|gclid)/i.test(key)) params.delete(key);
    }
    const query = params.toString();
    return `${parsed.host.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/$/, "")}${query ? `?${query}` : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Similarity threshold above which we treat two applications as duplicates. */
export const DUPLICATE_THRESHOLD = 0.82;
/** Similarity threshold above which an email auto-links to an application. */
export const MATCH_THRESHOLD = 0.7;
/** Below this we ask the user rather than guessing. */
export const MATCH_REVIEW_THRESHOLD = 0.5;
