"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, EmptyState, InlineAlert, Input, Skeleton } from "@/components/ui/primitives";
import { DataTable, PageHeader, Pagination, type Column } from "@/components/ui/data";
import { Modal } from "@/components/ui/feedback";
import { useRejectedApplications } from "@/lib/hooks";
import { formatDate, formatDateTime, formatRelative } from "@/lib/utils";
import type { RejectedApplication } from "@/lib/types";

/**
 * Rejected applications (spec #22).
 *
 * The important guarantee this page demonstrates: the rejection record survives
 * the deletion of the original Gmail message. The UI states plainly when a
 * message has been removed, and still shows the structured record.
 */
export default function RejectedPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useRejectedApplications({
    page,
    pageSize: 25,
    search: search.trim() || undefined,
  });

  const open = data?.items.find((item) => item.id === openId) ?? null;

  const columns: Column<RejectedApplication>[] = [
    {
      key: "company",
      header: "Company",
      cell: (row) => (
        <div className="min-w-0">
          <Link href={`/applications/${row.id}`} className="block truncate font-medium hover:underline">
            {row.company}
          </Link>
          <p className="truncate text-2xs text-muted">{row.role}</p>
        </div>
      ),
    },
    {
      key: "applied",
      header: "Applied",
      hideBelow: "hidden md:table-cell",
      cell: (row) => <span className="whitespace-nowrap text-secondary">{formatDate(row.appliedDate)}</span>,
    },
    {
      key: "rejected",
      header: "Rejected",
      cell: (row) => <span className="whitespace-nowrap text-[color:var(--tone-critical)]">{formatDate(row.rejectedDate)}</span>,
    },
    {
      key: "jobId",
      header: "Job ID",
      hideBelow: "hidden lg:table-cell",
      cell: (row) => <span className="font-mono text-2xs text-muted">{row.jobId ?? "—"}</span>,
    },
    {
      key: "email",
      header: "Original email",
      cell: (row) =>
        row.originalEmail ? (
          <Button size="sm" variant="ghost" onClick={() => setOpenId(row.id)}>
            <Mail className="h-3.5 w-3.5" /> View record
          </Button>
        ) : (
          <span className="text-2xs text-muted">Not available</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Rejected applications"
        description="Closed applications are kept permanently, even after the original email is deleted."
      />

      <InlineAlert tone="info" title="History outlives your inbox">
        Deleting an email never deletes the structured application record. This is what lets you see patterns in your search —
        which companies reject, how long they take, and what to change.
      </InlineAlert>

      <Card
        flush
        title="Closed applications"
        description={data ? `${data.meta.total} record${data.meta.total === 1 ? "" : "s"}` : undefined}
        action={
          <div className="relative w-52">
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search company or role"
              className="h-8 py-0 text-xs"
              aria-label="Search rejected applications"
            />
          </div>
        }
      >
        {isError ? (
          <EmptyState
            title="Could not load rejected applications"
            description={error instanceof Error ? error.message : undefined}
            action={
              <Button size="sm" variant="secondary" onClick={() => refetch()}>
                Try again
              </Button>
            }
          />
        ) : isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={data?.items ?? []}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                icon={<ShieldCheck className="h-6 w-6" />}
                title="No rejections recorded"
                description="Hopefully it stays that way. MailOps will file rejections here automatically when they arrive."
              />
            }
          />
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>

      <Modal
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open?.originalEmail?.subject ?? "Rejection record"}
        description={open ? `${open.company} — ${open.role}` : undefined}
        size="md"
      >
        {open && (
          <div className="space-y-4 text-xs">
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Applied">{formatDate(open.appliedDate)}</Field>
              <Field label="Rejected">{formatDate(open.rejectedDate)}</Field>
              <Field label="Job ID">{open.jobId ?? "—"}</Field>
              <Field label="Location">{open.location ?? "—"}</Field>
            </dl>

            {open.rejectionEvent && (
              <section>
                <h3 className="text-xs font-semibold">Recorded event</h3>
                <p className="mt-1 text-secondary">{open.rejectionEvent.title}</p>
                {open.rejectionEvent.description && <p className="mt-1 text-muted">{open.rejectionEvent.description}</p>}
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge tone="neutral">{formatDateTime(open.rejectionEvent.occurredAt)}</Badge>
                  {open.rejectionEvent.confidence !== null && (
                    <Badge tone="neutral">{Math.round(open.rejectionEvent.confidence * 100)}% confidence</Badge>
                  )}
                </div>
              </section>
            )}

            {open.originalEmail ? (
              <section>
                <h3 className="text-xs font-semibold">Original email</h3>
                <p className="mt-1 text-muted">
                  {open.originalEmail.fromEmail} · {formatRelative(open.originalEmail.receivedAt)}
                </p>
                {open.originalEmail.deletedFromGmail && (
                  <Badge tone="waiting" className="mt-2">
                    Removed from Gmail — record retained
                  </Badge>
                )}
                <div className="mt-2 rounded-lg bg-[color:var(--surface-overlay)] p-3">
                  <p className="text-secondary">{open.originalEmail.snippet ?? "No preview available."}</p>
                </div>
              </section>
            ) : (
              <InlineAlert tone="neutral" title="Original email no longer stored">
                The structured record is intact — only the message content is gone.
              </InlineAlert>
            )}

            <Link href={`/applications/${open.id}`} className="inline-flex text-[color:var(--tone-accent)] hover:underline">
              Open the full application timeline
            </Link>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
