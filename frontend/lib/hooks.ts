"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "./api";
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
  IntegrationStatus,
  MeResponse,
  NotificationRecord,
  PrivacySummary,
  RejectedApplication,
  ScanJobRecord,
  ScanSchedule,
  SettingsResponse,
  UserSettings,
} from "./types";

/**
 * Data hooks.
 *
 * One hook per resource, wrapping the central client. Components never see
 * `fetch`, and cache invalidation is expressed here so a mutation always knows
 * exactly which views it invalidates.
 */

/**
 * Query key factory.
 *
 * Filter objects are part of the key, which is what makes server-side filtering
 * cache-friendly: changing a filter is a different query, and going back to a
 * previous filter is served from cache instead of refetching.
 *
 * The parameter is typed as `object` so the caller's filter interfaces can be
 * passed directly.
 */
export const queryKeys = {
  me: ["me"] as const,
  dashboard: ["dashboard"] as const,
  system: ["dashboard", "system"] as const,
  applications: (filters: object) => ["applications", filters] as const,
  applicationSummary: ["applications", "summary"] as const,
  application: (id: string) => ["applications", id] as const,
  rejected: (filters: object) => ["applications", "rejected", filters] as const,
  emails: (filters: object) => ["emails", filters] as const,
  emailCounters: ["emails", "counters"] as const,
  email: (id: string) => ["emails", "detail", id] as const,
  reviewQueue: ["emails", "review-queue"] as const,
  scanStatus: ["gmail", "scan-status"] as const,
  gmailAccounts: ["gmail", "accounts"] as const,
  notifications: (filters: object) => ["notifications", filters] as const,
  notificationCounts: ["notifications", "counts"] as const,
  cleanup: (filters: object) => ["cleanup", filters] as const,
  cleanupSummary: ["cleanup", "summary"] as const,
  analytics: (weeks: number) => ["analytics", weeks] as const,
  settings: ["settings"] as const,
  audit: (filters: object) => ["settings", "audit", filters] as const,
  privacy: ["settings", "privacy"] as const,
  diagnostics: ["settings", "diagnostics"] as const,
};

const REFRESH_INTERVALS = {
  fast: 15_000,
  normal: 60_000,
  slow: 5 * 60_000,
};

/** ------------------------------------------------------------------------ */
/** Session                                                                   */
/** ------------------------------------------------------------------------ */

export function useMe(options?: Partial<UseQueryOptions<MeResponse, ApiError>>) {
  return useQuery<MeResponse, ApiError>({
    queryKey: queryKeys.me,
    queryFn: () => api.auth.me(),
    staleTime: 5 * 60_000,
    retry: false,
    ...options,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api.auth.login(input),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; name?: string }) => api.auth.register(input),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => queryClient.clear(),
  });
}

/**
 * Password change. Other sessions are revoked server-side; this session stays
 * signed in, so the local cache is left intact.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) => api.auth.changePassword(body),
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (body: { email: string }) => api.auth.forgotPassword(body),
  });
}

/**
 * Password reset. The server revokes every session, so the cache is cleared to
 * avoid rendering authenticated data after the redirect to sign-in.
 */
export function useResetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; newPassword: string }) => api.auth.resetPassword(body),
    onSuccess: () => queryClient.clear(),
  });
}

/** ------------------------------------------------------------------------ */
/** Dashboard                                                                 */
/** ------------------------------------------------------------------------ */

export function useDashboard() {
  return useQuery<DashboardPayload, ApiError>({
    queryKey: queryKeys.dashboard,
    queryFn: () => api.dashboard.get(),
    refetchInterval: REFRESH_INTERVALS.normal,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.system,
    queryFn: () => api.dashboard.system(),
    refetchInterval: REFRESH_INTERVALS.normal,
  });
}

/** ------------------------------------------------------------------------ */
/** Applications                                                              */
/** ------------------------------------------------------------------------ */

export interface ApplicationFilters {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  status?: string | string[];
  company?: string;
  role?: string;
  location?: string;
  jobId?: string;
  search?: string;
  from?: string;
  to?: string;
  needsReview?: boolean;
}

export function useApplications(filters: ApplicationFilters = {}) {
  return useQuery<Paginated<ApplicationListItem>, ApiError>({
    queryKey: queryKeys.applications(filters),
    queryFn: () => api.applications.list(filters),
    placeholderData: (previous) => previous,
  });
}

export function useApplicationSummary() {
  return useQuery<ApplicationSummary, ApiError>({
    queryKey: queryKeys.applicationSummary,
    queryFn: () => api.applications.summary(),
  });
}

