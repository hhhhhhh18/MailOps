import { countLinks, domainFromEmail, isFreeMailDomain } from "../../../utils/text";

/**
 * Shared lexicons for the deterministic classification engine.
 *
 * Two intentional design choices:
 *  1. Every signal is a *phrase*, not a bare word. "offer" alone is ambiguous
 *     (promotional offers vs. job offers); "offer of employment" is not.
 *  2. Sender domains are first-class signals. Most applicant-tracking systems
 *     send from a known platform domain, which is the single most reliable
 *     predictor of a recruitment email.
 */

export interface WeightedSignal {
  /** Matched against subject + body (lower-cased). */
  pattern: string;
  weight: number;
  label: string;
}

/** Applicant-tracking systems and job platforms. */
export const ATS_DOMAINS = [
  "greenhouse.io",
  "lever.co",
  "workday.com",
  "myworkdayjobs.com",
  "wd1.myworkdayjobs.com",
  "icims.com",
  "smartrecruiters.com",
  "successfactors.com",
  "sapsf.com",
  "taleo.net",
  "bamboohr.com",
  "jobvite.com",
  "ashbyhq.com",
  "recruitee.com",
  "workable.com",
  "zohorecruit.com",
  "jazzhr.com",
  "paylocity.com",
  "oraclecloud.com",
  "hire.lever.co",
  "applytojob.com",
  "brassring.com",
  "jobs.lever.co",
  "hirewithgoogle.com",
  "naukri.com",
  "instahyre.com",
  "cutshort.io",
  "hirist.com",
  "wellfound.com",
  "angel.co",
  "glassdoor.com",
  "dice.com",
  "indeed.com",
  "monster.com",
];

export const JOB_SIGNALS: WeightedSignal[] = [
  { pattern: "your application", weight: 0.30, label: "mentions the user's application" },
  { pattern: "application for", weight: 0.26, label: "references an application" },
  { pattern: "thank you for applying", weight: 0.34, label: "acknowledges a job application" },
  { pattern: "thanks for applying", weight: 0.34, label: "acknowledges a job application" },
  { pattern: "we received your application", weight: 0.34, label: "confirms receipt of an application" },
  { pattern: "application has been received", weight: 0.34, label: "confirms receipt of an application" },
  { pattern: "shortlist", weight: 0.40, label: "uses shortlisting language" },
  { pattern: "interview", weight: 0.34, label: "mentions an interview" },
  { pattern: "assessment", weight: 0.30, label: "mentions an assessment" },
  { pattern: "online test", weight: 0.32, label: "mentions an online test" },
  { pattern: "coding challenge", weight: 0.34, label: "mentions a coding challenge" },
  { pattern: "hackerrank", weight: 0.34, label: "sent via HackerRank" },
  { pattern: "codility", weight: 0.34, label: "sent via Codility" },
  { pattern: "codesignal", weight: 0.34, label: "sent via CodeSignal" },
  { pattern: "offer letter", weight: 0.44, label: "references an offer letter" },
  { pattern: "offer of employment", weight: 0.46, label: "references an employment offer" },
  { pattern: "pleased to offer", weight: 0.46, label: "extends an offer" },
  { pattern: "job offer", weight: 0.42, label: "references a job offer" },
  { pattern: "recruiter", weight: 0.30, label: "mentions a recruiter" },
  { pattern: "talent acquisition", weight: 0.32, label: "mentions talent acquisition" },
  { pattern: "hiring manager", weight: 0.30, label: "mentions a hiring manager" },
  { pattern: "hiring team", weight: 0.28, label: "mentions the hiring team" },
  { pattern: "we'd like to talk", weight: 0.32, label: "invites a conversation about a role" },
  { pattern: "schedule a call", weight: 0.26, label: "proposes a scheduling call" },
  { pattern: "position of", weight: 0.30, label: "names a position" },
  { pattern: "role of", weight: 0.28, label: "names a role" },
  { pattern: "requisition", weight: 0.32, label: "references a requisition" },
  { pattern: "job id", weight: 0.30, label: "carries a job ID" },
  { pattern: "job reference", weight: 0.30, label: "carries a job reference" },
  { pattern: "resume", weight: 0.22, label: "mentions the user's resume" },
  { pattern: "curriculum vitae", weight: 0.24, label: "mentions the user's CV" },
  { pattern: "next round", weight: 0.34, label: "references a next round" },
  { pattern: "final round", weight: 0.36, label: "references a final round" },
  { pattern: "technical round", weight: 0.34, label: "references a technical round" },
  { pattern: "hr round", weight: 0.32, label: "references an HR round" },
  { pattern: "joining date", weight: 0.34, label: "references a joining date" },
  { pattern: "onboarding", weight: 0.26, label: "references onboarding" },
  { pattern: "background verification", weight: 0.30, label: "references background verification" },
  { pattern: "candidate", weight: 0.22, label: "addresses a candidate" },
  { pattern: "job alert", weight: 0.26, label: "is a job alert" },
  { pattern: "jobs matching your", weight: 0.28, label: "is a job alert digest" },
  { pattern: "recommended jobs", weight: 0.24, label: "is a job recommendation digest" },
  { pattern: "career", weight: 0.14, label: "mentions careers" },
];

