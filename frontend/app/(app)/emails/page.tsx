"use client";

import { Suspense } from "react";
import { EmailsView, ReviewQueueHint } from "@/components/domain/email-list";
import { PageHeader } from "@/components/ui/data";
import { Skeleton } from "@/components/ui/primitives";
import { useEmailCounters } from "@/lib/hooks";

/** Emails page (spec #23). */
export default function EmailsPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Emails"
        description="Everything MailOps has read and understood, with the AI decision attached to each message."
      />
      <ReviewQueueHintWrapper />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <EmailsView />
      </Suspense>
    </div>
  );
}

function ReviewQueueHintWrapper() {
  const { data } = useEmailCounters();
  return <ReviewQueueHint count={data?.needsReview ?? 0} />;
}
