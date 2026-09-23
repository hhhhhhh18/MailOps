"use client";

import { useState } from "react";
import { CleanupView } from "@/components/domain/cleanup-review";
import { Card } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/data";
import { useCleanupSummary } from "@/lib/hooks";

/** Inbox cleanup (spec #18, #19). */
export default function CleanupPage() {
  const [page, setPage] = useState(1);
  const { data: summary } = useCleanupSummary();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inbox cleanup"
        description="MailOps groups unwanted mail so you can clear it in one pass — with your approval, never silently."
      />

      {summary && summary.bySender.length > 0 && (
        <Card title="Noisiest senders" description="Senders responsible for most of the unwanted mail">
          <ul className="space-y-1.5">
            {summary.bySender.slice(0, 6).map((sender) => (
              <li key={sender.sender ?? "unknown"} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-secondary">{sender.sender ?? "Unknown sender"}</span>
                <span className="shrink-0 tabular-nums text-muted">{sender.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <CleanupView page={page} onPageChange={setPage} />
    </div>
  );
}