export function useApplication(id: string | null) {
  return useQuery<ApplicationDetail, ApiError>({
    queryKey: queryKeys.application(id ?? ""),
    queryFn: () => api.applications.detail(id as string),
    enabled: Boolean(id),
  });
}

export function useRejectedApplications(filters: { page?: number; pageSize?: number; search?: string } = {}) {
  return useQuery<Paginated<RejectedApplication>, ApiError>({
    queryKey: queryKeys.rejected(filters),
    queryFn: () => api.applications.rejected(filters),
    placeholderData: (previous) => previous,
  });
}

export function useOverrideApplicationStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: string; note?: string }) =>
      api.applications.overrideStatus(id, status, note),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.application(variables.id) });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useUpdateApplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api.applications.update(id, patch),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.application(variables.id) });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}

export function useAddApplicationNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note, dueAt }: { id: string; note: string; dueAt?: string }) =>
      api.applications.addNote(id, note, dueAt),
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: queryKeys.application(variables.id) }),
  });
}

export function useDuplicateDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "CONTINUE" | "MERGE" }) =>
      api.applications.duplicateDecision(id, decision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

/** ------------------------------------------------------------------------ */
/** Emails                                                                    */
/** ------------------------------------------------------------------------ */

export interface EmailFilters {
  page?: number;
  pageSize?: number;
  tab?: "all" | "important" | "jobs" | "promotional" | "spam" | "newsletters" | "rejected" | "needs_review";
  category?: string;
  priority?: string;
  applicationId?: string;
  search?: string;
  sortBy?: "receivedAt" | "priority" | "confidence";
  sortDir?: "asc" | "desc";
}

export function useEmails(filters: EmailFilters = {}) {
  return useQuery<Paginated<EmailRecord>, ApiError>({
    queryKey: queryKeys.emails(filters),
    queryFn: () => api.emails.list(filters),
    placeholderData: (previous) => previous,
  });
}

export function useEmailCounters() {
  return useQuery<EmailCounters, ApiError>({
    queryKey: queryKeys.emailCounters,
    queryFn: () => api.emails.counters(),
    refetchInterval: REFRESH_INTERVALS.normal,
  });
}

export function useEmail(id: string | null) {
  return useQuery<EmailDetail, ApiError>({
    queryKey: queryKeys.email(id ?? ""),
    queryFn: () => api.emails.detail(id as string),
    enabled: Boolean(id),
  });
}

export function useReviewQueue() {
  return useQuery<EmailRecord[], ApiError>({
    queryKey: queryKeys.reviewQueue,
    queryFn: () => api.emails.reviewQueue(),
    refetchInterval: REFRESH_INTERVALS.fast,
  });
}

export function useOverrideEmailAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api.emails.overrideAnalysis(id, patch),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.email(variables.id) });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useResolveReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: Record<string, unknown> }) =>
      api.emails.resolveReview(id, decision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewQueue });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}

export function useReprocessEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.emails.reprocess(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

/** ------------------------------------------------------------------------ */
/** Gmail                                                                     */
/** ------------------------------------------------------------------------ */

export function useGmailAccounts() {
  return useQuery({
    queryKey: queryKeys.gmailAccounts,
    queryFn: () => api.gmail.accounts(),
    refetchInterval: REFRESH_INTERVALS.slow,
  });
}

export function useScanStatus() {
  return useQuery<{ schedule: ScanSchedule; jobs: ScanJobRecord[] }, ApiError>({
    queryKey: queryKeys.scanStatus,
    queryFn: () => api.gmail.scanStatus(),
    refetchInterval: REFRESH_INTERVALS.normal,
  });
}

export function useConnectGmail() {
  return useMutation({
    mutationFn: (returnTo?: string) => api.gmail.startOAuth(returnTo),
    onSuccess: (data) => {
      // Full-page navigation: Google's consent screen must own the window.
      if (typeof window !== "undefined") window.location.href = data.consentUrl;
    },
  });
}

export function useDisconnectGmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (gmailAccountId: string) => api.gmail.disconnect(gmailAccountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.gmailAccounts });
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useTriggerScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { gmailAccountId?: string; fullRescan?: boolean }) => api.gmail.scan(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      // Give the worker a moment, then refresh the lists it feeds.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["emails"] });
        queryClient.invalidateQueries({ queryKey: ["applications"] });
      }, 4000);
    },
  });
}

