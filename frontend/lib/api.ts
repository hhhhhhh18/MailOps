import type {
  AnalyticsOverview,
  ApplicationDetail,
  ApplicationListItem,
  ApplicationSummary,
  AuditLogRecord,
  CleanupAction,
  CleanupExecutionResult,
  CleanupSummary,
  DashboardPayload,
  EmailCounters,
  EmailDetail,
  EmailRecord,
  GmailAccountSummary,
  IntegrationStatus,
  MeResponse,
  ScopeDescription,
  NotificationRecord,
  PageMeta,
  PrivacySummary,
  RejectedApplication,
  ScanJobRecord,
  ScanSchedule,
  SettingsResponse,
  UserSettings,
} from "./types";

/**
 * Centralised API client.
 *
 * Every call in the app goes through this module — UI components never call
 * `fetch` directly (product spec #32). That gives one place to:
 *   - attach credentials and the CSRF header
 *   - normalise the response envelope
 *   - translate transport and API errors into a single `ApiError`
 *   - recover from an expired access token by refreshing once, then replaying
 */

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly degraded: boolean;
  readonly requestId: string | null;
  readonly details?: unknown;

  constructor(input: {
    message: string;
    code: string;
    status: number;
    retryable?: boolean;
    degraded?: boolean;
    requestId?: string | null;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.degraded = input.degraded ?? false;
    this.requestId = input.requestId ?? null;
    this.details = input.details;
  }

  /** True when the user needs to reconnect Gmail rather than retry. */
  get needsReconnect(): boolean {
    return ["GMAIL_CONNECTION_EXPIRED", "GMAIL_INVALID_TOKEN", "GMAIL_NOT_CONNECTED"].includes(this.code);
  }

  get needsSignIn(): boolean {
    return this.code === "UNAUTHENTICATED";
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Kept in sync with CSRF_COOKIE in backend/src/services/auth/auth.service.ts. */
const CSRF_COOKIE_NAME = "mailops_csrf";
const CSRF_HEADER = "X-CSRF-Token";

let csrfBootstrapInFlight: Promise<string | null> | null = null;

/**
 * Returns the double-submit CSRF token, bootstrapping it on first use.
 *
 * The token must exist before the first state-changing request, but it is only
 * ever minted on a response — and in the auth flow the endpoints that set it are
 * POSTs that the CSRF check itself rejects. So the first mutation fetches
 * `GET /api/auth/csrf` (a safe method: no CSRF required, no session required,
 * returns nothing but a fresh random token) and then proceeds.
 *
 * Concurrent callers share a single request, so a burst of mutations cannot mint a
 * storm of tokens.
 */
async function ensureCsrfToken(): Promise<string | null> {
  const existing = readCookie(CSRF_COOKIE_NAME);
  if (existing) return existing;
  if (csrfBootstrapInFlight) return csrfBootstrapInFlight;

  csrfBootstrapInFlight = (async () => {
    try {
      const response = await fetch(buildUrl("/api/auth/csrf"), {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: { csrfToken?: string } };
      return body.data?.csrfToken ?? readCookie(CSRF_COOKIE_NAME);
    } catch {
      // Let the caller proceed without a header; the API will reject it and the
      // error surfaces with a real code rather than a silent client failure.
      return null;
    } finally {
      csrfBootstrapInFlight = null;
    }
  })();

  return csrfBootstrapInFlight;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /**
   * Typed as `object` rather than `Record<string, unknown>` so callers can pass
   * their own filter interfaces directly — TypeScript only allows assigning an
   * interface to an index-signature type when it happens to declare one.
   */
  query?: object;
  /** Set to false to receive a raw Response (used for the data export). */
  json?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: object): string {
  const url = new URL(`${API_URL}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }

    }
  }
  return url.toString();
}

let refreshInFlight: Promise<boolean> | null = null;

/** Refreshes the session once, coalescing concurrent 401s into a single call. */
async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      // /refresh is a POST, so it needs the double-submit token as well — bootstrap
      // it when this is the first request after a cold page load.
      const csrfToken = await ensureCsrfToken();
      const response = await fetch(buildUrl("/api/auth/refresh"), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
        },
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Allow a later 401 to trigger a fresh attempt.
      setTimeout(() => {
        refreshInFlight = null;
      }, 1000);
    }
  })();

  return refreshInFlight;
}

async function request<T>(path: string, options: RequestOptions = {}, allowRetry = true): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };

  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  // Double-submit CSRF: the header must match the readable cookie. On a cold page
  // load the cookie does not exist yet, so obtain the bootstrap token first —
  // otherwise the very first mutation (login/register) is rejected with 403.
  if (method !== "GET") {
    const csrfToken = (await ensureCsrfToken()) ?? readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError({
      message: "MailOps could not reach the server. Check your connection and try again.",
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
      degraded: true,
    });
  }

  if (response.status === 401 && allowRetry && method !== "GET") {
    const refreshed = await refreshSession();
    if (refreshed) return request<T>(path, options, false);
  }

  if (options.json === false) {
    if (!response.ok) {
      throw new ApiError({
        message: `Request failed with status ${response.status}`,
        code: "REQUEST_FAILED",
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    return response as unknown as T;
  }

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  const envelope = payload as { success?: boolean; data?: T; meta?: Record<string, unknown>; error?: ApiErrorPayload } | null;

  if (!response.ok || !envelope?.success) {
    const error = envelope?.error;
    throw new ApiError({
      message: error?.message ?? `Request failed with status ${response.status}`,
      code: error?.code ?? "REQUEST_FAILED",
      status: response.status,
      retryable: error?.retryable ?? response.status >= 500,
      degraded: error?.degraded ?? false,
      requestId: error?.requestId ?? response.headers.get("x-request-id"),
      details: error?.details,
    });
  }

  if (envelope.meta) {
    return { items: envelope.data, meta: envelope.meta } as unknown as T;
  }

  return envelope.data as T;
}

interface ApiErrorPayload {
  message: string;
  code: string;
  retryable: boolean;
  degraded: boolean;
  requestId: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

/** ------------------------------------------------------------------------ */
/** Endpoint surface                                                          */
/** ------------------------------------------------------------------------ */

export const api = {
  auth: {
    /**
     * Explicit pre-warm for the double-submit token. Not required for correctness
     * — `ensureCsrfToken()` calls it automatically before the first mutation — but
     * it lets a page establish the token up front instead of on first submit.
     */
    csrf: () => request<{ csrfToken: string; cookieName: string }>("/api/auth/csrf"),
    me: () => request<MeResponse>("/api/auth/me", { json: true }),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      request<{ changed: boolean; revokedSessions: number }>("/api/auth/change-password", {
        method: "POST",
        body,
      }),
    /**
     * Always resolves with the same generic message: the response carries no
     * signal about whether the address matched an account.
     */
    forgotPassword: (body: { email: string }) =>
      request<{ message: string }>("/api/auth/forgot-password", { method: "POST", body }),
    resetPassword: (body: { token: string; newPassword: string }) =>
      request<{ reset: boolean; revokedSessions: number }>("/api/auth/reset-password", {
        method: "POST",
        body,
      }),
    login: (body: { email: string; password: string }) =>
      request<{ user: MeResponse["user"]; csrfToken: string }>("/api/auth/login", { method: "POST", body }),
    register: (body: { email: string; password: string; name?: string; timezone?: string }) =>
      request<{ user: MeResponse["user"] }>("/api/auth/register", { method: "POST", body }),
    logout: () => request<{ signedOut: boolean }>("/api/auth/logout", { method: "POST" }),
    revokeSessions: () => request<{ revoked: number }>("/api/auth/sessions/revoke", { method: "POST" }),
  },

  dashboard: {
    get: () => request<DashboardPayload>("/api/dashboard"),
    system: () =>
      request<{ queues: Array<{ name: string; waiting: number; active: number; failed: number; available: boolean }>; degraded: boolean }>(
        "/api/dashboard/system",
      ),
  },

  applications: {
    list: (query: object) => request<Paginated<ApplicationListItem>>("/api/applications", { query }),
    summary: () => request<ApplicationSummary>("/api/applications/summary"),
    detail: (id: string) => request<ApplicationDetail>(`/api/applications/${id}`),
    rejected: (query: object) => request<Paginated<RejectedApplication>>("/api/applications/rejected", { query }),
    overrideStatus: (id: string, status: string, note?: string) =>
      request<ApplicationListItem>(`/api/applications/${id}/status`, { method: "POST", body: { status, note } }),
    update: (id: string, patch: Record<string, unknown>) =>
      request<ApplicationListItem>(`/api/applications/${id}`, { method: "PATCH", body: patch }),
    addNote: (id: string, note: string, dueAt?: string) =>
      request<unknown>(`/api/applications/${id}/notes`, { method: "POST", body: { note, dueAt } }),
    duplicateDecision: (id: string, decision: "CONTINUE" | "MERGE") =>
      request<{ merged: boolean }>(`/api/applications/${id}/duplicate-decision`, { method: "POST", body: { decision } }),
  },

  emails: {
    list: (query: object) => request<Paginated<EmailRecord>>("/api/emails", { query }),
    counters: () => request<EmailCounters>("/api/emails/counters"),
    detail: (id: string) => request<EmailDetail>(`/api/emails/${id}`),
    reviewQueue: () => request<EmailRecord[]>("/api/emails/review-queue"),
    overrideAnalysis: (id: string, patch: Record<string, unknown>) =>
      request<EmailDetail>(`/api/emails/${id}/analysis`, { method: "PATCH", body: patch }),
    resolveReview: (id: string, decision: Record<string, unknown>) =>
      request<{ resolved: boolean; outcome: string }>(`/api/emails/${id}/review`, { method: "POST", body: decision }),
    reprocess: (id: string) => request<{ jobId: string | null }>(`/api/emails/${id}/reprocess`, { method: "POST" }),
  },

  gmail: {
    accounts: () =>
      request<{ accounts: GmailAccountSummary[]; gmailConfigured: boolean; scopes: ScopeDescription[] }>("/api/gmail/accounts"),
    startOAuth: (returnTo?: string) =>
      request<{ consentUrl: string; returnTo: string; scopes: ScopeDescription[]; explanation: string }>(
        "/api/gmail/oauth/start",
        { method: "POST", body: { returnTo } },
      ),
    disconnect: (gmailAccountId: string) =>
      request<{ disconnected: boolean; revoked: boolean; note: string }>("/api/gmail/disconnect", {
        method: "POST",
        body: { gmailAccountId },
      }),
    scan: (body: { gmailAccountId?: string; fullRescan?: boolean } = {}) =>
      request<{ queued: boolean; jobId: string | null }>("/api/gmail/scan", { method: "POST", body }),
    scanStatus: () => request<{ schedule: ScanSchedule; jobs: ScanJobRecord[] }>("/api/gmail/scan/status"),
  },

  notifications: {
    list: (query: object) => request<Paginated<NotificationRecord>>("/api/notifications", { query }),
    counts: () => request<{ unread: number; pendingAck: number; escalatedToday: number }>("/api/notifications/counts"),
    acknowledge: (id: string, via = "DASHBOARD") =>
      request<{ notification: NotificationRecord; escalationStopped: boolean }>(`/api/notifications/${id}/acknowledge`, {
        method: "POST",
        body: { via },
      }),
    resolve: (id: string) => request<NotificationRecord>(`/api/notifications/${id}/resolve`, { method: "POST" }),
    pause: (id: string, paused: boolean) =>
      request<NotificationRecord>(`/api/notifications/${id}/pause`, { method: "POST", body: { paused } }),
    retry: (id: string) => request<{ queued: boolean }>(`/api/notifications/${id}/retry`, { method: "POST" }),
    reconcile: () => request<{ armed: number; cleared: number }>("/api/notifications/reconcile", { method: "POST" }),
  },

  cleanup: {
    list: (query: object) => request<Paginated<CleanupAction>>("/api/cleanup", { query }),
    summary: () => request<CleanupSummary>("/api/cleanup/summary"),
    approve: (body: { emailIds: string[]; action: "DELETE" | "ARCHIVE" | "KEEP" | "IGNORE_SENDER" }) =>
      request<CleanupExecutionResult>("/api/cleanup/approve", { method: "POST", body }),
    revert: (id: string) => request<{ reverted: boolean }>(`/api/cleanup/${id}/revert`, { method: "POST" }),
  },

  analytics: {
    overview: (weeks = 12) => request<AnalyticsOverview>("/api/analytics/overview", { query: { weeks } }),
  },

  settings: {
    get: () => request<SettingsResponse>("/api/settings"),
    update: (patch: Partial<UserSettings> & { name?: string; timezone?: string }) =>
      request<UserSettings>("/api/settings", { method: "PATCH", body: patch }),
    upsertIntegration: (
      kind: IntegrationStatus["kind"],
      body: { displayName?: string; config?: Record<string, unknown>; secrets?: Record<string, string>; verify?: boolean },
    ) => request<IntegrationStatus>(`/api/settings/integrations/${kind}`, { method: "PUT", body }),
    disconnectIntegration: (kind: IntegrationStatus["kind"]) =>
      request<{ disconnected: boolean }>(`/api/settings/integrations/${kind}`, { method: "DELETE" }),
    audit: (query: object) => request<Paginated<AuditLogRecord>>("/api/settings/audit", { query }),
    privacy: () => request<PrivacySummary>("/api/settings/privacy"),
    deleteEmailData: (keepApplicationHistory: boolean) =>
      request<{ emailsDeleted: number; applicationsDeleted: number; notes: string[] }>("/api/settings/privacy/email-data", {
        method: "DELETE",
        body: { keepApplicationHistory },
      }),
    exportData: () => request<Response>("/api/settings/privacy/export", { json: false }),
    diagnostics: () =>
      request<{
        database: { ok: boolean; error?: string };
        redis: { ok: boolean; error?: string };
        encryption: { configured: boolean; length: number; fingerprint: string };
        ai: { provider: string; configured: boolean };
        environment: string;
        queues: Array<{ name: string; available: boolean; waiting: number; failed: number }>;
      }>("/api/settings/diagnostics"),
  },
};

export { API_URL };
