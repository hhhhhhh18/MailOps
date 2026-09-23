/**
 * Minimal Gmail permission set.
 *
 * MailOps requests exactly what the product needs and nothing else. Each scope
 * below is justified, and the justification is surfaced to the user in the
 * connect flow and on the Privacy settings page (see `describeScopes()`).
 *
 * Deliberately NOT requested:
 *  - https://mail.google.com/              (full mailbox access, incl. permanent delete)
 *  - gmail.send                            (MailOps never sends mail as the user)
 *  - gmail.settings.*                      (no filter/settings mutation)
 *  - any Google Drive / Contacts / Calendar scope
 */
export const GMAIL_SCOPES = [
  /** Read message metadata, headers and body of mail MailOps is permitted to analyse. */
  "https://www.googleapis.com/auth/gmail.readonly",
  /** Apply labels / move to trash / archive — required for the user-approved cleanup flow. */
  "https://www.googleapis.com/auth/gmail.modify",
  /** Identify which account was connected and show it in Settings. */
  "https://www.googleapis.com/auth/userinfo.email",
  /** Standard OIDC identifier; required by Google's consent screen. */
  "openid",
] as const;

export type GmailScope = (typeof GMAIL_SCOPES)[number];

export interface ScopeDescription {
  scope: string;
  title: string;
  why: string;
  required: boolean;
}

export const SCOPE_DESCRIPTIONS: ScopeDescription[] = [
  {
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    title: "Read your email",
    why: "MailOps reads messages so it can identify recruitment emails, extract application details and group promotional mail for cleanup. Reading happens in the background scanner, not in your browser.",
    required: true,
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.modify",
    title: "Organise your email",
    why: "Used only when you approve a cleanup action, to archive or move messages to Trash. MailOps never deletes anything without your explicit approval for that batch.",
    required: true,
  },
  {
    scope: "https://www.googleapis.com/auth/userinfo.email",
    title: "See your email address",
    why: "Confirms which Google account is connected so you can disconnect the right one later.",
    required: true,
  },
  {
    scope: "openid",
    title: "Sign-in identity",
    why: "Required by Google's OAuth consent screen for installed/web applications.",
    required: true,
  },
];

export function describeScopes(): ScopeDescription[] {
  return SCOPE_DESCRIPTIONS;
}

/** Verifies at runtime that the granted scopes cover what MailOps needs. */
export function auditGrantedScopes(granted: string[]): { ok: boolean; missing: string[] } {
  const normalized = new Set(granted.map((s) => s.trim()));
  const missing = GMAIL_SCOPES.filter((needed) => !normalized.has(needed) && needed !== "openid");
  return { ok: missing.length === 0, missing };
}

/** Gmail label ids used by the cleanup executor. */
export const GMAIL_LABELS = {
  inbox: "INBOX",
  trash: "TRASH",
  spam: "SPAM",
  unread: "UNREAD",
  important: "IMPORTANT",
  starred: "STARRED",
} as const;
