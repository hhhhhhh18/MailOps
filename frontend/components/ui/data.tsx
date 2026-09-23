"use client";

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { Button, Skeleton } from "./primitives";
import type { PageMeta } from "@/lib/types";

/**
 * Data-display components.
 *
 * The tables are mobile-aware by design: on a narrow viewport the component
 * renders the same records as stacked cards instead of a horizontally scrolling
 * grid, which is what the responsive requirement actually asks for.
 */

/** ------------------------------------------------------------------------ */
/** Table (desktop) / cards (mobile)                                          */
/** ------------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer for the desktop table. */
  cell: (row: T) => ReactNode;
  /** Compact renderer for the mobile card layout. Falls back to `cell`. */
  compact?: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  /** Hide below the given breakpoint (e.g. "hidden lg:table-cell"). */
  hideBelow?: string;
  align?: "left" | "right";
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty: ReactNode;
  loading?: boolean;
  className?: string;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty, loading, className }: DataTableProps<T>) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!rows.length) return <div>{empty}</div>;

  return (
    <div className={className}>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(column.hideBelow, column.align === "right" && "text-right", column.headerClassName)}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && "cursor-pointer")}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(column.hideBelow, column.align === "right" && "text-right", column.className)}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <ul className="divide-y divide-[color:var(--surface-border)] md:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn("px-4 py-3", onRowClick && "cursor-pointer active:bg-[color:var(--surface-hover)]")}
          >
            <div className="space-y-1.5">
              {columns.map((column) => (
                <div key={column.key} className="flex items-start justify-between gap-3 text-xs">
                  <span className="shrink-0 text-muted">{column.header}</span>
                  <span className="min-w-0 text-right">{column.compact ? column.compact(row) : column.cell(row)}</span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** ------------------------------------------------------------------------ */
/** Pagination                                                                */
/** ------------------------------------------------------------------------ */

export function Pagination({
  meta,
  onPageChange,
  className,
}: {
  meta: PageMeta | undefined;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  if (!meta || meta.total === 0) return null;

  const first = (meta.page - 1) * meta.pageSize + 1;
  const last = Math.min(meta.page * meta.pageSize, meta.total);

  return (
    <div className={cn("flex items-center justify-between gap-3 border-t border-[color:var(--surface-border)] px-4 py-2.5", className)}>
      <p className="text-2xs text-muted">
        {first}–{last} of {pluralize(meta.total, "record")}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-2xs text-muted">
          Page {meta.page} of {meta.totalPages}
        </span>
        <Button size="icon" variant="ghost" disabled={!meta.hasPrev} onClick={() => onPageChange(meta.page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" disabled={!meta.hasNext} onClick={() => onPageChange(meta.page + 1)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/** ------------------------------------------------------------------------ */
/** Filter chips                                                              */
/** ------------------------------------------------------------------------ */

export interface ChipOption {
  value: string;
  label: string;
  count?: number;
  tone?: "neutral" | "critical";
}

export function FilterChips({
  options,
  value,
  onChange,
  className,
}: {
  options: ChipOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} role="tablist">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              active
                ? "border-[color:var(--tone-accent)]/40 bg-[color:var(--tone-accent-bg)] text-[color:var(--tone-accent)]"
                : "border-[color:var(--surface-border)] text-secondary hover:bg-[color:var(--surface-hover)]",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cn("tabular-nums text-2xs", active ? "opacity-80" : "text-muted")}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** ------------------------------------------------------------------------ */
/** Misc layout helpers                                                       */
/** ------------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-[color:var(--content-primary)]">{title}</h1>
        {description && <div className="mt-1 text-xs text-muted">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[color:var(--surface-border)] py-2 last:border-0">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-[color:var(--content-primary)]">{children}</dd>
    </div>
  );
}

export function ProgressBar({ value, total, tone = "accent" }: { value: number; total: number; tone?: string }) {
  const percent = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--surface-overlay)]">
      <div
        className={cn(
          "h-full rounded-full transition-all",
          tone === "accent" && "bg-[color:var(--tone-accent)]",
          tone === "success" && "bg-[color:var(--tone-success)]",
          tone === "critical" && "bg-[color:var(--tone-critical)]",
          tone === "waiting" && "bg-[color:var(--tone-waiting)]",
          tone === "info" && "bg-[color:var(--tone-info)]",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
