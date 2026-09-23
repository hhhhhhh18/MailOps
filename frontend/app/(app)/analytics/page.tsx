"use client";

import { useEffect, useState } from "react";
import { ActivityChart, CompanyChart, FunnelChart, InboxBreakdownChart, RateBreakdown, ResponseTimeChart } from "@/components/domain/charts";
import { Card, EmptyState, Select, Skeleton, Stat } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/data";
import { useAnalytics } from "@/lib/hooks";
import { formatDuration, formatPercent } from "@/lib/utils";

/**
 * Analytics (spec #25, #49).
 *
 * Metrics are grouped as "how am I doing" (rates), "how fast" (timings) and "where"
 * (companies/roles), because those are the three questions a job seeker actually
 * asks of this data.
 */
export default function AnalyticsPage() {
  const [weeks, setWeeks] = useState(12);
  const { data, isLoading, isError } = useAnalytics(weeks);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <EmptyState title="Could not load analytics" description="Your application data is safe — this is a display problem. Try reloading." />
      </Card>
    );
  }

  const hasData = data.totals.applications > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description="How your search is actually performing, calculated from your tracked applications."
        actions={
          <Select value={String(weeks)} onChange={(event) => setWeeks(Number(event.target.value))} className="h-9 w-40">
            <option value="4">Last 4 weeks</option>
            <option value="12">Last 12 weeks</option>
            <option value="26">Last 6 months</option>
            <option value="52">Last 12 months</option>
          </Select>
        }
      />

      {!hasData ? (
        <Card>
          <EmptyState
            title="No data to analyse yet"
            description="Once MailOps has processed a few recruitment emails, your conversion rates and timings will appear here."
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Applications" value={data.totals.applications} hint={`${data.totals.thisMonth} this month`} tone="accent" />
            <Stat label="Employer responses" value={data.totals.responses} hint={formatPercent(data.rates.responseRate, 1)} tone="info" />
            <Stat
              label="Avg. response time"
              value={data.timings.averageResponseDays === null ? "—" : `${data.timings.averageResponseDays}d`}
              hint={data.timings.medianResponseDays !== null ? `median ${data.timings.medianResponseDays}d` : undefined}
              tone="waiting"
            />
            <Stat
              label="Avg. application → interview"
              value={data.timings.averageApplicationToInterviewDays === null ? "—" : `${data.timings.averageApplicationToInterviewDays}d`}
              tone="success"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ActivityChart data={data.weeklyActivity} title="Activity by week" />
            <FunnelChart funnel={data.funnel} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <RateBreakdown rates={data.rates} />
            <CompanyChart byCompany={data.byCompany} />
            <div className="space-y-4">
              <InboxBreakdownChart data={data.inboxBreakdown} />
              <ResponseTimeChart data={data.responseTimeByCompany} />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ActivityChart data={data.monthlyActivity} granularity="month" title="Activity by month" />

            <Card title="Application intelligence" description="Operational detail from the MailOps pipeline">
              <dl className="space-y-2.5 text-xs">
                <Row label="Notifications sent" value={data.notificationStats.sent} />
                <Row label="Acknowledged by you" value={data.notificationStats.acknowledged} />
                <Row label="Escalated to another channel" value={data.notificationStats.escalated} />
                <Row
                  label="Average time to acknowledge"
                  value={
                    data.notificationStats.avgAcknowledgementMinutes === null
                      ? "—"
                      : formatDuration(data.notificationStats.avgAcknowledgementMinutes * 60_000)
                  }
                />
                <Row label="Cleanup proposals" value={data.cleanupImpact.proposed} />
                <Row label="Cleanup actions executed" value={data.cleanupImpact.executed} />
                <Row label="Emails awaiting your review" value={data.totals.needsReview} />
              </dl>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Most common roles" description="Where you are concentrating your applications">
              <ul className="space-y-2">
                {data.byRole.map((row) => (
                  <li key={row.role} className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate text-secondary">{row.role}</span>
                    <span className="shrink-0 tabular-nums text-muted">{row.total}</span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Company outcomes" description="Where your applications actually progress">
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th className="text-right">Apps</th>
                      <th className="text-right">Interviews</th>
                      <th className="text-right">Offers</th>
                      <th className="text-right">Rejections</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCompany.map((row) => (
                      <tr key={row.company}>
                        <td className="font-medium">{row.company}</td>
                        <td className="text-right tabular-nums">{row.total}</td>
                        <td className="text-right tabular-nums text-[color:var(--tone-waiting)]">{row.interviews}</td>
                        <td className="text-right tabular-nums text-[color:var(--tone-success)]">{row.offers}</td>
                        <td className="text-right tabular-nums text-[color:var(--tone-critical)]">{row.rejections}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums text-[color:var(--content-primary)]">{value}</dd>
    </div>
  );
}
