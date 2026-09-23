"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarClock,
  CheckCircle2,
  Inbox,
  Mail,
  Sparkles,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { Badge, Button, Card, EmptyState, InlineAlert, Skeleton, Stat } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/data";
import { ActivitySparkline } from "@/components/domain/charts";
import { ScanStatusPanel } from "@/components/domain/scan-status";
import { NotificationMiniList } from "@/components/domain/notification-card";
import { StatusBadge, SubCategoryBadge } from "@/components/domain/badges";
import { useDashboard } from "@/lib/hooks";
import { cn, formatDate, formatPercent, formatRelative, pluralize } from "@/lib/utils";
import type { AttentionItem } from "@/lib/types";

/**
 * Dashboard (spec #20, #50).
 *
 * The morning view: what happened while you were away, what needs action, and
 * proof that MailOps actually ran. The attention list is ordered by the decision
 * engine, not by the UI, so the most urgent item is always first.
 */
export default function DashboardPage() {
  const { data, isLoading, isError, error, refetch } = useDashboard();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <EmptyState
          title="Could not load your dashboard"
          description={error instanceof Error ? error.message : undefined}
          action={
            <Button size="sm" variant="secondary" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      </Card>
    );
  }

  const { summary, counters, attention, scan } = data;

  return (
    <div className="space-y-5">
      {/* ---- Greeting ---- */}
      <div className="surface-card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">
                {data.greeting}
                {data.user.name ? `, ${data.user.name.split(" ")[0]}` : ""}
              </h1>
              {data.user.isDemo && <Badge tone="waiting">Demo data</Badge>}
            </div>
            <p className="mt-1 text-sm text-secondary">{data.headline}</p>
          </div>

          {data.activity.last7Days.some((point) => point.applications + point.events > 0) && (
            <div className="w-48 shrink-0">
              <p className="text-2xs uppercase tracking-wide text-muted">Last 7 days</p>
              <ActivitySparkline data={data.activity.last7Days} />
            </div>
          )}
        </div>
      </div>

      {/* ---- Key numbers ---- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Applications this week" value={summary.thisWeek} hint={`${summary.total} tracked in total`} tone="accent" icon={<Sparkles className="h-4 w-4" />} />
        <Stat label="Shortlisted" value={summary.shortlisted} tone="info" icon={<CheckCircle2 className="h-4 w-4" />} />
        <Stat label="Interviews" value={summary.interviews} tone="waiting" icon={<CalendarClock className="h-4 w-4" />} />
        <Stat label="Offers" value={summary.offers} tone="success" icon={<TrendingUp className="h-4 w-4" />} />
        <Stat label="Rejected" value={summary.rejected} tone="critical" icon={<AlertTriangle className="h-4 w-4" />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---- Attention ---- */}
        <div className="space-y-4 lg:col-span-2">
          <Card
            title="Needs your attention"
            description="Ordered by urgency, decided by MailOps"
            action={
              attention.length > 0 ? (
                <Link href="/notifications" className="text-2xs text-[color:var(--tone-accent)] hover:underline">
                  All notifications
                </Link>
              ) : undefined
            }
            flush
          >
            {!attention.length ? (
              <EmptyState
                icon={<CheckCircle2 className="h-6 w-6 text-[color:var(--tone-success)]" />}
                title="Nothing needs you right now"
                description="MailOps is watching your inbox and will surface anything that needs a decision."
              />
            ) : (
              <ul className="divide-y divide-[color:var(--surface-border)]">
                {attention.map((item, index) => (
                  <AttentionRow key={`${item.kind}-${item.applicationId ?? item.emailId ?? index}`} item={item} />
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Recent applications"
            action={
              <Link href="/applications" className="text-2xs text-[color:var(--tone-accent)] hover:underline">
                View all
              </Link>
            }
            flush
          >
            {!data.recentApplications.length ? (
              <EmptyState title="No applications tracked yet" description="MailOps creates records automatically from recruitment email." />
            ) : (
              <ul className="divide-y divide-[color:var(--surface-border)]">
                {data.recentApplications.map((application) => (
                  <li key={application.id}>
                    <Link
                      href={`/applications/${application.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[color:var(--surface-hover)]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{application.company}</p>
                        <p className="truncate text-2xs text-muted">{application.role}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <StatusBadge status={application.status} />
                        <span className="hidden text-2xs text-muted sm:inline">{formatDate(application.appliedDate, { year: undefined })}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-muted" />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Upcoming deadlines" flush>
            {!data.upcomingDeadlines.length ? (
              <EmptyState icon={<CalendarClock className="h-6 w-6" />} title="No deadlines tracked" description="Deadlines appear here only when an employer states one — MailOps never invents them." />
            ) : (
              <ul className="divide-y divide-[color:var(--surface-border)]">
                {data.upcomingDeadlines.map((deadline) => (
                  <li key={deadline.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{deadline.title}</p>
                      <Link href={`/applications/${deadline.applicationId}`} className="truncate text-2xs text-muted hover:underline">
                        {deadline.company} — {deadline.role}
                      </Link>
                    </div>
                    <div className="shrink-0 text-right">
                      <Badge tone={deadline.isOverdue ? "critical" : deadline.daysRemaining <= 2 ? "critical" : deadline.daysRemaining <= 7 ? "waiting" : "neutral"}>
                        {deadline.isOverdue
                          ? `overdue by ${Math.abs(deadline.daysRemaining)}d`
                          : deadline.daysRemaining === 0
                            ? "due today"
                            : `${deadline.daysRemaining}d left`}
                      </Badge>
                      <p className="mt-0.5 text-2xs text-muted">{formatDate(deadline.dueAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ---- Right column ---- */}
        <div className="space-y-4">
          <ScanStatusPanel />

          <Card title="Inbox cleanup" flush>
            <div className="px-4 py-3">
              {data.cleanup.totalProposed > 0 ? (
                <>
                  <p className="text-sm">
                    MailOps found <span className="font-semibold">{pluralize(data.cleanup.totalProposed, "email")}</span> you may not
                    want.
                  </p>
                  <ul className="mt-2 space-y-1 text-2xs text-muted">
                    {Object.entries(data.cleanup.byCategory).map(([category, count]) => (
                      <li key={category} className="flex items-center justify-between">
                        <span className="capitalize">{category.toLowerCase()}</span>
                        <span className="tabular-nums">{count}</span>
                      </li>
                    ))}
                  </ul>
                  {data.cleanup.protectedCount > 0 && (
                    <p className="mt-2 text-2xs text-[color:var(--tone-success)]">
                      {data.cleanup.protectedCount} protected email(s) were never proposed.
                    </p>
                  )}
                  <Link href="/cleanup" className="mt-3 inline-flex">
                    <Button size="sm" variant="secondary" icon={<Trash2 className="h-3.5 w-3.5" />}>
                      Review cleanup
                    </Button>
                  </Link>
                </>
              ) : (
                <p className="text-xs text-muted">Nothing to clean up. MailOps will propose items here as unwanted mail arrives.</p>
              )}
            </div>
          </Card>

          <Card
            title="Recent notifications"
            action={
              <Link href="/notifications" className="text-2xs text-[color:var(--tone-accent)] hover:underline">
                All
              </Link>
            }
            flush
          >
            <NotificationMiniList items={data.notifications.recent} />
          </Card>

          <Card title="Important emails" flush>
            {!data.importantEmails.length ? (
              <EmptyState icon={<Mail className="h-6 w-6" />} title="No important mail yet" />
            ) : (
              <ul className="divide-y divide-[color:var(--surface-border)]">
                {data.importantEmails.map((email) => (
                  <li key={email.id}>
                    <Link href={`/emails?emailId=${email.id}`} className="block px-4 py-2.5 hover:bg-[color:var(--surface-hover)]">
                      <p className="truncate text-xs font-medium">{email.subject ?? "(no subject)"}</p>
                      <p className="truncate text-2xs text-muted">
                        {email.fromName ?? email.fromEmail} · {formatRelative(email.receivedAt)}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {email.subCategory && <SubCategoryBadge subCategory={email.subCategory} />}
                        {email.applicationId && <Badge tone="neutral">linked</Badge>}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Performance" description="Out of all tracked applications">
            <ul className="space-y-2 text-xs">
              <li className="flex items-center justify-between">
                <span className="text-secondary">Shortlist rate</span>
                <span className="tabular-nums">{formatPercent(summary.total ? (summary.shortlisted / summary.total) * 100 : 0, 0)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-secondary">Interview rate</span>
                <span className="tabular-nums">{formatPercent(summary.total ? (summary.interviews / summary.total) * 100 : 0, 0)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-secondary">Offer rate</span>
                <span className="tabular-nums">{formatPercent(summary.total ? (summary.offers / summary.total) * 100 : 0, 0)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-secondary">Rejection rate</span>
                <span className="tabular-nums">{formatPercent(summary.total ? (summary.rejected / summary.total) * 100 : 0, 0)}</span>
              </li>
            </ul>
            <Link href="/analytics" className="mt-3 inline-flex text-2xs text-[color:var(--tone-accent)] hover:underline">
              Full analytics
            </Link>
          </Card>
        </div>
      </div>

      {scan.lastScanError && (
        <InlineAlert tone="waiting" title="MailOps could not finish its last scan">
          <span className="inline-flex items-start gap-1.5">
            <Inbox className="mt-0.5 h-3 w-3 shrink-0" />
            {scan.lastScanError}
          </span>
        </InlineAlert>
      )}
    </div>
  );
}

/** One row of the attention list, styled by the decision engine's severity. */
function AttentionRow({ item }: { item: AttentionItem }) {
  const tone =
    item.severity === "CRITICAL"
      ? "critical"
      : item.severity === "HIGH"
        ? "waiting"
        : item.severity === "MEDIUM"
          ? "info"
          : "neutral";

  const href = item.actionUrl ?? (item.applicationId ? `/applications/${item.applicationId}` : "/notifications");

  return (
    <li>
      <Link href={href} className="flex items-start gap-3 px-4 py-3 hover:bg-[color:var(--surface-hover)]">
        <span
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            tone === "critical" && "bg-[color:var(--tone-critical-bg)] text-[color:var(--tone-critical)]",
            tone === "waiting" && "bg-[color:var(--tone-waiting-bg)] text-[color:var(--tone-waiting)]",
            tone === "info" && "bg-[color:var(--tone-info-bg)] text-[color:var(--tone-info)]",
            tone === "neutral" && "bg-[color:var(--tone-neutral-bg)] text-[color:var(--tone-neutral)]",
          )}
        >
          {item.kind === "DEADLINE" || item.kind === "ACTION_REQUIRED" ? (
            <CalendarClock className="h-3.5 w-3.5" />
          ) : item.kind === "REVIEW" ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : item.kind === "REJECTION" ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : (
            <Bell className="h-3.5 w-3.5" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-[color:var(--content-primary)]">{item.headline}</p>
            <Badge tone={tone}>{item.severity.toLowerCase()}</Badge>
          </div>
          {item.detail && <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-secondary">{item.detail}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-3 text-2xs text-muted">
            {item.company && <span>{item.company}{item.role ? ` · ${item.role}` : ""}</span>}
            {item.deadline && <span className="text-[color:var(--tone-waiting)]">due {formatDate(item.deadline)}</span>}
            <span>{formatRelative(item.occurredAt)}</span>
          </div>
        </div>

        <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted" />
      </Link>
    </li>
  );
}
