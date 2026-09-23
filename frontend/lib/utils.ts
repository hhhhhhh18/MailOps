import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type {
  ApplicationStatus,
  CleanupAction,
  EmailCategory,
  JobSubCategory,
  Priority,
  Severity,
} from "./types";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** ------------------------------------------------------------------------ */
/** Formatting                                                                */
/** ------------------------------------------------------------------------ */

export function formatDate(value: string | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...options,
  }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Compact relative time. Deliberately computed on the client from an ISO string
 * so it stays correct without a server round trip.
 */
export function formatRelative(value: string | null | undefined, now = new Date()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const past = diffMs < 0;

  if (minutes < 1) return "just now";
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;
  if (days < 30) return past ? `${days}d ago` : `in ${days}d`;
  return formatDate(value);
}

/** "2h 48m" style countdown used by the scan status panel. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** ------------------------------------------------------------------------ */
/** Status → visual language                                                  */
/** ------------------------------------------------------------------------ */

export type Tone = "success" | "info" | "waiting" | "critical" | "neutral" | "accent";

/**
 * Status colour mapping. This is the ONLY place status colours are defined, so
 * green always means an offer, red always means rejected/critical, and so on.
 */
export const STATUS_TONES: Record<ApplicationStatus, Tone> = {
  APPLIED: "info",
  ACKNOWLEDGED: "info",
  SHORTLISTED: "accent",
  ASSESSMENT: "waiting",
  INTERVIEW: "waiting",
  FINAL_ROUND: "waiting",
  OFFER: "success",
  ACCEPTED: "success",
  REJECTED: "critical",
  WITHDRAWN: "neutral",
  ON_HOLD: "neutral",
  NO_RESPONSE: "neutral",
};

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  APPLIED: "Applied",
  ACKNOWLEDGED: "Acknowledged",
  SHORTLISTED: "Shortlisted",
  ASSESSMENT: "Assessment",
  INTERVIEW: "Interview",
  FINAL_ROUND: "Final round",
  OFFER: "Offer",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
  ON_HOLD: "On hold",
  NO_RESPONSE: "No response",
};

export const SUB_CATEGORY_LABELS: Record<JobSubCategory, string> = {
  APPLICATION_RECEIVED: "Application received",
  APPLICATION_ACKNOWLEDGED: "Application acknowledged",
  SHORTLISTED: "Shortlisted",
  ASSESSMENT: "Assessment",
  INTERVIEW: "Interview invitation",
  NEXT_ROUND: "Next round",
  FINAL_ROUND: "Final round",
  RECRUITER_CONTACT: "Recruiter message",
  OFFER: "Offer",
  OFFER_ACCEPTED: "Offer accepted",
  REJECTION: "Rejection",
  WITHDRAWN: "Withdrawn",
  JOB_ALERT: "Job alert",
  OTHER_JOB: "Job-related",
};

export const CATEGORY_LABELS: Record<EmailCategory, string> = {
  JOB: "Job",
  PROMOTIONAL: "Promotional",
  SPAM: "Spam",
  NEWSLETTER: "Newsletter",
  SOCIAL: "Social",
  PERSONAL: "Personal",
  TRANSACTIONAL: "Transactional",
  OTHER: "Other",
};

export const PRIORITY_TONES: Record<Priority, Tone> = {
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "waiting",
  CRITICAL: "critical",
};

export const SEVERITY_TONES: Record<Severity, Tone> = {
  INFO: "neutral",
  LOW: "neutral",
  MEDIUM: "info",
  HIGH: "waiting",
  CRITICAL: "critical",
};

export const CATEGORY_TONES: Record<EmailCategory, Tone> = {
  JOB: "accent",
  PROMOTIONAL: "neutral",
  SPAM: "critical",
  NEWSLETTER: "neutral",
  SOCIAL: "neutral",
  PERSONAL: "info",
  TRANSACTIONAL: "info",
  OTHER: "neutral",
};

export const CLEANUP_STATUS_TONES: Record<CleanupAction["status"], Tone> = {
  PROPOSED: "waiting",
  APPROVED: "info",
  EXECUTED: "success",
  FAILED: "critical",
  SKIPPED: "neutral",
  REVERTED: "neutral",
  BLOCKED: "critical",
};

export const CHANNEL_LABELS: Record<string, string> = {
  DASHBOARD: "MailOps",
  SLACK: "Slack",
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  VOICE: "Voice call",
};

/** Tailwind class sets for each tone. Defined once, reused everywhere. */
export const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-[color:var(--tone-success-bg)] text-[color:var(--tone-success)] ring-[color:var(--tone-success)]/30",
  info: "bg-[color:var(--tone-info-bg)] text-[color:var(--tone-info)] ring-[color:var(--tone-info)]/30",
  waiting: "bg-[color:var(--tone-waiting-bg)] text-[color:var(--tone-waiting)] ring-[color:var(--tone-waiting)]/30",
  critical: "bg-[color:var(--tone-critical-bg)] text-[color:var(--tone-critical)] ring-[color:var(--tone-critical)]/30",
  neutral: "bg-[color:var(--tone-neutral-bg)] text-[color:var(--tone-neutral)] ring-white/10",
  accent: "bg-[color:var(--tone-accent-bg)] text-[color:var(--tone-accent)] ring-[color:var(--tone-accent)]/30",
};

/** ------------------------------------------------------------------------ */
/** Small helpers                                                             */
/** ------------------------------------------------------------------------ */

export function isOverdue(value: string | null | undefined): boolean {
  if (!value) return false;
  return new Date(value).getTime() < Date.now();
}

export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const diff = new Date(value).getTime() - Date.now();
  if (Number.isNaN(diff)) return null;
  return Math.ceil(diff / 86_400_000);
}

export function truncate(input: string | null | undefined, max = 100): string {
  if (!input) return "";
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

/** Confidence → human phrasing, never a raw model number in primary copy. */
export function confidenceLabel(confidence: number): { label: string; tone: Tone } {
  if (confidence >= 0.9) return { label: "High confidence", tone: "success" };
  if (confidence >= 0.75) return { label: "Confident", tone: "info" };
  if (confidence >= 0.55) return { label: "Unsure — needs review", tone: "waiting" };
  return { label: "Low confidence", tone: "critical" };
}

export function buildSearchParams(input: Record<string, string | number | boolean | undefined | null | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Deterministic avatar-ish colour for a company name (kept subtle). */
export function companyInitials(company: string): string {
  const parts = company.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
