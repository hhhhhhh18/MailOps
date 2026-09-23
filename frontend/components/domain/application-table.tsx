"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { DataTable, FilterChips, Pagination, type Column } from "@/components/ui/data";
import { Button, Card, EmptyState, Input, Select, Skeleton } from "@/components/ui/primitives";
import { DuplicateBadge, StatusBadge } from "./badges";
import { useApplications, type ApplicationFilters } from "@/lib/hooks";
import { STATUS_LABELS, cn, formatDate, formatRelative } from "@/lib/utils";
import type { ApplicationListItem, ApplicationStatus } from "@/lib/types";

/**
 * Applications table (spec #21).
 *
 * Search, filter, sort and pagination are all server-side: the filter object is
 * the TanStack Query key, so changing any control refetches exactly once and the
 * browser back button restores the previous view.
 */

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "ACTIVE", label: "In progress" },
  { value: "SHORTLISTED", label: "Shortlisted" },
  { value: "ASSESSMENT", label: "Assessment" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
  { value: "WITHDRAWN", label: "Withdrawn" },
];

const SORT_OPTIONS = [
  { value: "lastUpdated", label: "Last updated" },
  { value: "appliedDate", label: "Applied date" },
  { value: "company", label: "Company" },
  { value: "role", label: "Role" },
  { value: "status", label: "Status" },
];

