import type { ApplicationStatus, EmailCategory } from "@prisma/client";
import { prisma } from "../../config/prisma";

/**
 * Job-search analytics.
 *
 * All metrics are derived from persisted records only. Where a rate has no
 * denominator (e.g. offer rate with zero applications) the API returns 0 rather
 * than null/NaN, so charts never break on an empty account.
 */

export interface ActivityPoint {
  bucket: string; // ISO date (week or day start)
  label: string;
  applications: number;
  responses: number;
  interviews: number;
  offers: number;
  rejections: number;
}

export interface AnalyticsOverview {
  totals: {
    applications: number;
    thisWeek: number;
    thisMonth: number;
    responses: number;
    needsReview: number;
  };
  funnel: Array<{ status: ApplicationStatus; label: string; count: number }>;
  rates: {
    responseRate: number;
    shortlistRate: number;
    interviewRate: number;
    offerRate: number;
    rejectionRate: number;
    assessmentRate: number;
  };
  timings: {
    averageResponseDays: number | null;
    averageApplicationToInterviewDays: number | null;
    medianResponseDays: number | null;
  };
  byCompany: Array<{ company: string; total: number; interviews: number; offers: number; rejections: number }>;
  byRole: Array<{ role: string; total: number }>;
  weeklyActivity: ActivityPoint[];
  monthlyActivity: ActivityPoint[];
  inboxBreakdown: Array<{ category: EmailCategory; count: number }>;
  cleanupImpact: { proposed: number; executed: number };
  notificationStats: { sent: number; acknowledged: number; escalated: number; avgAcknowledgementMinutes: number | null };
}

const STATUS_LABELS: Record<ApplicationStatus, string> = {
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

function startOfWeekUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Number((sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]).toFixed(1));
}

