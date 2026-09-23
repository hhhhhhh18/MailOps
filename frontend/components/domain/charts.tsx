"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, EmptyState } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { AnalyticsOverview } from "@/lib/types";

/**
 * Charts.
 *
 * Clean and readable rather than decorative: no gradients on data, one colour per
 * meaningful series, and gridlines only where they help read a value. Status
 * colours match the rest of the app so the same hue means the same thing
 * everywhere.
 */

const COLORS = {
  applications: "#818cf8",
  responses: "#60a5fa",
  interviews: "#fbbf24",
  offers: "#34d399",
  rejections: "#f87171",
  neutral: "#6b7480",
};

const AXIS = {
  stroke: "#39414d",
  tick: { fill: "#6b7480", fontSize: 11 },
};

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[color:var(--surface-border)] bg-[color:var(--surface-overlay)] px-3 py-2 text-xs shadow-popover">
      <p className="mb-1 font-medium text-[color:var(--content-primary)]">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center justify-between gap-4 tabular-nums" style={{ color: entry.color }}>
          <span className="text-secondary">{entry.name}</span>
          <span>{entry.value}</span>
        </p>
      ))}
    </div>
  );
}

/** Applications over time, with responses and interviews overlaid. */
export function ActivityChart({
  data,
  granularity = "week",
  title = "Application activity",
}: {
  data: AnalyticsOverview["weeklyActivity"];
  granularity?: "week" | "month";
  title?: string;
}) {
  const hasData = data.some((point) => point.applications + point.responses + point.interviews > 0);

  return (
    <Card title={title} description={granularity === "week" ? "Last 12 weeks" : "Last 6 months"} bodyClassName="p-2 pt-4">
      {!hasData ? (
        <EmptyState title="No activity yet" description="Charts fill in as MailOps processes recruitment email." className="py-10" />
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -18 }}>
              <defs>
                <linearGradient id="fillApplications" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.applications} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={COLORS.applications} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={AXIS.stroke} vertical={false} />
              <XAxis dataKey="label" tick={AXIS.tick} stroke={AXIS.stroke} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS.tick} stroke={AXIS.stroke} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#9aa4b2" }} iconType="circle" iconSize={7} />
              <Area
                type="monotone"
                dataKey="applications"
                name="Applications"
                stroke={COLORS.applications}
                strokeWidth={2}
                fill="url(#fillApplications)"
              />
              <Line type="monotone" dataKey="responses" name="Responses" stroke={COLORS.responses} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="interviews" name="Interviews" stroke={COLORS.interviews} strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/** Funnel: how many applications reached each stage. */
