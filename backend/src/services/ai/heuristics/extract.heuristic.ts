import {
  collapseWhitespace,
  companyFromDomain,
  domainFromEmail,
  extractUrls,
  normalizeCompany,
  normalizeRole,
} from "../../../utils/text";
import { parseDeadlinePhrase } from "../../../utils/dates";

export interface ExtractInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  body?: string | null;
  receivedAt?: string | null;
  companyHints?: string[];
}

export interface HeuristicExtraction {
  company: string | null;
  role: string | null;
  jobId: string | null;
  applicationId: string | null;
  location: string | null;
  employmentType: string | null;
  appliedDate: string | null;
  emailDate: string | null;
  applicationStatus: string | null;
  interviewDate: string | null;
  assessmentDeadline: string | null;
  responseDeadline: string | null;
  recruiterName: string | null;
  recruiterEmail: string | null;
  salary: string | null;
  applicationUrl: string | null;
  jobUrl: string | null;
  requiredAction: string | null;
  importantDates: Array<{ label: string | null; date: string | null }>;
  evidence: string | null;
  confidence: number;
  needsReview: boolean;
  missingCriticalFields: string[];
  _diagnostics?: Record<string, unknown>;
}

const MONTHS =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_INLINE = new RegExp(
  `(?:\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}(?:\\s+\\d{4})?|\\b(?:today|tomorrow|tonight)\\b)`,
  "i",
);