export const REJECTION_SIGNALS: WeightedSignal[] = [
  { pattern: "regret to inform", weight: 0.5, label: "expresses regret" },
  { pattern: "we regret", weight: 0.46, label: "expresses regret" },
  { pattern: "not moving forward", weight: 0.5, label: "states no further progress" },
  { pattern: "will not be moving forward", weight: 0.5, label: "states no further progress" },
  { pattern: "decided not to proceed", weight: 0.5, label: "states the process stopped" },
  { pattern: "unable to proceed", weight: 0.44, label: "states the process stopped" },
  { pattern: "no longer under consideration", weight: 0.5, label: "ends consideration" },
  { pattern: "not selected", weight: 0.46, label: "states non-selection" },
  { pattern: "unsuccessful", weight: 0.4, label: "states an unsuccessful outcome" },
  { pattern: "other candidates", weight: 0.36, label: "references other candidates" },
  { pattern: "pursue other applicants", weight: 0.44, label: "references other applicants" },
  { pattern: "position has been filled", weight: 0.4, label: "states the position is filled" },
  { pattern: "keep your resume on file", weight: 0.32, label: "offers to keep the resume on file" },
  { pattern: "wish you the best", weight: 0.24, label: "closes the process politely" },
];

export const SHORTLIST_SIGNALS: WeightedSignal[] = [
  { pattern: "shortlist", weight: 0.5, label: "uses the word shortlisted" },
  { pattern: "selected for the next", weight: 0.46, label: "advances to the next stage" },
  { pattern: "move forward with your application", weight: 0.46, label: "advances the application" },
  { pattern: "impressed by your profile", weight: 0.42, label: "praises the profile" },
  { pattern: "your profile has been", weight: 0.38, label: "comments on the profile" },
  { pattern: "congratulations", weight: 0.22, label: "congratulates the candidate" },
];

export const OFFER_SIGNALS: WeightedSignal[] = [
  { pattern: "offer letter", weight: 0.5, label: "references an offer letter" },
  { pattern: "offer of employment", weight: 0.52, label: "references an employment offer" },
  { pattern: "pleased to offer", weight: 0.52, label: "extends an offer" },
  { pattern: "delighted to offer", weight: 0.52, label: "extends an offer" },
  { pattern: "we are offering you", weight: 0.5, label: "extends an offer" },
  { pattern: "compensation package", weight: 0.34, label: "details compensation" },
  { pattern: "annual compensation", weight: 0.3, label: "details compensation" },
  { pattern: "we would like to offer", weight: 0.5, label: "extends an offer" },
];

export const ACK_SIGNALS: WeightedSignal[] = [
  { pattern: "thank you for applying", weight: 0.4, label: "acknowledges the application" },
  { pattern: "thanks for applying", weight: 0.4, label: "acknowledges the application" },
  { pattern: "application has been received", weight: 0.4, label: "confirms receipt" },
  { pattern: "we received your application", weight: 0.4, label: "confirms receipt" },
  { pattern: "application is under review", weight: 0.36, label: "confirms review" },
  { pattern: "reviewing your application", weight: 0.36, label: "confirms review" },
  { pattern: "application has been submitted", weight: 0.38, label: "confirms submission" },
];

export const ASSESSMENT_SIGNALS: WeightedSignal[] = [
  { pattern: "assessment", weight: 0.4, label: "mentions an assessment" },
  { pattern: "online test", weight: 0.42, label: "mentions an online test" },
  { pattern: "coding challenge", weight: 0.44, label: "mentions a coding challenge" },
  { pattern: "hackerrank", weight: 0.42, label: "sent via HackerRank" },
  { pattern: "codility", weight: 0.42, label: "sent via Codility" },
  { pattern: "codesignal", weight: 0.42, label: "sent via CodeSignal" },
  { pattern: "aptitude test", weight: 0.44, label: "mentions an aptitude test" },
  { pattern: "complete the test", weight: 0.4, label: "asks the candidate to complete a test" },
  { pattern: "attempt the", weight: 0.3, label: "asks the candidate to attempt something" },
];

