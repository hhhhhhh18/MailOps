/**
 * Date helpers. Everything is stored in UTC; local-time logic (quiet hours,
 * "good morning" greeting) resolves through the user's IANA timezone.
 */

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // Monday as first day
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function startOfMonth(date: Date): Date {
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Hour (0-23) in the given IANA timezone. Falls back to UTC on bad input. */
export function hourInTimezone(date: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    });
    const hour = Number.parseInt(formatter.format(date), 10);
    return Number.isNaN(hour) ? date.getUTCHours() : hour % 24;
  } catch {
    return date.getUTCHours();
  }
}

export function minutesSince(date: Date | null | undefined, now = new Date()): number | null {
  if (!date) return null;
  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 60_000));
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Quiet-hours window, inclusive of start hour and exclusive of end hour.
 * Handles windows that wrap midnight (e.g. 22 -> 7).
 */
export function isWithinQuietHours(
  now: Date,
  timezone: string,
  quietStart: number,
  quietEnd: number,
): boolean {
  if (quietStart === quietEnd) return false;
  const hour = hourInTimezone(now, timezone);
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

export function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function safeDate(input: unknown): Date | null {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === "number") {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    // Accept YYYY-MM-DD as an end-of-day deadline.
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (match) {
      const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59));
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

/**
 * Parses deadline phrases that appear in recruitment emails and resolves them
 * relative to the email's received date. Returns null when the text is
 * ambiguous — MailOps never fabricates a deadline.
 */
export function parseDeadlinePhrase(
  text: string | null | undefined,
  reference: Date,
): { date: Date | null; matched: string | null } {
  if (!text) return { date: null, matched: null };
  const haystack = text.replace(/\s+/g, " ");

  const monthNames =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const monthMap: Record<string, number> = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
    jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  };

  // 1. Explicit "before/by September 25, 2026" or "September 25"
  const explicit = new RegExp(
    `(?:before|by|on|due|deadline|no later than|within)?\\s*${monthNames}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`,
    "i",
  ).exec(haystack);
  if (explicit) {
    const month = monthMap[explicit[1].toLowerCase()];
    const day = Number.parseInt(explicit[2], 10);
    const year = explicit[3] ? Number.parseInt(explicit[3], 10) : reference.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, month, day, 23, 59, 59));
    if (day >= 1 && day <= 31 && !Number.isNaN(candidate.getTime())) {
      const adjusted = !explicit[3] && candidate < reference ? new Date(Date.UTC(year + 1, month, day, 23, 59, 59)) : candidate;
      return { date: adjusted, matched: explicit[0].trim() };
    }
  }

  // 2. Numeric "25/09/2026" or "09-25-2026"
  const numeric = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(haystack);
  if (numeric) {
    const first = Number.parseInt(numeric[1], 10);
    const second = Number.parseInt(numeric[2], 10);
    const year = Number.parseInt(numeric[3], 10);
    // Assume day-first when the first component cannot be a month.
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    const candidate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
    if (!Number.isNaN(candidate.getTime()) && day >= 1 && day <= 31) {
      return { date: candidate, matched: numeric[0] };
    }
  }

  // 3. Relative "within 5 days" / "in 48 hours"
  const relative = /\b(?:within|in|next)\s+(\d{1,3})\s*(hour|hours|day|days|week|weeks)\b/i.exec(haystack);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const ms =
      unit.startsWith("hour") ? amount * 3_600_000 : unit.startsWith("day") ? amount * 86_400_000 : amount * 7 * 86_400_000;
    return { date: new Date(reference.getTime() + ms), matched: relative[0] };
  }

  // 4. "tomorrow" / "today"
  const dayWord = /\b(tomorrow|today|tonight)\b/i.exec(haystack);
  if (dayWord) {
    const word = dayWord[1].toLowerCase();
    const d = new Date(reference);
    if (word === "tomorrow") d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(23, 59, 59, 0);
    return { date: d, matched: dayWord[0] };
  }

  return { date: null, matched: null };
}