export async function getAnalyticsOverview(userId: string, windowWeeks = 12): Promise<AnalyticsOverview> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowWeeks * 7 * 86_400_000);
  const weekStart = startOfWeekUtc(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [
    statusGroups,
    total,
    thisWeek,
    thisMonth,
    needsReview,
    applications,
    events,
    categoryGroups,
    cleanupProposed,
    cleanupExecuted,
    notificationTotal,
    notificationAck,
    notificationEscalated,
    ackSamples,
  ] = await Promise.all([
    prisma.application.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    prisma.application.count({ where: { userId } }),
    prisma.application.count({ where: { userId, appliedDate: { gte: weekStart } } }),
    prisma.application.count({ where: { userId, appliedDate: { gte: monthStart } } }),
    prisma.application.count({ where: { userId, needsReview: true } }),
    prisma.application.findMany({
      where: { userId },
      select: { id: true, company: true, role: true, status: true, appliedDate: true, createdAt: true },
    }),
    prisma.applicationEvent.findMany({
      where: { userId, occurredAt: { gte: windowStart } },
      select: { applicationId: true, type: true, occurredAt: true, fromStatus: true, toStatus: true },
      orderBy: { occurredAt: "asc" },
    }),
    prisma.emailAnalysis.groupBy({ by: ["category"], where: { userId }, _count: { _all: true } }),
    prisma.cleanupAction.count({ where: { userId, status: { in: ["PROPOSED", "APPROVED"] } } }),
    prisma.cleanupAction.count({ where: { userId, status: "EXECUTED" } }),
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, acknowledgedAt: { not: null } } }),
    prisma.notification.count({ where: { userId, escalationStage: { gte: 0 } } }),
    prisma.notification.findMany({
      where: { userId, acknowledgedAt: { not: null } },
      select: { createdAt: true, acknowledgedAt: true },
      take: 200,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const byStatus = new Map<ApplicationStatus, number>();
  for (const row of statusGroups) byStatus.set(row.status, row._count._all);

  const countOf = (...statuses: ApplicationStatus[]) =>
    statuses.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0);

  const responses = countOf("ACKNOWLEDGED", "SHORTLISTED", "ASSESSMENT", "INTERVIEW", "FINAL_ROUND", "OFFER", "ACCEPTED", "REJECTED");
  const shortlistedPlus = countOf("SHORTLISTED", "ASSESSMENT", "INTERVIEW", "FINAL_ROUND", "OFFER", "ACCEPTED");
  const interviews = countOf("INTERVIEW", "FINAL_ROUND", "OFFER", "ACCEPTED");
  const offers = countOf("OFFER", "ACCEPTED");
  const rejections = countOf("REJECTED");
  const assessments = countOf("ASSESSMENT", "INTERVIEW", "FINAL_ROUND", "OFFER", "ACCEPTED");

  // ---- Activity buckets ---------------------------------------------------
  const weekly = buildEmptyBuckets(windowWeeks, "week", weekStart);
  const monthly = buildEmptyBuckets(6, "month", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

  for (const application of applications) {
    const applied = application.appliedDate ?? application.createdAt;
    addToBucket(weekly, applied, "applications");
    addToBucket(monthly, applied, "applications");
  }

  for (const event of events) {
    const key = event.type === "REJECTION_RECEIVED" ? "rejections" : event.type === "INTERVIEW_SCHEDULED" ? "interviews" : event.type === "OFFER_ISSUED" ? "offers" : null;
    if (event.type === "STATUS_CHANGED" || event.type === "APPLICATION_CREATED") {
      addToBucket(weekly, event.occurredAt, "responses");
      addToBucket(monthly, event.occurredAt, "responses");
    }
    if (key) {
      addToBucket(weekly, event.occurredAt, key);
      addToBucket(monthly, event.occurredAt, key);
    }
  }

  // ---- Timing -------------------------------------------------------------
  const eventsByApplication = new Map<string, typeof events>();
  for (const event of events) {
    const list = eventsByApplication.get(event.applicationId) ?? [];
    list.push(event);
    eventsByApplication.set(event.applicationId, list);
  }

  const responseDurations: number[] = [];
  const interviewDurations: number[] = [];

  for (const application of applications) {
    const applied = application.appliedDate ?? application.createdAt;
    const list = (eventsByApplication.get(application.id) ?? []).filter((e) => e.occurredAt >= applied);

    const firstResponse = list.find((e) => e.type !== "APPLICATION_CREATED" && e.type !== "EMAIL_LINKED");
    if (firstResponse) responseDurations.push((firstResponse.occurredAt.getTime() - applied.getTime()) / 86_400_000);

    const firstInterview = list.find((e) => e.type === "INTERVIEW_SCHEDULED");
    if (firstInterview) interviewDurations.push((firstInterview.occurredAt.getTime() - applied.getTime()) / 86_400_000);
  }

  // ---- Groupings ----------------------------------------------------------
  const companyMap = new Map<string, { total: number; interviews: number; offers: number; rejections: number }>();
  const roleMap = new Map<string, number>();

  for (const application of applications) {
    const company = companyMap.get(application.company) ?? { total: 0, interviews: 0, offers: 0, rejections: 0 };
    company.total += 1;
    if (["INTERVIEW", "FINAL_ROUND", "OFFER", "ACCEPTED"].includes(application.status)) company.interviews += 1;
    if (["OFFER", "ACCEPTED"].includes(application.status)) company.offers += 1;
    if (application.status === "REJECTED") company.rejections += 1;
    companyMap.set(application.company, company);

    roleMap.set(application.role, (roleMap.get(application.role) ?? 0) + 1);
  }

  const ackMinutes = ackSamples
    .filter((n) => n.acknowledgedAt)
    .map((n) => (n.acknowledgedAt!.getTime() - n.createdAt.getTime()) / 60_000);

  const safeRate = (numerator: number) => (total > 0 ? Number(((numerator / total) * 100).toFixed(1)) : 0);

  return {
    totals: { applications: total, thisWeek, thisMonth, responses, needsReview },
    funnel: (["APPLIED", "ACKNOWLEDGED", "SHORTLISTED", "ASSESSMENT", "INTERVIEW", "FINAL_ROUND", "OFFER", "ACCEPTED", "REJECTED"] as ApplicationStatus[])
      .map((status) => ({ status, label: STATUS_LABELS[status], count: byStatus.get(status) ?? 0 })),
    rates: {
      responseRate: safeRate(responses),
      shortlistRate: safeRate(shortlistedPlus),
      interviewRate: safeRate(interviews),
      offerRate: safeRate(offers),
      rejectionRate: safeRate(rejections),
      assessmentRate: safeRate(assessments),
    },
    timings: {
      averageResponseDays: mean(responseDurations),
      averageApplicationToInterviewDays: mean(interviewDurations),
      medianResponseDays: median(responseDurations),
    },
    byCompany: Array.from(companyMap.entries())
      .map(([company, stats]) => ({ company, ...stats }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12),
    byRole: Array.from(roleMap.entries())
      .map(([role, count]) => ({ role, total: count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12),
    weeklyActivity: Array.from(weekly.values()),
    monthlyActivity: Array.from(monthly.values()),
    inboxBreakdown: categoryGroups.map((row) => ({ category: row.category, count: row._count._all })),
    cleanupImpact: { proposed: cleanupProposed, executed: cleanupExecuted },
    notificationStats: {
      sent: notificationTotal,
      acknowledged: notificationAck,
      escalated: notificationEscalated,
      avgAcknowledgementMinutes: mean(ackMinutes),
    },
  };
}

type BucketKey = "applications" | "responses" | "interviews" | "offers" | "rejections";

function buildEmptyBuckets(count: number, granularity: "week" | "month", anchor: Date): Map<string, ActivityPoint> {
  const buckets = new Map<string, ActivityPoint>();
  const cursor = new Date(anchor);

  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(cursor);
    if (granularity === "week") date.setUTCDate(date.getUTCDate() - i * 7);
    else date.setUTCMonth(date.getUTCMonth() - i);
    const iso = date.toISOString().slice(0, 10);
    buckets.set(iso, {
      bucket: iso,
      label: granularity === "week" ? `W/${iso}` : iso.slice(0, 7),
      applications: 0,
      responses: 0,
      interviews: 0,
      offers: 0,
      rejections: 0,
    });
  }

  return buckets;
}

function addToBucket(buckets: Map<string, ActivityPoint>, date: Date, key: BucketKey): void {
  const anchorKey = findBucketKey(buckets, date);
  if (!anchorKey) return;
  const bucket = buckets.get(anchorKey);
  if (bucket) bucket[key] += 1;
}

/** Finds the latest bucket whose start is <= the given date (nearest-previous). */
function findBucketKey(buckets: Map<string, ActivityPoint>, date: Date): string | null {
  let best: string | null = null;
  let bestTime = -Infinity;
  for (const key of buckets.keys()) {
    const time = new Date(`${key}T00:00:00.000Z`).getTime();
    if (time <= date.getTime() && time > bestTime) {
      bestTime = time;
      best = key;
    }
  }
  return best;
}

/**
 * Response-time distribution by company — powers the "who responds fastest"
 * insight on the analytics page.
 */
export async function getResponseTimeByCompany(userId: string, limit = 8) {
  const applications = await prisma.application.findMany({
    where: { userId, appliedDate: { not: null } },
    select: { id: true, company: true, appliedDate: true },
  });

  const events = await prisma.applicationEvent.findMany({
    where: { userId, type: { in: ["STATUS_CHANGED", "INTERVIEW_SCHEDULED", "REJECTION_RECEIVED", "OFFER_ISSUED", "ASSESSMENT_ASSIGNED"] } },
    select: { applicationId: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });

  const firstResponse = new Map<string, Date>();
  for (const event of events) {
    if (!firstResponse.has(event.applicationId)) firstResponse.set(event.applicationId, event.occurredAt);
  }

  const perCompany = new Map<string, number[]>();
  for (const application of applications) {
    const response = firstResponse.get(application.id);
    if (!response || !application.appliedDate) continue;
    const days = (response.getTime() - application.appliedDate.getTime()) / 86_400_000;
    if (days < 0) continue;
    const list = perCompany.get(application.company) ?? [];
    list.push(days);
    perCompany.set(application.company, list);
  }

  return Array.from(perCompany.entries())
    .map(([company, durations]) => ({
      company,
      samples: durations.length,
      averageDays: mean(durations),
      fastestDays: Number(Math.min(...durations).toFixed(1)),
    }))
    .filter((row) => row.samples >= 1)
    .sort((a, b) => (a.averageDays ?? 999) - (b.averageDays ?? 999))
    .slice(0, limit);
}
