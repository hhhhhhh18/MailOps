"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Bot, Inbox, Link2, Sparkles } from "lucide-react";
import { Card, Badge, Button, EmptyState, InlineAlert, Select, Skeleton } from "@/components/ui/primitives";
import { DataTable, FilterChips, Pagination, type Column } from "@/components/ui/data";
import { Modal } from "@/components/ui/feedback";
import { CategoryBadge, ConfidenceMeter, PriorityBadge, ProcessingBadge, StatusBadge, SubCategoryBadge } from "./badges";
import { useEmail, useEmailCounters, useEmails, useOverrideEmailAnalysis, useReprocessEmail, useResolveReview, type EmailFilters } from "@/lib/hooks";
import { CATEGORY_LABELS, STATUS_LABELS, cn, formatDateTime, formatRelative, truncate } from "@/lib/utils";
import type { EmailCounters, EmailRecord, JobSubCategory } from "@/lib/types";

/**
 * Emails page (spec #23) with the AI analysis drawer (spec #24).
 *
 * The drawer is the trust surface: it shows what MailOps understood, why it
 * decided that, and gives the user a one-click way to correct it. Raw model
 * output is never shown — only the short, user-facing rationale.
 */

const TABS: Array<{ value: EmailFilters["tab"] & string; label: string; counterKey: keyof EmailCounters | null }> = [
  { value: "all", label: "All", counterKey: "all" },
  { value: "important", label: "Important", counterKey: "important" },
  { value: "jobs", label: "Jobs", counterKey: "jobs" },
  { value: "needs_review", label: "Needs review", counterKey: "needsReview" },
  { value: "promotional", label: "Promotional", counterKey: "promotional" },
  { value: "spam", label: "Spam", counterKey: "spam" },
  { value: "newsletters", label: "Newsletters", counterKey: "newsletters" },
  { value: "rejected", label: "Rejected", counterKey: "rejected" },
];

