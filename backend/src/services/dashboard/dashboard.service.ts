import { prisma } from "../../config/prisma";
import { STATUS_LABELS, SUBCATEGORY_LABELS } from "../../config/constants";
import { hourInTimezone } from "../../utils/dates";
import { getApplicationSummary, type ApplicationSummary } from "../applications/application.service";
import { getCleanupSummary, type CleanupSummary } from "../cleanup/cleanup.service";
import { getScanSchedule, type ScanSchedule } from "../gmail/sync.service";
import { getNotificationCounts } from "../notifications/notification.service";
import { getEmailCounters, type EmailCounters } from "../emails/emails.service";

/**
 * Dashboard aggregation.
 *
 * One call assembles everything the morning view needs so the client never has to
 * fan out across six endpoints, and so the "what needs my attention" ordering is
 * computed server-side (where the decisions live) rather than in the UI.
 */

export interface AttentionItem {
  kind: "ACTION_REQUIRED" | "DEADLINE" | "IMPORTANT_UPDATE" | "REJECTION" | "REVIEW" | "SYNC_PROBLEM";
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  applicationId: string | null;
  emailId: string | null;
  notificationId: string | null;
  company: string | null;
  role: string | null;
  headline: string;
  detail: string | null;
  deadline: string | null;
  actionLabel: string | null;
  actionUrl: string | null;
  occurredAt: string;
}

export interface DashboardPayload {
  greeting: string;
  headline: string;
  generatedAt: string;
  user: { name: string | null; timezone: string; isDemo: boolean };
  summary: ApplicationSummary;
  counters: EmailCounters;
  scan: ScanSchedule;
  cleanup: CleanupSummary;
  notifications: { unread: number; pendingAck: number; escalatedToday: number; recent: unknown[] };
  attention: AttentionItem[];
  recentApplications: Array<{
    id: string;
    company: string;
    role: string;
    status: string;
    statusLabel: string;
    appliedDate: string | null;
    lastUpdated: string;
    needsReview: boolean;
  }>;
  importantEmails: Array<{
    id: string;
    subject: string | null;
    fromName: string | null;
    fromEmail: string | null;
    receivedAt: string;
    subCategory: string | null;
    subCategoryLabel: string | null;
    priority: string;
    confidence: number;
    summary: string | null;
    applicationId: string | null;
  }>;
  upcomingDeadlines: Array<{
    id: string;
    applicationId: string;
    company: string;
    role: string;
    title: string;
    dueAt: string;
    daysRemaining: number;
    isOverdue: boolean;
  }>;
  activity: { last7Days: Array<{ date: string; applications: number; events: number }> };
}

function greetingFor(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good evening";
}

