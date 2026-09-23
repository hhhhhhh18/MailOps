"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, RefreshCw } from "lucide-react";
import { Badge, Button, Card, InlineAlert } from "@/components/ui/primitives";
import { useScanStatus, useTriggerScan } from "@/lib/hooks";
import { cn, formatDateTime, formatDuration, formatRelative, pluralize } from "@/lib/utils";

/**
 * Scan status panel (spec #20).
 *
 * Shows what MailOps has actually done to the mailbox: when it last ran, how long
 * it took, whether anything failed, and when it will run again. This is the
 * evidence that the agent is operating, which is what makes the automation
 * trustworthy.
 */

const STATUS_TONE = {
  COMPLETED: "success",
  PARTIAL: "waiting",
  RUNNING: "info",
  QUEUED: "info",
  FAILED: "critical",
} as const;

export function ScanStatusPanel() {
  const { data, isLoading } = useScanStatus();
  const triggerScan = useTriggerScan();

  const schedule = data?.schedule;
  const jobs = data?.jobs ?? [];
  const nextScanMs = schedule?.nextScanAt ? new Date(schedule.nextScanAt).getTime() - Date.now() : null;

  if (isLoading) {
    return (
      <Card title="MailOps scan status">
        <div className="space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-[color:var(--surface-overlay)]" />
          <div className="h-4 w-56 animate-pulse rounded bg-[color:var(--surface-overlay)]" />
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="MailOps scan status"
      description={schedule?.scanningEnabled ? `Every ${Math.round((schedule.intervalMinutes / 60) * 10) / 10} hours` : "Scanning is paused"}
      action={
        <Button size="sm" variant="ghost" onClick={() => triggerScan.mutate({})} loading={triggerScan.isPending}>
          <RefreshCw className="h-3.5 w-3.5" /> Scan now
        </Button>
      }
    >
      <div className="space-y-3">
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-2xs uppercase tracking-wide text-muted">Last scan</dt>
            <dd className="mt-0.5 flex items-center gap-1.5">
              {schedule?.lastScanAt ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-[color:var(--tone-success)]" />
                  {formatRelative(schedule.lastScanAt)}
                </>
              ) : (
                <span className="text-muted">Not yet run</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-muted">Next scan</dt>
            <dd className="mt-0.5 flex items-center gap-1.5">
              {schedule?.scanningEnabled && nextScanMs !== null ? (
                nextScanMs > 0 ? (
                  <>
                    <Clock className="h-3 w-3 text-[color:var(--tone-info)]" />
                    in {formatDuration(nextScanMs)}
                  </>
                ) : (
                  <span className="text-[color:var(--tone-info)]">Queued</span>
                )
              ) : (
                <span className="text-muted">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-muted">Emails seen (24h)</dt>
            <dd className="mt-0.5 tabular-nums">{schedule?.scannedMessagesLast24h ?? 0}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-muted">Last duration</dt>
            <dd className="mt-0.5 tabular-nums">{formatDuration(schedule?.lastScanDurationMs ?? null)}</dd>
          </div>
        </dl>

        {schedule?.lastScanError && (
          <InlineAlert
            tone="critical"
            title="The last scan did not finish"
            action={
              <Link href="/settings?section=gmail" className="text-2xs underline">
                Fix in settings
              </Link>
            }
          >
            <span className="inline-flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {schedule.lastScanError}
            </span>
          </InlineAlert>
        )}

        {!schedule?.scanningEnabled && (
          <InlineAlert tone="waiting" title="Automatic scanning is off">
            MailOps will not read your inbox until you re-enable scanning in Settings.
          </InlineAlert>
        )}

        {jobs.length > 0 && (
          <div>
            <p className="text-2xs uppercase tracking-wide text-muted">Recent scans</p>
            <ul className="mt-1.5 space-y-1">
              {jobs.slice(0, 5).map((job) => (
                <li key={job.id} className="flex items-center justify-between gap-2 text-2xs">
                  <span className="inline-flex items-center gap-2">
                    <Badge tone={STATUS_TONE[job.status] ?? "neutral"}>{job.status.toLowerCase()}</Badge>
                    <span className="text-muted">{formatDateTime(job.startedAt ?? job.createdAt)}</span>
                  </span>
                  <span className="tabular-nums text-muted">
                    {job.status === "FAILED"
                      ? job.error
                        ? job.error.slice(0, 40)
                        : "failed"
                      : `${pluralize(job.messagesNew, "new")} · ${pluralize(job.messagesScanned, "scanned")}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Compact one-line scan indicator for the dashboard header. */
export function ScanStatusLine({ className }: { className?: string }) {
  const { data } = useScanStatus();
  const schedule = data?.schedule;
  if (!schedule) return null;

  const nextScanMs = schedule.nextScanAt ? new Date(schedule.nextScanAt).getTime() - Date.now() : null;

  return (
    <p className={cn("text-2xs text-muted", className)}>
      Last scan {schedule.lastScanAt ? formatRelative(schedule.lastScanAt) : "never"}
      {schedule.scanningEnabled && nextScanMs !== null && nextScanMs > 0 && ` · next in ${formatDuration(nextScanMs)}`}
    </p>
  );
}
