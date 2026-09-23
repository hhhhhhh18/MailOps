/**
 * Text utilities shared by the Gmail normaliser, the AI pipeline and the
 * application matcher. Deliberately dependency-free and deterministic so the
 * unit tests are stable.
 */

const COMPANY_SUFFIXES = [
  "inc",
  "inc.",
  "incorporated",
  "llc",
  "l.l.c.",
  "ltd",
  "ltd.",
  "limited",
  "plc",
  "pvt",
  "pvt.",
  "private",
  "gmbh",
  "ag",
  "co",
  "co.",
  "corp",
  "corp.",
  "corporation",
  "company",
  "technologies",
  "technology",
  "tech",
  "solutions",
  "systems",
  "services",
  "group",
  "holdings",
  "labs",
  "software",
  "consulting",
  "global",
  "india",
  "usa",
];

const ROLE_NOISE = [
  "job",
  "opening",
  "opportunity",
  "position",
  "role",
  "hiring",
  "urgent",
  "apply",
  "now",
  "remote",
  "hybrid",
  "onsite",
  "full",
  "time",
  "part",
  "contract",
  "intern",
  "internship",
  "senior",
  "sr",
  "jr",
  "junior",
  "lead",
  "staff",
  "principal",
];

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

/** Strip HTML to readable text without pulling in a DOM parser. */
export function htmlToText(html: string): string {
  return collapseWhitespace(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

/**
 * Aggressive newsletter/promo boilerplate removal: keeps the first meaningful
 * block of text, which is where recruitment signal usually lives.
 */
export function extractSalientText(body: string, maxChars = 6000): string {
  const text = collapseWhitespace(body);
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.25));
  return `${head}\n[...]\n${tail}`;
}

/** Normalised company key used for application matching + duplicate detection. */
export function normalizeCompany(company: string | null | undefined): string {
  if (!company) return "";
  const base = company
    .toLowerCase()
    .replace(/[^a-z0-9\s.&+-]/g, " ")
    .replace(/\b(?:https?|www)\b/g, " ");
  const tokens = base
    .split(/\s+/)
    .map((t) => t.replace(/^[.&+-]+|[.&+-]+$/g, ""))
    .filter(Boolean)
    .filter((t) => !COMPANY_SUFFIXES.includes(t));
  const kept = tokens.length ? tokens : base.split(/\s+/).filter(Boolean);
  return kept.join(" ").trim();
}

/**
 * Normalised role key: strips seniority/employment noise so "Sr. SWE" ≈ "Software Engineer".
 * Hyphens are treated as separators so "Full-time Data Analyst" and
 * "Full time Data Analyst" normalise identically.
 */
export function normalizeRole(role: string | null | undefined): string {
  if (!role) return "";
  const tokens = role
    .toLowerCase()
    .replace(/[^a-z0-9\s+/#.-]/g, " ")
    .split(/[\s/-]+/)
    .map((t) => t.replace(/[.-]+$/g, ""))
    .filter(Boolean)
    .filter((t) => !ROLE_NOISE.includes(t));
  return tokens.join(" ").trim();
}

/** Normalises a job/requisition id: "MS-98231" -> "ms98231". */
export function normalizeJobId(jobId: string | null | undefined): string {
  if (!jobId) return "";
  return jobId.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Groups a conversation by subject: "Re: Fwd: Interview - Microsoft" -> "interview microsoft". */
export function buildThreadKey(subject: string | null | undefined, fromEmail?: string | null): string | null {
  if (!subject) return fromEmail ? `from:${fromEmail.toLowerCase()}` : null;
  const cleaned = subject
    .replace(/^((re|fwd|fw|aw|sv)\s*:\s*)+/gi, "")
    .replace(/\[(external|secure|spam)\]/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.split(" ").slice(0, 8).join(" ");
}

/** Extracts the registrable-ish domain from an email address. */
export function domainFromEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  return email.split("@")[1]?.toLowerCase() ?? null;
}

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "zoho.com",
]);

export function isFreeMailDomain(domain: string | null): boolean {
  if (!domain) return false;
  return FREE_MAIL_DOMAINS.has(domain);
}

/**
 * Derives a plausible company name from a sender domain when the email itself
 * does not state one. Returns null for free-mail domains (a recruiter's personal
 * Gmail is not a company name).
 */
/**
 * Applicant-tracking platforms and job boards. A sender on one of these domains
 * is the *platform*, not the employer, so it must never be reported as the
 * company name (product rule: never invent information).
 */
const ATS_DOMAIN_LABELS = new Set([
  "workday",
  "myworkdayjobs",
  "wd1",
  "wd3",
  "wd5",
  "greenhouse",
  "lever",
  "hire",
  "icims",
  "smartrecruiters",
  "successfactors",
  "sapsf",
  "taleo",
  "bamboohr",
  "jobvite",
  "ashbyhq",
  "ashby",
  "recruitee",
  "workable",
  "zohorecruit",
  "jazzhr",
  "brassring",
  "applytojob",
  "paylocity",
  "oraclecloud",
  "naukri",
  "instahyre",
  "cutshort",
  "hirist",
  "wellfound",
  "angel",
  "glassdoor",
  "dice",
  "indeed",
  "monster",
  "linkedin",
]);

/** Generic role/function mailboxes that appear as subdomains of real employers. */
const GENERIC_MAILBOX_LABELS = new Set([
  "mail",
  "email",
  "careers",
  "career",
  "jobs",
  "job",
  "talent",
  "recruiting",
  "recruitment",
  "hr",
  "no-reply",
  "noreply",
  "donotreply",
  "notifications",
  "notification",
  "alerts",
  "info",
  "support",
  "apply",
  "hiring",
  "team",
  "corp",
  "news",
  "updates",
  "noreply",
]);

const GENERIC_TLDS = new Set(["com", "org", "net", "io", "co", "in", "ai", "dev", "app", "edu", "gov", "biz", "info", "us", "uk"]);

export function companyFromDomain(domain: string | null): string | null {
  if (!domain || isFreeMailDomain(domain)) return null;

  const parts = domain.split(".").filter(Boolean);
  // Drop the TLD and any generic mailbox/function subdomain label.
  const core = parts.filter((part) => !GENERIC_TLDS.has(part) && !GENERIC_MAILBOX_LABELS.has(part));

  // Every remaining label belongs to a known ATS/job-board platform -> not an employer.
  if (!core.length || core.every((part) => ATS_DOMAIN_LABELS.has(part))) return null;

  const employerLabels = core.filter((part) => !ATS_DOMAIN_LABELS.has(part));
  const label = employerLabels[employerLabels.length - 1];
  if (!label) return null;

  const pretty = label
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  // A single very short or numeric label is not a usable company name.
  if (pretty.replace(/\s/g, "").length < 3 || /^\d+$/.test(label)) return null;
  return pretty;
}

/** Counts URLs in a body without parsing them. */
export function countLinks(body: string): number {
  return (body.match(/https?:\/\/[^\s"'>]+/gi) ?? []).length;
}

export function extractUrls(body: string, limit = 10): string[] {
  const matches = body.match(/https?:\/\/[^\s"'>)]+/gi) ?? [];
  return Array.from(new Set(matches)).slice(0, limit);
}