/** ------------------------------------------------------------------------ */
/** Notifications                                                             */
/** ------------------------------------------------------------------------ */

export interface NotificationFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  severity?: string;
  type?: string;
  requiresAck?: boolean;
  unacknowledgedOnly?: boolean;
}

export function useNotifications(filters: NotificationFilters = {}) {
  return useQuery<Paginated<NotificationRecord>, ApiError>({
    queryKey: queryKeys.notifications(filters),
    queryFn: () => api.notifications.list(filters),
    placeholderData: (previous) => previous,
    refetchInterval: REFRESH_INTERVALS.normal,
  });
}

export function useNotificationCounts() {
  return useQuery({
    queryKey: queryKeys.notificationCounts,
    queryFn: () => api.notifications.counts(),
    refetchInterval: REFRESH_INTERVALS.fast,
  });
}

export function useAcknowledgeNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, via }: { id: string; via?: string }) => api.notifications.acknowledge(id, via),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useResolveNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.notifications.resolve(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function usePauseEscalation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => api.notifications.pause(id, paused),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useRetryNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.notifications.retry(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/** ------------------------------------------------------------------------ */
/** Cleanup                                                                   */
/** ------------------------------------------------------------------------ */

export interface CleanupFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  category?: string;
  sender?: string;
}

export function useCleanupProposals(filters: CleanupFilters = {}) {
  return useQuery<Paginated<CleanupAction>, ApiError>({
    queryKey: queryKeys.cleanup(filters),
    queryFn: () => api.cleanup.list(filters),
    placeholderData: (previous) => previous,
  });
}

export function useCleanupSummary() {
  return useQuery<CleanupSummary, ApiError>({
    queryKey: queryKeys.cleanupSummary,
    queryFn: () => api.cleanup.summary(),
    refetchInterval: REFRESH_INTERVALS.normal,
  });
}

export interface ApproveCleanupInput {
  emailIds: string[];
  action: "DELETE" | "ARCHIVE" | "KEEP" | "IGNORE_SENDER";
}

/**
 * Cleanup execution.
 *
 * On success every inbox-facing view is invalidated, because an approved batch
 * changes what the user sees everywhere. The caller-supplied callback runs after
 * invalidation so the UI can report the outcome with fresh data behind it.
 */
export function useApproveCleanup(options?: { onSuccess?: (result: CleanupExecutionResult) => void }) {
  const queryClient = useQueryClient();

  return useMutation<CleanupExecutionResult, ApiError, ApproveCleanupInput>({
    mutationFn: (body) => api.cleanup.approve(body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["cleanup"] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.emailCounters });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      options?.onSuccess?.(data);
    },
  });
}

export function useRevertCleanup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cleanup.revert(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cleanup"] }),
  });
}

/** ------------------------------------------------------------------------ */
/** Analytics, settings, audit, privacy                                       */
/** ------------------------------------------------------------------------ */

export function useAnalytics(weeks = 12) {
  return useQuery<AnalyticsOverview, ApiError>({
    queryKey: queryKeys.analytics(weeks),
    queryFn: () => api.analytics.overview(weeks),
  });
}

export function useSettings() {
  return useQuery<SettingsResponse, ApiError>({
    queryKey: queryKeys.settings,
    queryFn: () => api.settings.get(),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserSettings> & { name?: string; timezone?: string }) => api.settings.update(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useUpsertIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      body,
    }: {
      kind: IntegrationStatus["kind"];
      body: { displayName?: string; config?: Record<string, unknown>; secrets?: Record<string, string>; verify?: boolean };
    }) => api.settings.upsertIntegration(kind, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: IntegrationStatus["kind"]) => api.settings.disconnectIntegration(kind),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

export function useAuditLog(filters: { page?: number; pageSize?: number; action?: string; actor?: string } = {}) {
  return useQuery<Paginated<AuditLogRecord>, ApiError>({
    queryKey: queryKeys.audit(filters),
    queryFn: () => api.settings.audit(filters),
    placeholderData: (previous) => previous,
  });
}

export function usePrivacySummary() {
  return useQuery<PrivacySummary, ApiError>({
    queryKey: queryKeys.privacy,
    queryFn: () => api.settings.privacy(),
  });
}

export function useDeleteEmailData() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keepApplicationHistory: boolean) => api.settings.deleteEmailData(keepApplicationHistory),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.privacy });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}

export function useDiagnostics() {
  return useQuery({
    queryKey: queryKeys.diagnostics,
    queryFn: () => api.settings.diagnostics(),
  });
}
