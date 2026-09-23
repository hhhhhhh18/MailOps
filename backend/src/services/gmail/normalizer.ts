import type { gmail_v1 } from "googleapis";
import { buildThreadKey, collapseWhitespace, extractSalientText, htmlToText } from "../../utils/text";

export interface NormalizedGmailMessage {
  gmailMessageId: string;
  gmailThreadId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  snippet: string | null;
  /** Minimised, plain-text body. Never raw HTML. */
  bodyText: string | null;
  receivedAt: Date;
  labels: string[];
  hasAttachments: boolean;
  sizeEstimate: number | null;
  isImportant: boolean;
  isUnread: boolean;
  threadKey: string | null;
}

const MAX_BODY_CHARS = 12_000;

function header(message: gmail_v1.Schema$Message, name: string): string | null {
  const headers = message.payload?.headers ?? [];
  const found = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

/** Parses "Jane Doe <jane@corp.com>" or a bare address. */
export function parseAddress(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const angle = /^(.*?)<([^>]+)>\s*$/.exec(raw.trim());
  if (angle) {
    // Strip surrounding quotes (and stray whitespace) before collapsing, so
    // '"Nair, Priya" <x@y.com>' yields "Nair, Priya" rather than 'Nair, Priya"'.
    const display = angle[1].trim().replace(/^"+|"+$/g, "").trim();
    return {
      name: collapseWhitespace(display) || null,
      email: angle[2].trim().toLowerCase(),
    };
  }
  if (/^[^@\s]+@[^@\s]+$/.test(raw.trim())) return { name: null, email: raw.trim().toLowerCase() };
  return { name: collapseWhitespace(raw) || null, email: null };
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Walks the MIME tree and returns the best available textual representation.
 * Prefers text/plain; falls back to a tag-stripped text/html rendering.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!part) return;
    const mime = part.mimeType ?? "";
    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (mime === "text/plain") plain.push(decoded);
      else if (mime === "text/html") html.push(decoded);
      else if (!mime && decoded && !plain.length && !html.length) plain.push(decoded);
    }
    for (const child of part.parts ?? []) walk(child);
  };

  walk(payload);

  const text = plain.length ? plain.join("\n") : html.length ? htmlToText(html.join("\n")) : "";
  return collapseWhitespace(text).slice(0, MAX_BODY_CHARS);
}

function hasAttachments(payload: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!payload) return false;
  const walk = (part: gmail_v1.Schema$MessagePart | undefined): boolean => {
    if (!part) return false;
    if (part.filename && part.filename.length > 0 && part.body?.size && part.body.size > 0) return true;
    return (part.parts ?? []).some(walk);
  };
  return walk(payload);
}

/**
 * Converts a raw Gmail message into MailOps' canonical email shape.
 * The body is reduced to salient text before it is ever persisted, so MailOps
 * stores the minimum content required to classify and extract (product rule #15).
 */
export function normalizeGmailMessage(message: gmail_v1.Schema$Message): NormalizedGmailMessage | null {
  const id = message.id;
  if (!id) return null;

  const internalDate = message.internalDate ? Number(message.internalDate) : Date.now();
  const receivedAt = new Date(Number.isNaN(internalDate) ? Date.now() : internalDate);

  const from = parseAddress(header(message, "From"));
  const to = parseAddress(header(message, "To"));
  const subject = header(message, "Subject") ?? null;
  const body = extractBody(message.payload);
  const labels = message.labelIds ?? [];

  return {
    gmailMessageId: id,
    gmailThreadId: message.threadId ?? null,
    fromName: from.name,
    fromEmail: from.email,
    toEmail: to.email,
    subject,
    snippet: message.snippet ? collapseWhitespace(message.snippet).slice(0, 600) : null,
    bodyText: body ? extractSalientText(body, MAX_BODY_CHARS) : null,
    receivedAt,
    labels,
    hasAttachments: hasAttachments(message.payload),
    sizeEstimate: message.sizeEstimate ?? null,
    isImportant: labels.includes("IMPORTANT"),
    isUnread: labels.includes("UNREAD"),
    threadKey: buildThreadKey(subject, from.email),
  };
}

/**
 * Structural redaction applied before storage when the user has disabled body
 * storage: keeps only the snippet and headers.
 */
export function minimizeMessage(message: NormalizedGmailMessage, storeBody: boolean): NormalizedGmailMessage {
  if (storeBody) return message;
  return { ...message, bodyText: null };
}
