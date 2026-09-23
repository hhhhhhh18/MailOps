import { google, type gmail_v1 } from "googleapis";
import type { GmailAccount } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { describeError, IntegrationError, ERROR_CODES } from "../../utils/errors";
import { getAuthorizedClient } from "./oauth.service";
import { normalizeGmailMessage, type NormalizedGmailMessage } from "./normalizer";

/**
 * Thin, retrying wrapper around the Gmail REST API.
 *
 * Every failure is translated into a MailOps error code so the rest of the
 * system never has to interpret Google error payloads, and transient failures
 * are retried with exponential backoff before surfacing.
 */
export class GmailClient {
  private constructor(private readonly gmail: gmail_v1.Gmail) {}

  static async forAccount(account: GmailAccount): Promise<GmailClient> {
    const auth = await getAuthorizedClient(account);
    return new GmailClient(google.gmail({ version: "v1", auth }));
  }

  async getProfile(): Promise<{ emailAddress: string | null; historyId: string | null; messagesTotal: number }> {
    const profile = await this.call("users.getProfile", () => this.gmail.users.getProfile({ userId: "me" }));
    return {
      emailAddress: profile.data.emailAddress ?? null,
      historyId: profile.data.historyId ?? null,
      messagesTotal: profile.data.messagesTotal ?? 0,
    };
  }

