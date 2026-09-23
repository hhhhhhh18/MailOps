"use client";

import { useMemo, useState } from "react";
import { Archive, CheckSquare, Inbox, ShieldCheck, Square, Trash2, Undo2, X } from "lucide-react";
import { Badge, Button, Card, EmptyState, InlineAlert, Skeleton, Stat } from "@/components/ui/primitives";
import { FilterChips, Pagination } from "@/components/ui/data";
import { ConfirmDialog } from "@/components/ui/feedback";
import { CategoryBadge, CleanupStatusBadge } from "./badges";
import { useApproveCleanup, useCleanupProposals, useCleanupSummary, useRevertCleanup } from "@/lib/hooks";
import { cn, formatDate, formatRelative } from "@/lib/utils";
import type { CleanupAction } from "@/lib/types";

/**
 * Cleanup review (spec #18, #19).
 *
 * The product rule this screen exists to honour: MailOps never deletes anything
 * by itself. It proposes, the user selects, the user approves — and the server
 * re-checks every protection rule before touching Gmail, so a bug here can not
 * become data loss there.
 */

const STATUS_FILTERS = [
  { value: "PROPOSED", label: "Awaiting approval" },
  { value: "EXECUTED", label: "Cleaned up" },
  { value: "BLOCKED", label: "Blocked by protection" },
  { value: "FAILED", label: "Failed" },
  { value: "SKIPPED", label: "Kept" },
];

export function CleanupView({ page, onPageChange }: { page: number; onPageChange: (page: number) => void }) {
  const [status, setStatus] = useState("PROPOSED");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<"DELETE" | "ARCHIVE" | "KEEP" | "IGNORE_SENDER" | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const { data: summary } = useCleanupSummary();
  const { data, isLoading } = useCleanupProposals({ page, pageSize: 50, status });

  const approve = useApproveCleanup({
    onSuccess: (result) => {
      setSelected(new Set());
      setPendingAction(null);
      setResultMessage(result.message);
    },
  });

  const items = data?.items ?? [];
  const selectable = items.filter((item) => item.status === "PROPOSED" && item.email);
  const selectedEmails = useMemo(() => Array.from(selected), [selected]);
  const selectedItems = items.filter((item) => item.email && selected.has(item.email.id));

  const toggle = (emailId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(emailId)) next.delete(emailId);
      else next.add(emailId);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === selectable.length && selectable.length > 0) setSelected(new Set());
    else setSelected(new Set(selectable.map((item) => item.email!.id)));
  };

  const blockedCount = summary?.protectedCount ?? 0;

  return (
    <div className="space-y-4">
      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Awaiting approval" value={summary.totalProposed} tone="waiting" />
          <Stat label="Promotional" value={summary.byCategory.PROMOTIONAL ?? 0} />
          <Stat label="Spam" value={summary.byCategory.SPAM ?? 0} tone="critical" />
          <Stat label="Cleaned up" value={summary.executedCount} tone="success" />
        </div>
      )}

      <InlineAlert tone="info" title="Nothing is deleted without your approval">
        MailOps groups unwanted mail into a review queue. Job, personal, financial and government email is protected
        server-side and can never be included in a cleanup batch, even if you select it.
      </InlineAlert>

      {blockedCount > 0 && (
        <InlineAlert tone="success" title={`${blockedCount} protected email${blockedCount === 1 ? "" : "s"} kept safe`}>
          These were flagged as cleanup candidates but blocked by a protection rule. Review them under
          <span className="ml-1 font-medium">Blocked by protection</span> if you want to understand why.
        </InlineAlert>
      )}

      {resultMessage && (
        <InlineAlert tone="success" title="Cleanup completed" action={<Button size="sm" variant="ghost" onClick={() => setResultMessage(null)}><X className="h-3.5 w-3.5" /></Button>}>
          {resultMessage}
        </InlineAlert>
      )}

      <Card
        flush
        title="Cleanup queue"
        description="Select the messages you want MailOps to clear, then choose an action."
        action={
          selectable.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={toggleAll} icon={<CheckSquare className="h-3.5 w-3.5" />}>
              {selected.size === selectable.length ? "Clear selection" : "Select all"}
            </Button>
          ) : undefined
        }
      >
        <div className="border-b border-[color:var(--surface-border)] px-4 py-3">
          <FilterChips options={STATUS_FILTERS} value={status} onChange={(value) => { setStatus(value); onPageChange(1); setSelected(new Set()); }} />
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : !items.length ? (
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title="Nothing waiting for cleanup"
            description="MailOps has not found unwanted mail in this state. Run a scan or check another filter."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--surface-border)]">
            {items.map((item) => (
              <CleanupRow
                key={item.id}
                item={item}
                selected={item.email ? selected.has(item.email.id) : false}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}

        <Pagination meta={data?.meta} onPageChange={onPageChange} />
      </Card>

      {/* Sticky action bar */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-card border border-[color:var(--surface-border)] bg-[color:var(--surface-overlay)] px-4 py-3 shadow-popover">
          <div className="flex items-center gap-2 text-xs">
            <Badge tone="accent">{selected.size} selected</Badge>
            <span className="text-muted">
              {selectedItems.filter((item) => item.category === "SPAM").length} spam ·{" "}
              {selectedItems.filter((item) => item.category === "PROMOTIONAL").length} promotional
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPendingAction("KEEP")}>
              <CheckSquare className="h-3.5 w-3.5" /> Keep
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingAction("IGNORE_SENDER")} icon={<ShieldCheck className="h-3.5 w-3.5" />}>
              Ignore sender
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setPendingAction("ARCHIVE")} icon={<Archive className="h-3.5 w-3.5" />}>
              Archive
            </Button>
            <Button size="sm" variant="danger" onClick={() => setPendingAction("DELETE")} icon={<Trash2 className="h-3.5 w-3.5" />}>
              Move to Trash
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={() => {
          if (!pendingAction) return;
          approve.mutate({ emailIds: selectedEmails, action: pendingAction });
        }}
        loading={approve.isPending}
        variant={pendingAction === "DELETE" ? "danger" : "primary"}
        title={
          pendingAction === "DELETE"
            ? "Move these messages to Trash?"
            : pendingAction === "ARCHIVE"
              ? "Archive these messages?"
              : pendingAction === "IGNORE_SENDER"
                ? "Ignore these senders?"
                : "Keep these messages?"
        }
        confirmLabel={
          pendingAction === "DELETE"
            ? "Move to Trash"
            : pendingAction === "ARCHIVE"
              ? "Archive"
              : pendingAction === "IGNORE_SENDER"
                ? "Ignore senders"
                : "Keep"
        }
        description={
          <div className="space-y-2">
            <p>
              {pendingAction === "DELETE"
                ? `${selected.size} message${selected.size === 1 ? "" : "s"} will be moved to Gmail's Trash. They stay recoverable in Gmail for 30 days.`
                : pendingAction === "ARCHIVE"
                  ? `${selected.size} message${selected.size === 1 ? "" : "s"} will be archived — removed from your inbox but still searchable in All Mail.`
                  : pendingAction === "IGNORE_SENDER"
                    ? `MailOps will label these messages and ignore future mail from the same senders. Nothing is deleted.`
                    : `Nothing will be removed from Gmail. These messages will be marked as kept.`}
            </p>
            <p className="text-muted">
              Every automated action is written to your audit log, and you can revert archive/trash actions from the Cleanup
              history.
            </p>
          </div>
        }
      />
    </div>
  );
}