export const INTERVIEW_SIGNALS: WeightedSignal[] = [
  { pattern: "interview", weight: 0.42, label: "mentions an interview" },
  { pattern: "schedule a call", weight: 0.3, label: "proposes a call" },
  { pattern: "book a slot", weight: 0.34, label: "asks the candidate to book a slot" },
  { pattern: "calendly", weight: 0.34, label: "uses a scheduling link" },
  { pattern: "technical discussion", weight: 0.4, label: "references a technical discussion" },
  { pattern: "panel discussion", weight: 0.38, label: "references a panel" },
  { pattern: "video call", weight: 0.32, label: "references a video call" },
  { pattern: "google meet", weight: 0.28, label: "references a meeting link" },
  { pattern: "zoom", weight: 0.26, label: "references a meeting link" },
  { pattern: "teams meeting", weight: 0.28, label: "references a meeting link" },
];

export const PROMOTIONAL_SIGNALS: WeightedSignal[] = [
  { pattern: "unsubscribe from this list", weight: 0.34, label: "bulk-marketing footer" },
  { pattern: "% off", weight: 0.4, label: "advertises a discount" },
  { pattern: "flat 50%", weight: 0.42, label: "advertises a discount" },
  { pattern: "sale ends", weight: 0.4, label: "has a sale deadline" },
  { pattern: "limited time offer", weight: 0.4, label: "is a limited-time promotion" },
  { pattern: "shop now", weight: 0.38, label: "pushes a purchase" },
  { pattern: "buy now", weight: 0.38, label: "pushes a purchase" },
  { pattern: "add to cart", weight: 0.38, label: "pushes a purchase" },
  { pattern: "free shipping", weight: 0.34, label: "advertises free shipping" },
  { pattern: "exclusive offer", weight: 0.36, label: "advertises an exclusive offer" },
  { pattern: "save up to", weight: 0.36, label: "advertises savings" },
  { pattern: "mega sale", weight: 0.4, label: "advertises a sale" },
  { pattern: "coupon code", weight: 0.36, label: "advertises a coupon" },
  { pattern: "biggest deal", weight: 0.36, label: "advertises a deal" },
  { pattern: "order now", weight: 0.34, label: "pushes a purchase" },
  { pattern: "click here to buy", weight: 0.4, label: "pushes a purchase" },
  { pattern: "best price", weight: 0.32, label: "advertises pricing" },
  { pattern: "special offer for you", weight: 0.36, label: "advertises a special offer" },
];

export const NEWSLETTER_SIGNALS: WeightedSignal[] = [
  { pattern: "newsletter", weight: 0.42, label: "is a newsletter" },
  { pattern: "weekly digest", weight: 0.44, label: "is a digest" },
  { pattern: "monthly roundup", weight: 0.42, label: "is a roundup" },
  { pattern: "issue #", weight: 0.36, label: "is a numbered issue" },
  { pattern: "this week in", weight: 0.36, label: "is a weekly roundup" },
  { pattern: "view in browser", weight: 0.3, label: "is a broadcast email" },
  { pattern: "you are receiving this because you", weight: 0.34, label: "is a broadcast email" },
  { pattern: "top stories", weight: 0.3, label: "rounds up stories" },
];

export const SOCIAL_SIGNALS: WeightedSignal[] = [
  { pattern: "started following you", weight: 0.5, label: "is a follow notification" },
  { pattern: "is now following you", weight: 0.5, label: "is a follow notification" },
  { pattern: "mentioned you in", weight: 0.5, label: "is a mention notification" },
  { pattern: "liked your post", weight: 0.5, label: "is a reaction notification" },
  { pattern: "commented on your", weight: 0.5, label: "is a comment notification" },
  { pattern: "friend request", weight: 0.5, label: "is a connection request" },
  { pattern: "connection request", weight: 0.46, label: "is a connection request" },
  { pattern: "viewed your profile", weight: 0.4, label: "is a profile-view notification" },
  { pattern: "shared a post", weight: 0.4, label: "is a share notification" },
  { pattern: "new login to", weight: 0.34, label: "is a platform notification" },
];

export const SOCIAL_DOMAINS = [
  "facebookmail.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "quora.com",
  "reddit.com",
  "medium.com",
  "pinterest.com",
  "snapchat.com",
  "discord.com",
  "meetup.com",
  "github.com",
  "gitlab.com",
  "stackoverflow.com",
];