export function FunnelChart({ funnel }: { funnel: AnalyticsOverview["funnel"] }) {
  const data = funnel.filter((step) => step.count > 0);
  const max = Math.max(...data.map((step) => step.count), 1);

  const toneFor = (status: string) =>
    status === "OFFER" || status === "ACCEPTED"
      ? COLORS.offers
      : status === "REJECTED"
        ? COLORS.rejections
        : status === "INTERVIEW" || status === "ASSESSMENT" || status === "FINAL_ROUND"
          ? COLORS.interviews
          : COLORS.applications;

  return (
    <Card title="Pipeline" description="Applications by current stage" bodyClassName="p-4">
      {!data.length ? (
        <EmptyState title="No applications yet" className="py-10" />
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={AXIS.stroke} horizontal={false} />
              <XAxis type="number" tick={AXIS.tick} stroke={AXIS.stroke} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="label"
                tick={AXIS.tick}
                stroke={AXIS.stroke}
                tickLine={false}
                axisLine={false}
                width={92}
              />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="count" name="Applications" radius={[0, 4, 4, 0]} maxBarSize={22}>
                {data.map((step) => (
                  <Cell key={step.status} fill={toneFor(step.status)} opacity={0.35 + (step.count / max) * 0.65} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/** Applications by company with outcome breakdown. */
export function CompanyChart({ byCompany }: { byCompany: AnalyticsOverview["byCompany"] }) {
  return (
    <Card title="Where you are applying" description="Top companies by application volume" bodyClassName="p-4">
      {!byCompany.length ? (
        <EmptyState title="No applications yet" className="py-10" />
      ) : (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byCompany} margin={{ top: 4, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={AXIS.stroke} vertical={false} />
              <XAxis dataKey="company" tick={{ ...AXIS.tick, fontSize: 10 }} stroke={AXIS.stroke} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={64} />
              <YAxis tick={AXIS.tick} stroke={AXIS.stroke} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#9aa4b2" }} iconType="circle" iconSize={7} />
              <Bar dataKey="total" name="Applications" stackId="a" fill={COLORS.applications} maxBarSize={28} />
              <Bar dataKey="interviews" name="Interviews" stackId="a" fill={COLORS.interviews} maxBarSize={28} />
              <Bar dataKey="offers" name="Offers" stackId="a" fill={COLORS.offers} maxBarSize={28} />
              <Bar dataKey="rejections" name="Rejections" stackId="a" fill={COLORS.rejections} maxBarSize={28} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/** Rate tiles rendered as horizontal bars — readable without a chart library. */
export function RateBreakdown({ rates }: { rates: AnalyticsOverview["rates"] }) {
  const rows: Array<{ label: string; value: number; color: string }> = [
    { label: "Response rate", value: rates.responseRate, color: COLORS.responses },
    { label: "Shortlist rate", value: rates.shortlistRate, color: COLORS.applications },
    { label: "Assessment rate", value: rates.assessmentRate, color: COLORS.interviews },
    { label: "Interview rate", value: rates.interviewRate, color: COLORS.interviews },
    { label: "Offer rate", value: rates.offerRate, color: COLORS.offers },
    { label: "Rejection rate", value: rates.rejectionRate, color: COLORS.rejections },
  ];

  return (
    <Card title="Conversion rates" description="Share of all applications that reached each stage">
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.label}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-secondary">{row.label}</span>
              <span className="tabular-nums text-[color:var(--content-primary)]">{row.value.toFixed(1)}%</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--surface-overlay)]">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, row.value)}%`, backgroundColor: row.color }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Inbox composition — what MailOps saw, split by category. */
export function InboxBreakdownChart({ data }: { data: AnalyticsOverview["inboxBreakdown"] }) {
  const total = data.reduce((sum, item) => sum + item.count, 0);
  if (!total) return null;

  const toneFor = (category: string) =>
    category === "JOB"
      ? COLORS.applications
      : category === "SPAM"
        ? COLORS.rejections
        : category === "PROMOTIONAL" || category === "NEWSLETTER"
          ? COLORS.neutral
          : COLORS.responses;

  return (
    <Card title="What MailOps saw in your inbox" description={`${total} processed emails across all categories`}>
      <div className="flex h-2 overflow-hidden rounded-full bg-[color:var(--surface-overlay)]">
        {data.map((item) => (
          <div
            key={item.category}
            style={{ width: `${(item.count / total) * 100}%`, backgroundColor: toneFor(item.category) }}
            title={`${item.category}: ${item.count}`}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {data.map((item) => (
          <li key={item.category} className="flex items-center justify-between text-2xs">
            <span className="inline-flex items-center gap-1.5 text-secondary">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: toneFor(item.category) }} />
              {item.category.toLowerCase()}
            </span>
            <span className="tabular-nums text-muted">{item.count}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Response-time comparison — "who responds fastest". */
export function ResponseTimeChart({ data }: { data: AnalyticsOverview["responseTimeByCompany"] }) {
  if (!data.length) return null;

  return (
    <Card title="Average response time" description="How long employers take to reply, in days" bodyClassName="p-4">
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={AXIS.stroke} horizontal={false} />
            <XAxis type="number" tick={AXIS.tick} stroke={AXIS.stroke} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="company" tick={AXIS.tick} stroke={AXIS.stroke} tickLine={false} axisLine={false} width={96} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="averageDays" name="Avg days" fill={COLORS.responses} radius={[0, 4, 4, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/** Sparkline used inside the dashboard "this week" card. */
export function ActivitySparkline({ data, className }: { data: Array<{ date: string; applications: number; events: number }>; className?: string }) {
  return (
    <div className={cn("h-16 w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <XAxis dataKey="date" hide />
          <YAxis hide />
          <Tooltip content={<ChartTooltip />} />
          <Line type="monotone" dataKey="applications" name="Applications" stroke={COLORS.applications} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="events" name="Updates" stroke={COLORS.interviews} strokeWidth={1.5} dot={false} strokeDasharray="3 3" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