export function EmailsView() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<string>(searchParams.get("tab") ?? "all");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<EmailFilters["sortBy"]>("receivedAt");
  const [openEmailId, setOpenEmailId] = useState<string | null>(searchParams.get("emailId"));

  const { data: counters } = useEmailCounters();
  const { data, isLoading, isError, error, refetch } = useEmails({
    page,
    pageSize: 25,
    tab: tab as EmailFilters["tab"],
    sortBy,
    sortDir: "desc",
  });

  const chips = TABS.map((entry) => ({
    value: entry.value,
    label: entry.label,
    count: entry.counterKey && counters ? (counters[entry.counterKey] as number) : undefined,
  }));

  const columns: Column<EmailRecord>[] = [
    {
      key: "subject",
      header: "Email",
      cell: (row) => (
        <div className="min-w-0">
          <p className={cn("truncate text-sm", row.isImportant ? "font-medium" : "text-secondary")}>
            {row.deletedFromGmail && <span className="mr-1.5 text-2xs text-muted">[deleted]</span>}
            {row.subject ?? "(no subject)"}
          </p>
          <p className="truncate text-2xs text-muted">
            {row.fromName ?? row.fromEmail ?? "Unknown sender"} · {formatRelative(row.receivedAt)}
          </p>
        </div>
      ),
      compact: (row) => <span className="truncate">{row.subject ?? "(no subject)"}</span>,
    },
    {
      key: "analysis",
      header: "Category",
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.analysis ? <CategoryBadge category={row.analysis.category} /> : <Badge tone="neutral">Not analysed</Badge>}
          {row.analysis?.subCategory && <SubCategoryBadge subCategory={row.analysis.subCategory} />}
        </div>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      hideBelow: "hidden lg:table-cell",
      cell: (row) => (row.analysis ? <PriorityBadge priority={row.analysis.priority} /> : <span className="text-muted">—</span>),
    },
    {
      key: "confidence",
      header: "AI status",
      hideBelow: "hidden md:table-cell",
      cell: (row) => (
        <div className="space-y-1">
          <ProcessingBadge state={row.processingState} />
          {row.analysis && <ConfidenceMeter confidence={row.analysis.confidence} />}
        </div>
      ),
    },
    {
      key: "application",
      header: "Application",
      hideBelow: "hidden lg:table-cell",
      cell: (row) =>
        row.application ? (
          <Link href={`/applications/${row.application.id}`} className="inline-flex items-center gap-1 text-xs hover:underline">
            <Link2 className="h-3 w-3" />
            <span className="truncate">
              {row.application.company} — {row.application.role}
            </span>
          </Link>
        ) : (
          <span className="text-2xs text-muted">Not linked</span>
        ),
    },
    {
      key: "date",
      header: "Received",
      hideBelow: "hidden lg:table-cell",
      cell: (row) => <span className="whitespace-nowrap text-2xs text-muted">{formatDateTime(row.receivedAt)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <Card
        flush
        title="Processed emails"
        description="Everything MailOps has understood from your inbox, with the AI decision attached."
        action={
          <Select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as EmailFilters["sortBy"])}
            className="h-8 w-40 py-0 text-xs"
            aria-label="Sort emails"
          >
            <option value="receivedAt">Newest first</option>
            <option value="priority">By priority</option>
            <option value="confidence">By AI confidence</option>
          </Select>
        }
      >
        <div className="border-b border-[color:var(--surface-border)] px-4 py-3">
          <FilterChips
            options={chips}
            value={tab}
            onChange={(value) => {
              setTab(value);
              setPage(1);
            }}
          />
        </div>

        {isError ? (
          <EmptyState
            title="Could not load emails"
            description={error instanceof Error ? error.message : undefined}
            action={
              <Button size="sm" variant="secondary" onClick={() => refetch()}>
                Try again
              </Button>
            }
          />
        ) : isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={data?.items ?? []}
            rowKey={(row) => row.id}
            onRowClick={(row) => setOpenEmailId(row.id)}
            empty={
              <EmptyState
                icon={<Inbox className="h-6 w-6" />}
                title="Nothing here yet"
                description="Connect Gmail and run a scan, or seed the demo data to explore MailOps with realistic emails."
              />
            }
          />
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>

      <EmailDetailDrawer emailId={openEmailId} onClose={() => setOpenEmailId(null)} />
    </div>
  );
}

/** ------------------------------------------------------------------------ */
/** Detail drawer                                                             */
/** ------------------------------------------------------------------------ */

