"use client";

import { useState } from "react";
import { Bot, ScrollText, ShieldCheck, User } from "lucide-react";
import { Badge, Button, Card, EmptyState, Select, Skeleton } from "@/components/ui/primitives";
import { PageHeader, Pagination } from "@/components/ui/data";
import { useAuditLog } from "@/lib/hooks";
import { cn, formatDateTime, formatRelative } from "@/lib/utils";
import type { AuditLogRecord } from "@/lib/types";

/**
 * Audit log (spec #41).
 *
 * The trust surface for an autonomous agent: every automated action, in order,
 * with the actor labelled. When a user asks "why did MailOps do that?", this page
 * is the answer.
 */

const ACTOR_ICON = {
  AI: Bot,
  SYSTEM: ShieldCheck,
  USER: User,
} as const;

const ACTOR_TONE = {
  AI: "accent",
  SYSTEM: "info",
  USER: "neutral",
} as const;

/** Groups actions into readable families for the filter dropdown. */
const ACTION_GROUPS = [
  { value: "", label: "All actions" },
  { value: "email.", label: "Email processing" },
  { value: "application.", label: "Applications" },
  { value: "gmail.", label: "Gmail scanning" },
  { value: "notification.", label: "Notifications" },
  { value: "cleanup.", label: "Cleanup" },
  { value: "settings.", label: "Settings" },
  { value: "privacy.", label: "Privacy" },
  { value: "user.", label: "Account" },
];

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [actor, setActor] = useState("");
  const [actionPrefix, setActionPrefix] = useState("");

  const { data, isLoading, isError } = useAuditLog({
    page,
    pageSize: 50,
    ...(actor ? { actor } : {}),
    ...(actionPrefix ? { action: actionPrefix } : {}),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit log"
        description="Every automated action MailOps took on your behalf, and why."
      />

      <Card
        flush
        title="Activity"
        description={data ? `${data.meta.total} recorded action${data.meta.total === 1 ? "" : "s"}` : undefined}
        action={
          <div className="flex items-center gap-2">
            <Select
              value={actionPrefix}
              onChange={(event) => {
                setActionPrefix(event.target.value);
                setPage(1);
              }}
              className="h-8 w-44 py-0 text-xs"
              aria-label="Filter by action family"
            >
              {ACTION_GROUPS.map((group) => (
                <option key={group.value} value={group.value}>
                  {group.label}
                </option>
              ))}
            </Select>
            <Select
              value={actor}
              onChange={(event) => {
                setActor(event.target.value);
                setPage(1);
              }}
              className="h-8 w-32 py-0 text-xs"
              aria-label="Filter by actor"
            >
              <option value="">Anyone</option>
              <option value="AI">MailOps AI</option>
              <option value="SYSTEM">System</option>
              <option value="USER">You</option>
            </Select>
          </div>
        }
      >
        {isError ? (
          <EmptyState
            title="Could not load the audit log"
            description="This is a display problem — no data has been lost."
            action={
              <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
                Reload
              </Button>
            }
          />
        ) : isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            icon={<ScrollText className="h-6 w-6" />}
            title="No actions recorded yet"
            description="Once MailOps starts processing your inbox, every decision it makes will be listed here."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--surface-border)]">
            {data.items.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditLogRecord }) {
  const Icon = ACTOR_ICON[entry.actor] ?? ShieldCheck;
  const tone = ACTOR_TONE[entry.actor] ?? "neutral";

  // Surface the most useful metadata fields without dumping the whole blob.
  const metadata = entry.metadata ?? {};
  const highlights: Array<[string, string]> = [];
  for (const key of ["confidence", "fromStatus", "toStatus", "status", "channel", "provider", "batchId", "count", "executed"]) {
    const value = (metadata as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && value !== "") {
      highlights.push([key, typeof value === "number" ? String(value) : String(value)]);
    }
  }

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          tone === "accent" && "bg-[color:var(--tone-accent-bg)] text-[color:var(--tone-accent)]",
          tone === "info" && "bg-[color:var(--tone-info-bg)] text-[color:var(--tone-info)]",
          tone === "neutral" && "bg-[color:var(--tone-neutral-bg)] text-[color:var(--tone-neutral)]",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium text-[color:var(--content-primary)]">{entry.summary ?? entry.action}</p>
          <Badge tone={tone}>{entry.actor === "AI" ? "MailOps AI" : entry.actor.toLowerCase()}</Badge>
        </div>

        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-2xs text-muted">
          <span className="font-mono">{entry.action}</span>
          {entry.entityType && <span>{entry.entityType}</span>}
          <span title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</span>
        </div>

        {highlights.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted">
            {highlights.map(([key, value]) => (
              <span key={key}>
                {key}: <span className="text-secondary">{value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