export function ApplicationTable({ initialFilters = {} }: { initialFilters?: ApplicationFilters }) {
  const [search, setSearch] = useState("");
  const [statusChip, setStatusChip] = useState("ALL");
  const [sortBy, setSortBy] = useState("lastUpdated");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [location, setLocation] = useState("");

  const filters = useMemo<ApplicationFilters>(() => {
    const status: ApplicationStatus[] | undefined =
      statusChip === "ALL"
        ? undefined
        : statusChip === "ACTIVE"
          ? ["APPLIED", "ACKNOWLEDGED", "SHORTLISTED", "ASSESSMENT", "INTERVIEW", "FINAL_ROUND"]
          : [statusChip as ApplicationStatus];

    return {
      page,
      pageSize: 25,
      sortBy,
      sortDir,
      ...(status ? { status } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(location.trim() ? { location: location.trim() } : {}),
      ...initialFilters,
    };
  }, [page, sortBy, sortDir, statusChip, search, location, initialFilters]);

  const { data, isLoading, isError, error, refetch } = useApplications(filters);

  const columns: Column<ApplicationListItem>[] = [
    {
      key: "company",
      header: "Company",
      cell: (row) => (
        <div className="min-w-0">
          <Link href={`/applications/${row.id}`} className="block truncate font-medium hover:underline">
            {row.company}
          </Link>
          {row.location && <p className="truncate text-2xs text-muted">{row.location}</p>}
        </div>
      ),
      compact: (row) => (
        <Link href={`/applications/${row.id}`} className="font-medium hover:underline">
          {row.company}
        </Link>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (row) => <span className="block max-w-[16rem] truncate text-secondary">{row.role}</span>,
    },
    {
      key: "jobId",
      header: "Job ID",
      hideBelow: "hidden lg:table-cell",
      cell: (row) => <span className="font-mono text-2xs text-muted">{row.jobId ?? "—"}</span>,
    },
    {
      key: "appliedDate",
      header: "Applied",
      hideBelow: "hidden md:table-cell",
      cell: (row) => <span className="whitespace-nowrap text-secondary">{formatDate(row.appliedDate)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={row.status} />
          {row.needsReview && <DuplicateBadge />}
        </div>
      ),
    },
    {
      key: "lastUpdated",
      header: "Last updated",
      hideBelow: "hidden lg:table-cell",
      cell: (row) => <span className="whitespace-nowrap text-2xs text-muted">{formatRelative(row.lastUpdated)}</span>,
    },
  ];

  return (
    <Card
      flush
      title="Applications"
      description={data ? `${data.meta.total} tracked application${data.meta.total === 1 ? "" : "s"}` : "Loading…"}
      action={
        <div className="flex items-center gap-2">
          <Select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="h-8 w-36 py-0 text-xs" aria-label="Sort by">
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button
            size="icon"
            variant="ghost"
            aria-label={sortDir === "desc" ? "Sort ascending" : "Sort descending"}
            onClick={() => setSortDir((current) => (current === "desc" ? "asc" : "desc"))}
          >
            {sortDir === "desc" ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 border-b border-[color:var(--surface-border)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search company, role or job ID"
              className="pl-9"
              aria-label="Search applications"
            />
          </div>
          <Input
            value={location}
            onChange={(event) => {
              setLocation(event.target.value);
              setPage(1);
            }}
            placeholder="Location"
            className="w-40"
            aria-label="Filter by location"
          />
        </div>

        <FilterChips
          options={STATUS_FILTERS}
          value={statusChip}
          onChange={(value) => {
            setStatusChip(value);
            setPage(1);
          }}
        />
      </div>

      {isError ? (
        <EmptyState
          title="Could not load applications"
          description={error instanceof Error ? error.message : undefined}
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
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
          empty={
            <EmptyState
              title="No applications match these filters"
              description="MailOps creates application records automatically once it finds recruitment email in your inbox."
            />
          }
        />
      )}

      <Pagination meta={data?.meta} onPageChange={setPage} />
    </Card>
  );
}

/** Compact list used on the dashboard and the rejected-page sidebar. */
export function ApplicationMiniList({ items, emptyLabel }: { items: ApplicationListItem[] | undefined; emptyLabel: string }) {
  if (!items?.length) {
    return <p className="px-4 py-6 text-center text-xs text-muted">{emptyLabel}</p>;
  }

  return (
    <ul className="divide-y divide-[color:var(--surface-border)]">
      {items.map((application) => (
        <li key={application.id}>
          <Link href={`/applications/${application.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[color:var(--surface-hover)]">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{application.company}</p>
              <p className="truncate text-2xs text-muted">{application.role}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <StatusBadge status={application.status} />
              <span className="text-2xs text-muted">{formatDate(application.appliedDate, { year: undefined })}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Small status distribution bar used on the applications and analytics pages. */
export function StatusDistribution({ byStatus }: { byStatus: Record<string, number> }) {
  const entries = Object.entries(byStatus).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return null;

  const tones: Record<string, string> = {
    APPLIED: "bg-[color:var(--tone-info)]",
    ACKNOWLEDGED: "bg-[color:var(--tone-info)]/70",
    SHORTLISTED: "bg-[color:var(--tone-accent)]",
    ASSESSMENT: "bg-[color:var(--tone-waiting)]/70",
    INTERVIEW: "bg-[color:var(--tone-waiting)]",
    FINAL_ROUND: "bg-[color:var(--tone-waiting)]",
    OFFER: "bg-[color:var(--tone-success)]",
    ACCEPTED: "bg-[color:var(--tone-success)]",
    REJECTED: "bg-[color:var(--tone-critical)]",
    WITHDRAWN: "bg-[color:var(--tone-neutral)]",
    ON_HOLD: "bg-[color:var(--tone-neutral)]/70",
    NO_RESPONSE: "bg-[color:var(--tone-neutral)]/50",
  };

  return (
    <div className="space-y-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-[color:var(--surface-overlay)]">
        {entries.map(([status, count]) => (
          <div
            key={status}
            className={cn(tones[status] ?? "bg-[color:var(--tone-neutral)]")}
            style={{ width: `${(count / total) * 100}%` }}
            title={`${STATUS_LABELS[status as ApplicationStatus] ?? status}: ${count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(([status, count]) => (
          <span key={status} className="inline-flex items-center gap-1.5 text-2xs text-muted">
            <span className={cn("h-2 w-2 rounded-full", tones[status] ?? "bg-[color:var(--tone-neutral)]")} />
            {STATUS_LABELS[status as ApplicationStatus] ?? status} {count}
          </span>
        ))}
      </div>
    </div>
  );
}