export function EmailDetailDrawer({ emailId, onClose }: { emailId: string | null; onClose: () => void }) {
  const { data, isLoading, isError, error } = useEmail(emailId);
  const override = useOverrideEmailAnalysis();
  const resolve = useResolveReview();
  const reprocess = useReprocessEmail();
  const [showBody, setShowBody] = useState(false);

  useEffect(() => {
    setShowBody(false);
  }, [emailId]);

  return (
    <Modal
      open={Boolean(emailId)}
      onClose={onClose}
      size="lg"
      title={data?.subject ?? "Email"}
      description={data ? `${data.fromName ?? data.fromEmail ?? "Unknown"} · ${formatDateTime(data.receivedAt)}` : undefined}
      footer={
        data ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => reprocess.mutate(data.id)} loading={reprocess.isPending}>
              <Sparkles className="h-3.5 w-3.5" /> Re-analyse
            </Button>
            {data.needsReview && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => resolve.mutate({ id: data.id, decision: { action: "NOT_JOB" } })}
                  loading={resolve.isPending}
                >
                  Not job related
                </Button>
                {data.applicationId && (
                  <Button
                    variant="success"
                    size="sm"
                    onClick={() => resolve.mutate({ id: data.id, decision: { action: "LINK", applicationId: data.applicationId } })}
                    loading={resolve.isPending}
                  >
                    Confirm match
                  </Button>
                )}
                {!data.applicationId && (
                  <Button
                    variant="success"
                    size="sm"
                    onClick={() => resolve.mutate({ id: data.id, decision: { action: "CREATE" } })}
                    loading={resolve.isPending}
                  >
                    Create application
                  </Button>
                )}
              </>
            )}
          </>
        ) : undefined
      }
    >
      {isLoading && <Skeleton className="h-32 w-full" />}

      {isError && (
        <InlineAlert tone="critical" title="Could not load this email">
          {error instanceof Error ? error.message : "Unknown error"}
        </InlineAlert>
      )}

      {data && (
        <div className="space-y-5">
          {data.processingError && (
            <InlineAlert tone="critical" title="MailOps could not finish analysing this email">
              {data.processingError}
            </InlineAlert>
          )}

          {/* ---- AI Analysis (spec #24) ---- */}
          <section className="surface-muted p-4">
            <header className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-[color:var(--tone-accent)]" />
              <h3 className="text-sm font-semibold">AI Analysis</h3>
              <ProcessingBadge state={data.processingState} />
            </header>

            {data.aiAnalysis ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
                <Field label="Category">
                  <CategoryBadge category={data.aiAnalysis.category} />
                </Field>
                <Field label="Type">
                  {data.aiAnalysis.subCategory ? <SubCategoryBadge subCategory={data.aiAnalysis.subCategory} /> : <span className="text-muted">—</span>}
                </Field>
                <Field label="Priority">
                  <PriorityBadge priority={data.aiAnalysis.priority} />
                </Field>
                <Field label="Confidence">
                  <ConfidenceMeter confidence={data.aiAnalysis.confidence} />
                </Field>
                <Field label="Action required">
                  <span className={data.aiAnalysis.requiresAction ? "text-[color:var(--tone-waiting)]" : "text-muted"}>
                    {data.aiAnalysis.requiresAction ? "Yes" : "No"}
                  </span>
                </Field>
                <Field label="Analysed by">
                  <span className="font-mono text-2xs text-muted">{data.aiAnalysis.provider}</span>
                </Field>
              </dl>
            ) : (
              <p className="mt-3 text-xs text-muted">This email has not been analysed yet.</p>
            )}

            {data.aiAnalysis?.summary && (
              <div className="mt-4">
                <p className="text-2xs uppercase tracking-wide text-muted">Summary</p>
                <p className="mt-1 text-sm text-secondary">{data.aiAnalysis.summary}</p>
              </div>
            )}

            {data.aiAnalysis?.reasoning && (
              <div className="mt-3">
                <p className="text-2xs uppercase tracking-wide text-muted">Why MailOps decided this</p>
                <p className="mt-1 text-xs text-secondary">{data.aiAnalysis.reasoning}</p>
              </div>
            )}

            {/* Correct the AI — the user is always in control. */}
            {data.aiAnalysis && (
              <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-[color:var(--surface-border)] pt-3">
                <Select
                  label="Reclassify as"
                  className="w-48"
                  defaultValue={data.aiAnalysis.subCategory ?? ""}
                  onChange={(event) =>
                    override.mutate({
                      id: data.id,
                      patch: { subCategory: event.target.value || null, note: "Corrected by the user from the email view" },
                    })
                  }
                >
                  <option value="">(clear job type)</option>
                  {(
                    [
                      "SHORTLISTED",
                      "ASSESSMENT",
                      "INTERVIEW",
                      "FINAL_ROUND",
                      "OFFER",
                      "RECRUITER_CONTACT",
                      "REJECTION",
                      "WITHDRAWN",
                      "NOT_JOB",
                    ] as const
                  ).map((value) => (
                    <option key={value} value={value}>
                      {value === "NOT_JOB" ? "Other job-related" : value.toLowerCase().replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
                <span className="text-2xs text-muted">Corrections are recorded in the audit log.</span>
              </div>
            )}
          </section>

          {/* ---- Extracted information ---- */}
          {data.analysis && <ExtractedPanel extracted={data.analysis} />}

          {/* ---- Application association ---- */}
          <section>
            <h3 className="text-sm font-semibold">Application</h3>
            {data.application ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <Link href={`/applications/${data.application.id}`} className="font-medium hover:underline">
                  {data.application.company} — {data.application.role}
                </Link>
                <StatusBadge status={data.application.status} />
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted">
                This email is not linked to an application. MailOps creates a record automatically when it can confidently
                identify the company and role.
              </p>
            )}
          </section>

          {/* ---- Original email ---- */}
          <section>
            <h3 className="text-sm font-semibold">Original email</h3>
            <div className="mt-2 space-y-2 text-xs">
              <p className="text-muted">
                To respect your privacy MailOps stores a minimised plain-text version, and never the raw HTML.
              </p>
              <div className="surface-muted max-h-64 overflow-y-auto p-3">
                {showBody ? (
                  data.bodyText ? (
                    <pre className="whitespace-pre-wrap font-sans text-xs text-secondary">{data.bodyText}</pre>
                  ) : (
                    <p className="text-xs text-muted">
                      {data.deletedFromGmail
                        ? "This message was removed from Gmail at your request, so its body is no longer available."
                        : "Body storage is disabled for your account. Disable 'Store email bodies' to keep it this way, or enable it to store minimised text for future emails."}
                    </p>
                  )
                ) : (
                  <p className="text-xs text-secondary">{data.snippet ?? "No preview available."}</p>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setShowBody((current) => !current)}>
                {showBody ? "Hide full body" : "Show full body"}
              </Button>
            </div>
          </section>

          {/* ---- Cleanup history ---- */}
          {data.cleanupActions && data.cleanupActions.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold">Cleanup</h3>
              <ul className="mt-2 space-y-1.5 text-xs">
                {data.cleanupActions.map((action) => (
                  <li key={action.id} className="flex items-center justify-between gap-2">
                    <span className="text-secondary">
                      {action.type.toLowerCase()} · {action.status.toLowerCase()}
                    </span>
                    <span className="text-2xs text-muted">{formatRelative(action.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.deletedFromGmail && (
            <InlineAlert tone="waiting" title="Removed from Gmail">
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3" />
                The Gmail message was deleted at your request. The structured application history has been kept.
              </span>
            </InlineAlert>
          )}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-xs">{children}</dd>
    </div>
  );
}

/** Renders the validated structured extraction, hiding the internal decision block. */
function ExtractedPanel({ extracted }: { extracted: unknown }) {
  const record = (extracted ?? {}) as Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ["Company", record.company],
    ["Role", record.role],
    ["Job ID", record.jobId],
    ["Application ID", record.applicationId],
    ["Location", record.location],
    ["Employment type", record.employmentType],
    ["Recruiter", record.recruiterName],
    ["Recruiter email", record.recruiterEmail],
    ["Salary", record.salary],
    ["Deadline", record.responseDeadline ?? record.assessmentDeadline],
    ["Interview date", record.interviewDate],
    ["Required action", record.requiredAction],
  ];

  const visible = fields.filter(([, value]) => value !== null && value !== undefined && value !== "");

  if (!visible.length) {
    return (
      <section>
        <h3 className="text-sm font-semibold">Extracted information</h3>
        <p className="mt-2 text-xs text-muted">
          MailOps did not find any reliable structured details in this email. It never invents company names, roles or
          deadlines.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="text-sm font-semibold">Extracted information</h3>
      <dl className="mt-2 divide-y divide-[color:var(--surface-border)]">
        {visible.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-4 py-1.5">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="max-w-[60%] break-words text-right text-xs">
              {label === "Deadline" || label === "Interview date" ? formatDateTime(String(value)) : String(value)}
            </dd>
          </div>
        ))}
      </dl>
      {typeof record.evidence === "string" && record.evidence && (
        <p className="mt-2 text-2xs text-muted">
          <span className="uppercase tracking-wide">Evidence</span> — "{truncate(record.evidence as string, 220)}"
        </p>
      )}
    </section>
  );
}

/** Suggestion chips shown above the email list on the review tab. */
export function ReviewQueueHint({ count }: { count: number }) {
  if (!count) return null;
  return (
    <InlineAlert tone="waiting" title={`${count} email${count === 1 ? "" : "s"} waiting for your confirmation`}>
      MailOps only files an email automatically when it is confident. Anything uncertain waits here so a wrong guess can never
      change your application history.
    </InlineAlert>
  );
}

export type { JobSubCategory };
export { STATUS_LABELS, CATEGORY_LABELS };
