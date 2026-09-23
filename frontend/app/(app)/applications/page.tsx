"use client";

import { ApplicationTable, StatusDistribution } from "@/components/domain/application-table";
import { PageHeader } from "@/components/ui/data";
import { Card, Stat } from "@/components/ui/primitives";
import { useApplicationSummary } from "@/lib/hooks";
import { formatPercent } from "@/lib/utils";

/** Applications dashboard (spec #21). */
export default function ApplicationsPage() {
  const { data: summary } = useApplicationSummary();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Applications"
        description="Every application MailOps has tracked, with its current stage and latest activity."
      />

      {summary && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Total tracked" value={summary.total} hint={`${summary.thisWeek} this week`} tone="accent" />
            <Stat label="In progress" value={summary.active} tone="info" />
            <Stat label="Interviews" value={summary.interviews} tone="waiting" />
            <Stat label="Offers" value={summary.offers} tone="success" />
            <Stat label="Rejected" value={summary.rejected} tone="critical" />
          </div>

          <Card title="Status distribution" description={`Applied ${summary.thisMonth} time(s) this month · offer rate ${formatPercent(summary.total ? (summary.offers / summary.total) * 100 : 0, 1)}`}>
            <StatusDistribution byStatus={summary.byStatus} />
          </Card>
        </>
      )}

      <ApplicationTable />
    </div>
  );
}
