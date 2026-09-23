"use client";

import Link from "next/link";
import { BellOff, Check, ExternalLink, Pause, Play, RefreshCw, Volume2 } from "lucide-react";
import { Badge, Button, Card, EmptyState, InlineAlert, Skeleton } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/data";
import { Modal } from "@/components/ui/feedback";
import { ChannelChip, SeverityBadge } from "./badges";
import {
  useAcknowledgeNotification,
  useNotificationCounts,
  useNotifications,
  usePauseEscalation,
  useRetryNotification,
} from "@/lib/hooks";
import { CHANNEL_LABELS, cn, formatRelative, truncate } from "@/lib/utils";
import type { EscalationPlan, NotificationAttempt, NotificationRecord } from "@/lib/types";

/**
 * Notifications feed + escalation explainer (spec #14, #15).
 *
 * The escalation ladder is rendered explicitly, including which stages are
 * suppressed and why. A user should never be surprised by a phone call — they
 * should be able to look at a notification and see exactly what MailOps is
 * allowed to do about it.
 */

export function NotificationsView({ page, onPageChange }: { page: number; onPageChange: (page: number) => void }) {
  const { data, isLoading, isError, error, refetch } = useNotifications({ page, pageSize: 20 });
  const { data: counts } = useNotificationCounts();

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Open" value={counts?.unread ?? 0} tone="info" />
        <SummaryTile label="Awaiting acknowledgement" value={counts?.pendingAck ?? 0} tone="waiting" />
        <SummaryTile label="Escalated in 24h" value={counts?.escalatedToday ?? 0} tone="critical" />
      </div>

      {(counts?.pendingAck ?? 0) > 0 && (
        <InlineAlert tone="waiting" title="Escalation is armed on these notifications">
          MailOps will move to the next channel you enabled if a notification stays unacknowledged. Acknowledging stops the
          ladder immediately.
        </InlineAlert>
      )}

      {isError ? (
        <Card>
          <EmptyState
            title="Could not load notifications"
            description={error instanceof Error ? error.message : undefined}
            action={
              <Button size="sm" variant="secondary" onClick={() => refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            icon={<BellOff className="h-6 w-6" />}
            title="No notifications yet"
            description="When MailOps detects an important recruitment update it will appear here first, then escalate to Slack or WhatsApp if you have those channels enabled."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {data.items.map((notification) => (
            <NotificationRow key={notification.id} notification={notification} />
          ))}
        </div>
      )}

      <Pagination meta={data?.meta} onPageChange={onPageChange} />
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: "info" | "waiting" | "critical" }) {
  return (
    <div className="surface-card px-4 py-3">
      <p className="text-2xs uppercase tracking-wide text-muted">{label}</p>
      <p
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "info" && "text-[color:var(--tone-info)]",
          tone === "waiting" && "text-[color:var(--tone-waiting)]",
          tone === "critical" && "text-[color:var(--tone-critical)]",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function NotificationRow({ notification }: { notification: NotificationRecord }) {
  const acknowledge = useAcknowledgeNotification();
  const pause = usePauseEscalation();
  const retry = useRetryNotification();

  const plan = notification.metadata?.plan as EscalationPlan | undefined;
  const attempts = notification.attempts ?? [];
  const settled = ["ACKNOWLEDGED", "RESOLVED", "CANCELLED"].includes(notification.status);

  return (
    <Card
      className={cn(
        "px-0",
        notification.severity === "CRITICAL" && !settled && "ring-1 ring-inset ring-[color:var(--tone-critical)]/30",
      )}
      bodyClassName="p-4"
      flush
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={notification.severity} />
            <Badge tone="neutral">{notification.type.toLowerCase().replace(/_/g, " ")}</Badge>
            {notification.requiresAck && !settled && <Badge tone="waiting">Awaiting acknowledgement</Badge>}
            {notification.acknowledgedAt && (
              <Badge tone="success">
                <Check className="h-3 w-3" /> Acknowledged
              </Badge>
            )}
            {notification.escalationPaused && !settled && <Badge tone="neutral">Escalation paused</Badge>}
          </div>

          <p className="mt-2 text-sm font-medium text-[color:var(--content-primary)]">{notification.title}</p>
          {notification.body && <p className="mt-1 whitespace-pre-line text-xs text-secondary">{notification.body}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-muted">
            <span>{formatRelative(notification.createdAt)}</span>
            {notification.application && (
              <Link href={`/applications/${notification.application.id}`} className="hover:underline">
                {notification.application.company} — {notification.application.role}
              </Link>
            )}
            {notification.nextEscalationAt && !settled && (
              <span className="text-[color:var(--tone-waiting)]">
                Next escalation {formatRelative(notification.nextEscalationAt)}
              </span>
            )}
          </div>

          {/* Delivery + escalation history */}
          {attempts.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {attempts
                .slice()
                .reverse()
                .map((attempt) => (
                  <span key={attempt.id} className="inline-flex items-center gap-1">
                    <ChannelChip channel={attempt.channel} sent={attempt.status === "SENT"} />
                    <span className="text-2xs text-muted">{attempt.stage === -1 ? "initial" : `stage ${attempt.stage + 1}`}</span>
                  </span>
                ))}
            </div>
          )}

          {plan && !settled && <EscalationLadder plan={plan} currentStage={notification.escalationStage} />}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!settled && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => acknowledge.mutate({ id: notification.id })}
              loading={acknowledge.isPending}
            >
              <Check className="h-3.5 w-3.5" /> Acknowledge
            </Button>
          )}
          {notification.requiresAck && !settled && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => pause.mutate({ id: notification.id, paused: !notification.escalationPaused })}
              loading={pause.isPending}
              title={notification.escalationPaused ? "Resume escalation" : "Pause escalation"}
            >
              {notification.escalationPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
          )}
          {attempts.some((attempt) => attempt.status === "FAILED") && (
            <Button size="sm" variant="ghost" onClick={() => retry.mutate(notification.id)} loading={retry.isPending} title="Retry delivery">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
          {notification.actionUrl && (
            <Link
              href={notification.actionUrl}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--surface-border)] bg-[color:var(--surface-overlay)] px-3 text-xs font-medium transition-colors hover:bg-[color:var(--surface-hover)]"
            >
              {notification.actionLabel ?? "Open"} <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Visualises the ladder. Disabled stages are shown greyed with the reason, so
 * "why didn't MailOps call me?" is answerable without reading documentation.
 */
function EscalationLadder({ plan, currentStage }: { plan: EscalationPlan; currentStage: number }) {
  return (
    <div className="mt-3 rounded-lg border border-[color:var(--surface-border)] bg-[color:var(--surface-base)] px-3 py-2.5">
      <p className="text-2xs uppercase tracking-wide text-muted">Escalation ladder</p>

      <ol className="mt-2 flex flex-wrap items-center gap-2 text-2xs">
        <Stage label="MailOps" active={currentStage === -1} done />
        {plan.escalation.stages.map((stage, index) => (
          <li key={stage} className="flex items-center gap-2">
            <span className="text-muted">→</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5",
                index === currentStage ? "bg-[color:var(--tone-waiting)]/15 text-[color:var(--tone-waiting)]" : "text-muted",
                index < currentStage && "text-[color:var(--tone-success)]",
              )}
            >
              {CHANNEL_LABELS[stage] ?? stage}
              {plan.escalation.delaysMinutes[index] !== undefined && ` (+${plan.escalation.delaysMinutes[index]}m)`}
            </span>
          </li>
        ))}
      </ol>

      {plan.voiceSuppressionReason && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-2xs text-muted">
          <Volume2 className="h-3 w-3" />
          Voice call suppressed: {plan.voiceSuppressionReason}
        </p>
      )}

      {plan.escalation.stages.length === 0 && (
        <p className="mt-2 text-2xs text-muted">
          No escalation channels are enabled. MailOps will only show this in the dashboard.
        </p>
      )}
    </div>
  );
}

function Stage({ label, active, done }: { label: string; active?: boolean; done?: boolean }) {
  return (
    <li
      className={cn(
        "rounded-full px-2 py-0.5",
        active && "bg-[color:var(--tone-info)]/15 text-[color:var(--tone-info)]",
        done && !active && "text-[color:var(--tone-success)]",
      )}
    >
      {label}
    </li>
  );
}

/** Compact notification list for the dashboard sidebar. */
export function NotificationMiniList({ items }: { items: NotificationRecord[] | undefined }) {
  if (!items?.length) {
    return <p className="px-4 py-6 text-center text-xs text-muted">Nothing new. MailOps is watching your inbox.</p>;
  }

  return (
    <ul className="divide-y divide-[color:var(--surface-border)]">
      {items.slice(0, 6).map((notification) => (
        <li key={notification.id} className="px-4 py-2.5">
          <div className="flex items-start gap-2">
            <SeverityBadge severity={notification.severity} />
            <div className="min-w-0">
              <p className="truncate text-xs text-[color:var(--content-primary)]">{truncate(notification.title, 80)}</p>
              <p className="text-2xs text-muted">{formatRelative(notification.createdAt)}</p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export type { NotificationAttempt };