export const TRANSACTIONAL_SIGNALS: WeightedSignal[] = [
  { pattern: "invoice", weight: 0.42, label: "is an invoice" },
  { pattern: "receipt", weight: 0.4, label: "is a receipt" },
  { pattern: "order confirmation", weight: 0.44, label: "confirms an order" },
  { pattern: "payment received", weight: 0.42, label: "confirms a payment" },
  { pattern: "your order", weight: 0.36, label: "references an order" },
  { pattern: "verification code", weight: 0.44, label: "carries a verification code" },
  { pattern: "one-time password", weight: 0.46, label: "carries a one-time password" },
  { pattern: "password reset", weight: 0.44, label: "is a password reset" },
  { pattern: "account statement", weight: 0.4, label: "is an account statement" },
  { pattern: "transaction of", weight: 0.38, label: "confirms a transaction" },
  { pattern: "debited", weight: 0.4, label: "references a debit" },
  { pattern: "credited", weight: 0.36, label: "references a credit" },
  { pattern: "tax", weight: 0.2, label: "mentions tax" },
];

export const SPAM_SIGNALS: WeightedSignal[] = [
  { pattern: "you have won", weight: 0.6, label: "claims a prize win" },
  { pattern: "claim your prize", weight: 0.6, label: "pushes a prize claim" },
  { pattern: "lottery", weight: 0.56, label: "references a lottery" },
  { pattern: "wire transfer", weight: 0.5, label: "requests a transfer" },
  { pattern: "unclaimed funds", weight: 0.56, label: "offers unclaimed funds" },
  { pattern: "millions of dollars", weight: 0.56, label: "promises large sums" },
  { pattern: "bitcoin investment", weight: 0.5, label: "pitches crypto investment" },
  { pattern: "crypto investment", weight: 0.5, label: "pitches crypto investment" },
  { pattern: "work from home and earn", weight: 0.5, label: "offers unrealistic earnings" },
  { pattern: "100% guaranteed", weight: 0.44, label: "uses a guaranteed-return claim" },
  { pattern: "click here to claim", weight: 0.5, label: "pushes a claim link" },
  { pattern: "no experience required", weight: 0.34, label: "promises work without experience" },
  { pattern: "earn up to", weight: 0.36, label: "promises earnings" },
  { pattern: "risk free", weight: 0.34, label: "promises risk-free returns" },
];

/** Financial / government mail is protected from cleanup even when it is not "important". */
export const PROTECTED_SENDER_SIGNALS = [
  "bank",
  "credit card",
  "insurance",
  "tax",
  "irs",
  "gov.in",
  "gov.uk",
  ".gov",
  "uidai",
  "epfo",
  "paypal",
  "stripe",
];

export interface SignalHit {
  label: string;
  weight: number;
  pattern: string;
}

export function matchSignals(haystack: string, signals: WeightedSignal[], limit = 6): SignalHit[] {
  const hits: SignalHit[] = [];
  for (const signal of signals) {
    if (haystack.includes(signal.pattern)) {
      hits.push({ label: signal.label, weight: signal.weight, pattern: signal.pattern });
    }
  }
  hits.sort((a, b) => b.weight - a.weight);
  return hits.slice(0, limit);
}

export function scoreSignals(haystack: string, signals: WeightedSignal[]): { score: number; hits: SignalHit[] } {
  const hits = matchSignals(haystack, signals);
  // Diminishing returns: the first matches carry most of the evidence.
  let score = 0;
  hits.forEach((hit, index) => {
    score += hit.weight * (index === 0 ? 1 : index === 1 ? 0.7 : index === 2 ? 0.5 : 0.3);
  });
  return { score: Math.min(1, score), hits };
}

export function isAtsDomain(domain: string | null): boolean {
  if (!domain) return false;
  return ATS_DOMAINS.some((ats) => domain === ats || domain.endsWith(`.${ats}`));
}

export function isSocialDomain(domain: string | null): boolean {
  if (!domain) return false;
  return SOCIAL_DOMAINS.some((social) => domain === social || domain.endsWith(`.${social}`));
}

export function isProtectedSender(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return PROTECTED_SENDER_SIGNALS.some((signal) => lower.includes(signal));
}

export interface EmailShapeStats {
  bodyLength: number;
  linkCount: number;
  isFreeMail: boolean;
  hasUnsubscribe: boolean;
  allCapsSubject: boolean;
  exclamationCount: number;
  domain: string | null;
}

export function shapeStats(input: {
  subject?: string | null;
  fromEmail?: string | null;
  body?: string | null;
}): EmailShapeStats {
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const domain = domainFromEmail(input.fromEmail ?? null);
  return {
    bodyLength: body.length,
    linkCount: countLinks(body),
    isFreeMail: isFreeMailDomain(domain),
    hasUnsubscribe: /unsubscribe/i.test(body),
    allCapsSubject: subject.length > 8 && subject === subject.toUpperCase(),
    exclamationCount: (subject.match(/!/g) ?? []).length,
    domain,
  };
}