export async function getDashboard(userId: string): Promise<DashboardPayload> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("User not found");
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [
    summary,
    counters,
    scan,
    cleanup,
    notificationCounts,
    recentNotifications,
    recentApplications,
    importantEmails,
    deadlineEvents,
    reviewCount,
    activityApplications,
    activityEvents,
  ] = await Promise.all([
    getApplicationSummary(userId),
    getEmailCounters(userId),
    getScanSchedule(userId),
    getCleanupSummary(userId),
    getNotificationCounts(userId),
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { application: { select: { id: true, company: true, role: true } } },
    }),
    prisma.application.findMany({
      where: { userId },
      orderBy: { lastUpdated: "desc" },
      take: 6,
      select: {
        id: true,
        company: true,
        role: true,
        status: true,
        appliedDate: true,
        lastUpdated: true,
        needsReview: true,
      },
    }),
    prisma.email.findMany({
      where: {
        userId,
        isImportant: true,
        receivedAt: { gte: new Date(now.getTime() - 21 * 86_400_000) },
      },
      orderBy: [{ receivedAt: "desc" }],
      take: 6,
      include: { analysis: true },
    }),
    prisma.applicationEvent.findMany({
      where: {
        userId,
        dueAt: { not: null, gte: new Date(now.getTime() - 7 * 86_400_000) },
      },
      orderBy: { dueAt: "asc" },
      take: 8,
      include: { application: { select: { id: true, company: true, role: true } } },
    }),
    prisma.email.count({ where: { userId, needsReview: true } }),
    prisma.application.findMany({
      where: { userId, appliedDate: { gte: sevenDaysAgo } },
      select: { appliedDate: true },
    }),
    prisma.applicationEvent.findMany({
      where: { userId, occurredAt: { gte: sevenDaysAgo } },
      select: { occurredAt: true },
    }),
  ]);

  // ---- Attention list -------------------------------------------------------
  const attention: AttentionItem[] = [];

  for (const event of deadlineEvents) {
    if (!event.dueAt || !event.application) continue;
    const daysRemaining = Math.ceil((event.dueAt.getTime() - now.getTime()) / 86_400_000);
    attention.push({
      kind: daysRemaining < 0 ? "DEADLINE" : "ACTION_REQUIRED",
      severity: daysRemaining < 0 ? "CRITICAL" : daysRemaining <= 2 ? "CRITICAL" : daysRemaining <= 7 ? "HIGH" : "MEDIUM",
      applicationId: event.application.id,
      emailId: event.emailId,
      notificationId: null,
      company: event.application.company,
      role: event.application.role,
      headline: event.title,
      detail: event.description,
      deadline: event.dueAt.toISOString(),
      actionLabel: "Open application",
      actionUrl: `/applications/${event.application.id}`,
      occurredAt: event.occurredAt.toISOString(),
    });
  }

  for (const notification of recentNotifications) {
    if (notification.severity === "HIGH" || notification.severity === "CRITICAL") {
      attention.push({
        kind: notification.type === "REJECTION_RECEIVED" ? "REJECTION" : notification.type === "REVIEW_REQUIRED" ? "REVIEW" : "IMPORTANT_UPDATE",
        severity: notification.severity,
        applicationId: notification.application?.id ?? null,
        emailId: notification.emailId,
        notificationId: notification.id,
        company: notification.application?.company ?? null,
        role: notification.application?.role ?? null,
        headline: notification.title,
        detail: notification.body,
        deadline: (notification.metadata as { payload?: { deadline?: string } })?.payload?.deadline ?? null,
        actionLabel: notification.actionLabel ?? "Open in MailOps",
        actionUrl: notification.actionUrl,
        occurredAt: notification.createdAt.toISOString(),
      });
    }
  }

  if (reviewCount > 0) {
    attention.push({
      kind: "REVIEW",
      severity: "MEDIUM",
      applicationId: null,
      emailId: null,
      notificationId: null,
      company: null,
      role: null,
      headline: `${reviewCount} email${reviewCount === 1 ? "" : "s"} need your confirmation`,
      detail: "MailOps was not confident enough to file these automatically.",
      deadline: null,
      actionLabel: "Open review queue",
      actionUrl: "/emails?tab=needs_review",
      occurredAt: now.toISOString(),
    });
  }

  if (scan.lastScanError && scan.scanningEnabled) {
    attention.push({
      kind: "SYNC_PROBLEM",
      severity: "HIGH",
      applicationId: null,
      emailId: null,
      notificationId: null,
      company: null,
      role: null,
      headline: "MailOps could not finish its last inbox scan",
      detail: scan.lastScanError,
      deadline: null,
      actionLabel: "Open Gmail settings",
      actionUrl: "/settings?section=gmail",
      occurredAt: (scan.lastScanAt ?? now).toISOString(),
    });
  }

  const severityRank = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  attention.sort((a, b) => {
    const bySeverity = severityRank[b.severity] - severityRank[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
  });

  // ---- 7-day activity -------------------------------------------------------
  const last7Days: Array<{ date: string; applications: number; events: number }> = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(now.getTime() - i * 86_400_000);
    const key = day.toISOString().slice(0, 10);
    last7Days.push({
      date: key,
      applications: activityApplications.filter((a) => a.appliedDate?.toISOString().slice(0, 10) === key).length,
      events: activityEvents.filter((e) => e.occurredAt.toISOString().slice(0, 10) === key).length,
    });
  }

  const hour = hourInTimezone(now, user.timezone);
  const pendingAttention = attention.filter((a) => a.severity === "HIGH" || a.severity === "CRITICAL").length;

  const headline = pendingAttention
    ? `Your job search needs attention — ${pendingAttention} item${pendingAttention === 1 ? "" : "s"} to review.`
    : summary.thisWeek > 0
      ? `You have ${summary.thisWeek} application${summary.thisWeek === 1 ? "" : "s"} in play this week.`
      : "Your job search is up to date.";

  return {
    greeting: greetingFor(hour),
    headline,
    generatedAt: now.toISOString(),
    user: { name: user.name, timezone: user.timezone, isDemo: user.isDemo },
    summary,
    counters,
    scan,
    cleanup,
    notifications: { ...notificationCounts, recent: recentNotifications },
    attention: attention.slice(0, 8),
    recentApplications: recentApplications.map((application) => ({
      id: application.id,
      company: application.company,
      role: application.role,
      status: application.status,
      statusLabel: STATUS_LABELS[application.status],
      appliedDate: application.appliedDate ? application.appliedDate.toISOString() : null,
      lastUpdated: application.lastUpdated.toISOString(),
      needsReview: application.needsReview,
    })),
    importantEmails: importantEmails.map((email) => ({
      id: email.id,
      subject: email.subject,
      fromName: email.fromName,
      fromEmail: email.fromEmail,
      receivedAt: email.receivedAt.toISOString(),
      subCategory: email.analysis?.subCategory ?? null,
      subCategoryLabel: subCategoryLabel(email.analysis?.subCategory ?? null),
      priority: email.analysis?.priority ?? "LOW",
      confidence: email.analysis?.confidence ?? 0,
      summary: email.analysis?.summary ?? null,
      applicationId: email.applicationId,
    })),
    upcomingDeadlines: deadlineEvents
      .filter((event) => event.dueAt && event.application)
      .map((event) => {
        const dueAt = event.dueAt as Date;
        const daysRemaining = Math.ceil((dueAt.getTime() - now.getTime()) / 86_400_000);
        return {
          id: event.id,
          applicationId: event.application!.id,
          company: event.application!.company,
          role: event.application!.role,
          title: event.title,
          dueAt: dueAt.toISOString(),
          daysRemaining,
          isOverdue: daysRemaining < 0,
        };
      }),
    activity: { last7Days },
  };
}

/** Human label for a job sub-category, used by the dashboard email cards. */
export function subCategoryLabel(subCategory: string | null): string | null {
  if (!subCategory) return null;
  return SUBCATEGORY_LABELS[subCategory as keyof typeof SUBCATEGORY_LABELS] ?? null;
}