/** Sentence-level split that keeps the surrounding context for evidence quotes. */
export function sentences(text: string): string[] {
  return collapseWhitespace(text.replace(/\n+/g, " ").replace(/([.!?])\s+/g, "$1\u0001"))
    .split("\u0001")
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

function findSentence(text: string, pattern: RegExp): string | null {
  for (const sentence of sentences(text)) {
    if (pattern.test(sentence)) return sentence.slice(0, 380);
  }
  return null;
}

/**
 * Prefers a sentence that both matches the topic AND contains a date.
 *
 * Extracting a deadline from "the first sentence mentioning the assessment" is
 * wrong surprisingly often: the topic is usually introduced ("Please complete the
 * assessment…") several sentences before the date is stated ("…must be completed
 * before September 25"). This looks for the dated sentence first.
 */
function findDatedSentence(text: string, pattern: RegExp): string | null {
  const matches = sentences(text).filter((sentence) => pattern.test(sentence));
  const dated = matches.find((sentence) => DATE_INLINE.test(sentence));
  return (dated ?? matches[0])?.slice(0, 380) ?? null;
}

function firstGroup(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const value = (match[1] ?? "").trim().replace(/[.,;:]+$/, "");
  return value.length >= 2 ? value : null;
}

/** Strips signature/legal noise from a captured company name. */
function tidyCompany(value: string | null): string | null {
  if (!value) return null;
  let cleaned = collapseWhitespace(value)
    .replace(/^(the|our|your|a|an)\s+/i, "")
    .replace(/\s+(team|recruitment|talent|careers|hr|hiring|family|group)$/i, "")
    .replace(/[,"'“”]+$/g, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/^(team|us|you|we|them|this|that|it|here)$/i.test(cleaned)) return null;
  if (/\b(regards|sincerely|thanks|unsubscribe|copyright|privacy|policy)\b/i.test(cleaned)) return null;
  // Reject sentence fragments.
  if (cleaned.split(" ").length > 6) cleaned = cleaned.split(" ").slice(0, 6).join(" ");
  return cleaned;
}

/**
 * Prepositions and function words that indicate a captured "role" is really a
 * sentence fragment ("at Microsoft", "with the team"). The keyword regexes run
 * case-insensitively, so the capitalisation in the pattern alone is not a
 * sufficient guard — this is the second line of defence.
 */
const ROLE_PREFIX_STOPWORDS = new Set([
  "at",
  "with",
  "for",
  "the",
  "a",
  "an",
  "is",
  "to",
  "in",
  "on",
  "of",
  "by",
  "from",
  "and",
  "as",
  "our",
  "your",
  "this",
  "that",
  "we",
  "you",
]);

function tidyRole(value: string | null): string | null {
  if (!value) return null;
  const cleaned = collapseWhitespace(value)
    .replace(/^(the|a|an|our|this)\s+/i, "")
    .replace(/\s+(position|role|opening|opportunity)$/i, "")
    .replace(/[,"'“”]+$/g, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 70) return null;
  if (/\b(regards|sincerely|deadline|unsubscribe|click|visit)\b/i.test(cleaned)) return null;

  // Reject sentence fragments that start with a function word.
  const firstWord = cleaned.split(/\s+/)[0].toLowerCase();
  if (ROLE_PREFIX_STOPWORDS.has(firstWord)) return null;

  // A role must contain at least one alphabetic word of 2+ characters.
  if (!/[A-Za-z]{2,}/.test(cleaned)) return null;
  return cleaned;
}

function normalizeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Deterministic structured extraction.
 *
 * Every field is grounded in literal text from the email. Fields the engine
 * cannot verify are returned as null — MailOps never invents job data, and it
 * never fabricates a deadline (product rules #2 and #3).
 */
export function extractHeuristically(input: ExtractInput): HeuristicExtraction {
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const text = `${subject}\n${body}`;
  const flat = collapseWhitespace(text);
  const lower = flat.toLowerCase();
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const domain = domainFromEmail(input.fromEmail ?? null);
  const found: string[] = [];

  // ---- Company ------------------------------------------------------------
  let company: string | null = null;

  // 1. Prefer a company the user already has applications with (grounding hint).
  for (const hint of input.companyHints ?? []) {
    if (!hint) continue;
    const hintLower = hint.toLowerCase();
    if (lower.includes(hintLower)) {
      // Require a word boundary so "Meta" does not match "metaverse".
      const boundary = new RegExp(`(^|[^a-z0-9])${hintLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (boundary.test(lower)) {
        company = hint;
        break;
      }
    }
  }

  if (!company) {
    company = tidyCompany(
      firstGroup(flat, /\bcompany\s*(?:name)?\s*[:\-]\s*([A-Z][A-Za-z0-9&.'\- ]{1,50})/i) ??
        firstGroup(flat, /\b(?:at|with|join)\s+([A-Z][A-Za-z0-9&.'\-]+(?:\s+[A-Z][A-Za-z0-9&.'\-]+){0,3})(?=\s+(?:for|as|is|has|we|and|team|to)\b|[.,!?])/) ??
        firstGroup(flat, /\b([A-Z][A-Za-z0-9&.'\-]+(?:\s+[A-Z][A-Za-z0-9&.'\-]+){0,3})\s+(?:is hiring|has shortlisted|would like to|has reviewed|would like you)/) ??
        firstGroup(flat, /\b(?:welcome to|thank you for your interest in)\s+([A-Z][A-Za-z0-9&.'\-]+(?:\s+[A-Z][A-Za-z0-9&.'\-]+){0,3})/i),
    );
  }

  if (!company) {
    const fromDomain = companyFromDomain(domain);
    if (fromDomain && fromDomain.length >= 3) {
      company = fromDomain;
      found.push("company:derived-from-domain");
    }
  } else {
    found.push("company");
  }

  // ---- Role ---------------------------------------------------------------
  const role = tidyRole(
    firstGroup(flat, /\bjob\s*title\s*[:\-]\s*([A-Za-z][A-Za-z0-9/&+.'\- ]{2,60})/i) ??
      firstGroup(flat, /\brole\s*[:\-]\s*([A-Za-z][A-Za-z0-9/&+.'\- ]{2,60})/i) ??
      firstGroup(
        flat,
        /\bposition\s*(?:of|for|:)?\s*[:]?\s*(?!at\b|with\b|for\b|the\b|a\b|an\b|is\b|to\b|in\b|on\b|by\b|of\b)([A-Z][A-Za-z0-9/&+.'\- ]{2,60}?)(?=\s*(?:at|with|role|position|has|is|,|\.|$))/i,
      ) ??
      firstGroup(
        flat,
        /\bapplication for\s+(?:the\s+)?(?:position\s+of\s+|role\s+of\s+)?(?!at\b|with\b|the\b|a\b|an\b|is\b)([A-Z][A-Za-z0-9/&+.'\- ]{2,60}?)(?=\s*(?:at|with|,|\.|$))/i,
      ) ??
      firstGroup(flat, /\b(?:for|as)\s+(?:the\s+)?([A-Z][A-Za-z0-9/&+.'\- ]{2,50}?)\s+(?:role|position)\b/i) ??
      firstGroup(flat, /\b(?:opening|opportunity)\s+for\s+(?:a|an)?\s*(?!at\b|with\b|the\b)([A-Z][A-Za-z0-9/&+.'\- ]{2,50})/i),
  );
  if (role) found.push("role");

  // Reject roles that are really the company name (avoids "at Microsoft for Microsoft").
  if (role && company && normalizeRole(role) === normalizeRole(company)) {
    // keep company, drop the duplicate role
  }
  else if (role && company && normalizeRole(role).startsWith(normalizeRole(company))) {
    // "Microsoft Software Engineer" -> keep as-is; both signals present
  }

  // ---- Identifiers --------------------------------------------------------
  const jobId =
    firstGroup(flat, /\b(?:job|requisition|req|posting|position)\s*(?:id|no\.?|number|code|ref(?:erence)?)?\s*[:\-#]\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,24})/i) ??
    firstGroup(subject, /\b([A-Z]{2,5}[-_]\d{4,8})\b/) ??
    firstGroup(flat, /\bref(?:erence)?\s*(?:no\.?|number|id)?\s*[:\-#]\s*([A-Za-z0-9][A-Za-z0-9\-_/]{3,24})/i);
  if (jobId) found.push("jobId");

  const applicationId =
    firstGroup(flat, /\bapplication\s*(?:id|ref(?:erence)?|number|no\.?)\s*[:\-#]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{3,32})/i) ?? null;

  // ---- Location / employment type ----------------------------------------
  let location =
    firstGroup(flat, /\blocation\s*[:\-]\s*([A-Za-z][A-Za-z ,.'\-]{1,60}?)(?=[\s,.]*(?:experience|salary|ctc|job|role|type|department)|[.;]|$)/i) ??
    firstGroup(flat, /\bbased (?:in|out of)\s+([A-Z][A-Za-z ,.'\-]{1,50}?)(?=[.;,]|$)/i) ??
    firstGroup(flat, /\boffice\s*(?:location)?\s*[:\-]\s*([A-Za-z][A-Za-z ,.'\-]{1,50}?)(?=[.;,]|$)/i);
  if (!location) {
    const remote = /\b(remote|work from home|wfh|fully remote|remote-first)\b/i.exec(flat);
    if (remote) location = remote[0].replace(/\b\w/g, (c) => c.toUpperCase());
    else if (/\bhybrid\b/i.test(flat)) location = "Hybrid";
  }
  if (location) found.push("location");

  const employmentType = (() => {
    const match = /\b(full[\s-]?time|part[\s-]?time|contract(?:or)?|internship|intern|temporary|freelance|permanent|probationary)\b/i.exec(
      flat,
    );
    if (!match) return null;
    const raw = match[0].toLowerCase();
    if (raw.startsWith("full")) return "Full-time";
    if (raw.startsWith("part")) return "Part-time";
    if (raw.startsWith("intern")) return "Internship";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  })();

  // ---- Dates --------------------------------------------------------------
  const emailDate = receivedAt.toISOString();

  const appliedSentence = findDatedSentence(
    flat,
    /\b(applied|application (?:was )?(?:submitted|received)|you applied)\b/i,
  );
  const appliedDate = appliedSentence ? normalizeDate(parseDeadlinePhrase(appliedSentence, receivedAt).date) : null;

  const interviewSentence = findDatedSentence(flat, /\binterview\b/i);
  const interviewDate = interviewSentence
    ? normalizeDate(parseDeadlinePhrase(interviewSentence, receivedAt).date)
    : null;

  const assessmentSentence = findDatedSentence(flat, /\b(assessment|online test|coding challenge|aptitude test)\b/i);
  const assessmentDeadline = assessmentSentence
    ? normalizeDate(parseDeadlinePhrase(assessmentSentence, receivedAt).date)
    : null;

  const responseSentence = findDatedSentence(
    flat,
    /\b(deadline|no later than|due by|kindly (?:respond|confirm)|please (?:respond|confirm)|expires? on|last date)\b/i,
  );
  const responseDeadline = responseSentence
    ? normalizeDate(parseDeadlinePhrase(responseSentence, receivedAt).date)
    : null;

  // ---- Recruiter ----------------------------------------------------------
  let recruiterName: string | null = null;
  const signoff = new RegExp(
    `\\b(?:regards|sincerely|best regards|warm regards|thanks(?: and regards)?|yours (?:faithfully|truly))\\b[,\\s]*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})`,
  ).exec(flat);
  if (signoff) {
    recruiterName = signoff[1].trim();
    found.push("recruiterName");
  } else {
    const signatureAlt = new RegExp(
      `([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})\\s*\\n?\\s*(?:talent acquisition|recruiter|hiring manager|hr)`,
      "i",
    ).exec(text);
    if (signatureAlt) recruiterName = signatureAlt[1].trim();
  }

  const bodyEmails = Array.from(
    new Set((flat.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase())),
  );
  const senderEmail = (input.fromEmail ?? "").toLowerCase();
  const sameDomainExtra = bodyEmails.find(
    (e) => e !== senderEmail && domainFromEmail(e) === domain && !/^(no-?reply|donotreply|notifications?)/.test(e),
  );
  const recruiterEmail =
    sameDomainExtra ?? (senderEmail && !/^(no-?reply|donotreply|notifications?)/.test(senderEmail) ? senderEmail : null);
  if (recruiterEmail) found.push("recruiterEmail");

  // ---- Salary -------------------------------------------------------------
  const salaryMatch =
    /\b(?:ctc|salary|compensation|package|pay|stipend)\b[^.\n]{0,20}?((?:₹|rs\.?|inr|\$|usd|€|£)\s?[\d,]+(?:\.\d+)?\s*(?:lpa|lakhs?|lacs?|per annum|p\.?a\.?|k|month|year|hr)?)/i.exec(
      flat,
    ) ??
    /((?:₹|rs\.?|inr|\$|usd|€|£)\s?[\d,]{3,}(?:\.\d+)?\s*(?:lpa|lakhs?|per annum|p\.?a\.?|per month)?)/i.exec(flat);
  const salary = salaryMatch ? collapseWhitespace(salaryMatch[1]) : null;
  if (salary) found.push("salary");

  // ---- URLs ---------------------------------------------------------------
  const urls = extractUrls(flat, 20);
  const pickUrl = (keywords: RegExp) => urls.find((u) => keywords.test(u)) ?? null;
  const assessmentUrl = pickUrl(/\b(assessment|test|challenge|hackerrank|codility|codesignal|shl|amcat|merittrac)\b/i);
  const applicationUrl =
    pickUrl(/\b(application|applicant|apply|portal|candidate|status)\b/i) ?? assessmentUrl ?? pickUrl(/\b(careers?|jobs?)\b/i);
  const jobUrl = pickUrl(/\b(job|position|requisition|opening|careers)\b/i) ?? null;
  if (applicationUrl) found.push("applicationUrl");

  // ---- Status -------------------------------------------------------------
  const statusRules: Array<[RegExp, string]> = [
    [/\b(we regret|regret to inform|not moving forward|decided not to proceed|no longer under consideration|not selected|unsuccessful)\b/i, "REJECTED"],
    [/\b(offer letter|offer of employment|pleased to offer|delighted to offer|we are offering you)\b/i, "OFFER"],
    [/\b(final round|final interview)\b/i, "FINAL_ROUND"],
    [/\b(interview|schedule a call|book a slot|technical discussion)\b/i, "INTERVIEW"],
    [/\b(assessment|online test|coding challenge|aptitude test)\b/i, "ASSESSMENT"],
    [/\b(shortlist)\b/i, "SHORTLISTED"],
    [/\b(application (?:has been )?(?:received|submitted)|thank you for applying|we received your application)\b/i, "APPLIED"],
    [/\b(under review|reviewing your application)\b/i, "ACKNOWLEDGED"],
  ];
  let applicationStatus: string | null = null;
  let evidence: string | null = null;
  for (const [pattern, status] of statusRules) {
    const sentence = findSentence(flat, pattern);
    if (sentence) {
      applicationStatus = status;
      evidence = sentence;
      break;
    }
  }

  // ---- Required action ----------------------------------------------------
  const actionSentence = findSentence(
    flat,
    /\b(please|kindly|you (?:are required|must|need to)|complete|schedule|confirm your|submit|respond by|provide)\b/i,
  );
  let requiredAction: string | null = actionSentence;
  if (requiredAction) {
    requiredAction = requiredAction
      .replace(/^(hi|hello|dear)[^,]*,\s*/i, "")
      .trim()
      .slice(0, 240);
  }

  // ---- Important dates ----------------------------------------------------
  const importantDates: Array<{ label: string | null; date: string | null }> = [];
  if (interviewDate) importantDates.push({ label: "Interview", date: interviewDate });
  if (assessmentDeadline) importantDates.push({ label: "Assessment deadline", date: assessmentDeadline });
  if (responseDeadline) importantDates.push({ label: "Response deadline", date: responseDeadline });

  // ---- Confidence ---------------------------------------------------------
  const criticalPresent = Boolean(company);
  const base = 0.35 + found.length * 0.055;
  const confidence = Math.max(
    0.3,
    Math.min(0.96, base + (criticalPresent ? 0.08 : 0) + (applicationStatus && evidence ? 0.07 : 0)),
  );

  const missingCriticalFields: string[] = [];
  if (!company) missingCriticalFields.push("company");
  if (!role) missingCriticalFields.push("role");

  return {
    company,
    role,
    jobId,
    applicationId,
    location,
    employmentType,
    appliedDate,
    emailDate,
    applicationStatus,
    interviewDate,
    assessmentDeadline,
    responseDeadline,
    recruiterName,
    recruiterEmail,
    salary,
    applicationUrl,
    jobUrl,
    requiredAction,
    importantDates,
    evidence,
    confidence: Number(confidence.toFixed(3)),
    needsReview: confidence < 0.55 || (!company && !role),
    missingCriticalFields,
    _diagnostics: {
      normalizedCompany: normalizeCompany(company),
      normalizedRole: normalizeRole(role),
      foundFields: found,
      datePattern: DATE_INLINE.source.length > 0,
    },
  };
}