  /**
   * Lists message ids matching a Gmail search query.
   * Returns the ids plus the next page token; the caller decides how deep to go.
   */
  async listMessageIds(
    query: string,
    options: { maxResults?: number; pageToken?: string | null } = {},
  ): Promise<{ ids: string[]; nextPageToken: string | null; resultSizeEstimate: number }> {
    const response = await this.call("users.messages.list", () =>
      this.gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: Math.min(options.maxResults ?? 100, 500),
        pageToken: options.pageToken ?? undefined,
        includeSpamTrash: false,
      }),
    );

    return {
      ids: (response.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)),
      nextPageToken: response.data.nextPageToken ?? null,
      resultSizeEstimate: response.data.resultSizeEstimate ?? 0,
    };
  }

  /** Fetches and normalises a single message. Returns null when it is unusable. */
  async getMessage(id: string): Promise<NormalizedGmailMessage | null> {
    const response = await this.call("users.messages.get", () =>
      this.gmail.users.messages.get({ userId: "me", id, format: "full" }),
    );
    return normalizeGmailMessage(response.data);
  }

  /** Fetches many messages, tolerating individual failures. */
  async getMessages(ids: string[]): Promise<{ messages: NormalizedGmailMessage[]; failedIds: string[] }> {
    const messages: NormalizedGmailMessage[] = [];
    const failedIds: string[] = [];

    // Bounded concurrency keeps us well inside Gmail's per-user quota.
    const concurrency = 5;
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency);
      const settled = await Promise.all(
        batch.map(async (id) => {
          try {
            return await this.getMessage(id);
          } catch (error) {
            // A message deleted between list and fetch is not an error condition.
            const message = (error as Error).message ?? "";
            if (!/404|not found|deleted/i.test(message)) {
              failedIds.push(id);
            }
            return null;
          }
        }),
      );
      for (const message of settled) if (message) messages.push(message);
    }

    return { messages, failedIds };
  }

  /** Lists history records since a known historyId (incremental sync). */
  async listHistory(
    startHistoryId: string,
    pageToken?: string | null,
  ): Promise<{ messageIds: string[]; historyId: string | null; nextPageToken: string | null; expired: boolean }> {
    try {
      const response = await this.call("users.history.list", () =>
        this.gmail.users.history.list({
          userId: "me",
          startHistoryId,
          pageToken: pageToken ?? undefined,
          historyTypes: ["messageAdded"],
          maxResults: 100,
        }),
      );

      const ids = new Set<string>();
      for (const record of response.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }

      return {
        messageIds: Array.from(ids),
        historyId: response.data.historyId ?? null,
        nextPageToken: response.data.nextPageToken ?? null,
        expired: false,
      };
    } catch (error) {
      // Gmail returns 404 for an expired historyId; the caller must full-rescan.
      if (/404|history/i.test((error as Error).message ?? "")) {
        return { messageIds: [], historyId: null, nextPageToken: null, expired: true };
      }
      throw error;
    }
  }

  /** Archives: removes the INBOX label, keeps the message in All Mail. */
  async archiveMessage(id: string): Promise<void> {
    await this.call("users.messages.modify", () =>
      this.gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: { removeLabelIds: ["INBOX", "UNREAD"] },
      }),
    );
  }

  /** Moves to Trash: recoverable by the user for 30 days. */
  async trashMessage(id: string): Promise<void> {
    await this.call("users.messages.trash", () => this.gmail.users.messages.trash({ userId: "me", id }));
  }

  /** Marks read without touching folders. */
  async markRead(id: string): Promise<void> {
    await this.call("users.messages.modify", () =>
      this.gmail.users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["UNREAD"] } }),
    );
  }

  /**
   * Applies a label. Used for the "ignore sender" rule so MailOps can recognise
   * the user's intent on future scans without deleting anything.
   */
  async addLabel(id: string, labelName: string): Promise<void> {
    const labelId = await this.ensureLabel(labelName);
    await this.call("users.messages.modify", () =>
      this.gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [labelId] } }),
    );
  }

  private async ensureLabel(name: string): Promise<string> {
    const labels = await this.call("users.labels.list", () => this.gmail.users.labels.list({ userId: "me" }));
    const existing = (labels.data.labels ?? []).find((l) => l.name === name);
    if (existing?.id) return existing.id;
    const created = await this.call("users.labels.create", () =>
      this.gmail.users.labels.create({
        userId: "me",
        requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      }),
    );
    if (!created.data.id) {
      throw new IntegrationError("Unable to create the MailOps label", ERROR_CODES.GMAIL_API_UNAVAILABLE);
    }
    return created.data.id;
  }

  /**
   * Executes an API call with exponential backoff on transient failures.
   * Never retries 401/403 (credential or permission problems) — those must
   * surface to the user as an actionable error.
   */
  private async call<T>(operation: string, fn: () => Promise<T>, attempt = 0): Promise<T> {
    const maxAttempts = 4;
    try {
      return await fn();
    } catch (error) {
      const { message } = describeError(error);
      const status = extractStatus(error);
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

      if (status === 401) {
        throw new IntegrationError("Gmail rejected the stored credentials", ERROR_CODES.GMAIL_INVALID_TOKEN, {
          retryable: false,
          details: { operation },
        });
      }
      if (status === 403) {
        const insufficient = /insufficient|scope|permission/i.test(message);
        throw new IntegrationError(
          insufficient
            ? "MailOps is missing a required Gmail permission. Please reconnect your account."
            : "Gmail quota exceeded for this account. MailOps will retry shortly.",
          ERROR_CODES.GMAIL_API_UNAVAILABLE,
          { retryable: !insufficient, details: { operation } },
        );
      }

      if (retryable && attempt < maxAttempts - 1) {
        const delay = Math.min(30_000, 2 ** attempt * 1000) + Math.floor(Math.random() * 500);
        logger.warn({ operation, status, attempt, delay }, "gmail call failed; retrying with backoff");
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.call(operation, fn, attempt + 1);
      }

      throw new IntegrationError(
        retryable ? "Gmail API is temporarily unavailable" : "Gmail API request failed",
        ERROR_CODES.GMAIL_API_UNAVAILABLE,
        { retryable, details: { operation, status } },
      );
    }
  }
}

function extractStatus(error: unknown): number | null {
  const candidate = error as { code?: number | string; response?: { status?: number } };
  if (typeof candidate?.response?.status === "number") return candidate.response.status;
  if (typeof candidate?.code === "number") return candidate.code;
  if (typeof candidate?.code === "string") {
    const parsed = Number.parseInt(candidate.code, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Builds the Gmail search query used by the scanner. */
export function buildScanQuery(options: { lookbackDays?: number; extra?: string } = {}): string {
  const lookback = options.lookbackDays ?? env.GMAIL_SYNC_LOOKBACK_DAYS;
  const parts = [
    `newer_than:${lookback}d`,
    "-in:chat",
    "-in:sent",
    "-in:draft",
    "-category:forums",
    "-label:mailops-ignored",
  ];
  if (options.extra) parts.push(options.extra);
  return parts.join(" ");
}