function CleanupRow({
  item,
  selected,
  onToggle,
}: {
  item: CleanupAction;
  selected: boolean;
  onToggle: (emailId: string) => void;
}) {
  const revert = useRevertCleanup();
  const email = item.email;
  const selectable = item.status === "PROPOSED" && Boolean(email);

  return (
    <li className={cn("flex items-start gap-3 px-4 py-3", selected && "bg-[color:var(--tone-accent-bg)]")}>
      <button
        type="button"
        disabled={!selectable}
        onClick={() => email && onToggle(email.id)}
        aria-label={selected ? "Deselect" : "Select"}
        className={cn("mt-0.5 shrink-0 text-muted disabled:opacity-30", selectable && "hover:text-[color:var(--content-primary)]")}
      >
        {selected ? <CheckSquare className="h-4 w-4 text-[color:var(--tone-accent)]" /> : <Square className="h-4 w-4" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.category && <CategoryBadge category={item.category} />}
          <CleanupStatusBadge status={item.status} />
          {item.protectedReason && <Badge tone="critical">Protected</Badge>}
        </div>

        <p className="mt-1 truncate text-sm">{email?.subject ?? "(email record removed)"}</p>
        <p className="truncate text-2xs text-muted">
          {email?.fromName ?? item.senderEmail ?? "Unknown sender"} · {email ? formatRelative(email.receivedAt) : formatDate(item.createdAt)}
        </p>

        {item.reason && <p className="mt-1 text-2xs text-muted">{item.reason}</p>}
        {item.protectedReason && <p className="mt-1 text-2xs text-[color:var(--tone-critical)]">{item.protectedReason}</p>}
        {item.error && <p className="mt-1 text-2xs text-[color:var(--tone-critical)]">{item.error}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {item.status === "EXECUTED" && (
          <Button size="sm" variant="ghost" onClick={() => revert.mutate(item.id)} loading={revert.isPending} title="Restore this message">
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </Button>
        )}
      </div>
    </li>
  );
}
