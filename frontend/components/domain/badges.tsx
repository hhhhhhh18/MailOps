"use client";

import {
  AlertCircle,
  BellRing,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  Hourglass,
  Mail,
  Phone,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/primitives";
import {
  CATEGORY_LABELS,
  CATEGORY_TONES,
  CLEANUP_STATUS_TONES,
  PRIORITY_TONES,
  SEVERITY_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  SUB_CATEGORY_LABELS,
  confidenceLabel,
  cn,
} from "@/lib/utils";
import type {
  ApplicationStatus,
  ChannelName,
  CleanupAction,
  EmailCategory,
  JobSubCategory,
  Priority,
  Severity,
} from "@/lib/types";

/**
 * Domain badges.
 *
 * Every status in the product is rendered through one of these components, which
 * guarantees the colour language stays consistent (green = offer, red =
 * rejected/critical, yellow = waiting on you, blue = informational).
 */

export function StatusBadge({ status, className }: { status: ApplicationStatus; className?: string }) {
  return (
    <Badge tone={STATUS_TONES[status]} className={className}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function CategoryBadge({ category, className }: { category: EmailCategory; className?: string }) {
  return (
    <Badge tone={CATEGORY_TONES[category]} className={className}>
      {CATEGORY_LABELS[category]}
    </Badge>
  );
}

export function SubCategoryBadge({ subCategory }: { subCategory: JobSubCategory | null }) {
  if (!subCategory) return null;
  const critical = ["OFFER", "OFFER_ACCEPTED"].includes(subCategory);
  const waiting = ["INTERVIEW", "FINAL_ROUND", "NEXT_ROUND", "ASSESSMENT", "SHORTLISTED"].includes(subCategory);
  const rejected = ["REJECTION", "WITHDRAWN"].includes(subCategory);

  return (
    <Badge tone={critical ? "success" : waiting ? "waiting" : rejected ? "critical" : "neutral"}>
      {SUB_CATEGORY_LABELS[subCategory]}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <Badge tone={PRIORITY_TONES[priority]}>{priority.toLowerCase()}</Badge>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONES[severity]}>{severity.toLowerCase()}</Badge>;
}

export function CleanupStatusBadge({ status }: { status: CleanupAction["status"] }) {
  return <Badge tone={CLEANUP_STATUS_TONES[status]}>{status.toLowerCase()}</Badge>;
}

/**
 * Confidence meter. Shows a percentage but leads with a human word, because a
 * number alone invites false precision from a probabilistic system.
 */
export function ConfidenceMeter({ confidence, showValue = true }: { confidence: number; showValue?: boolean }) {
  const { label, tone } = confidenceLabel(confidence);
  const percent = Math.round(confidence * 100);

  return (
    <span className="inline-flex items-center gap-2" title={`${percent}% model confidence`}>
      <span className="flex h-1.5 w-16 overflow-hidden rounded-full bg-[color:var(--surface-overlay)]">
        <span
          className={cn(
            "h-full rounded-full",
            tone === "success" && "bg-[color:var(--tone-success)]",
            tone === "info" && "bg-[color:var(--tone-info)]",
            tone === "waiting" && "bg-[color:var(--tone-waiting)]",
            tone === "critical" && "bg-[color:var(--tone-critical)]",
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      {showValue && <span className="text-2xs tabular-nums text-muted">{percent}%</span>}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Processing state of an email through the AI pipeline. */
export function ProcessingBadge({ state }: { state: string }) {
  switch (state) {
    case "PROCESSED":
      return (
        <Badge tone="success">
          <CheckCircle2 className="h-3 w-3" /> Analysed
        </Badge>
      );
    case "NEEDS_REVIEW":
      return (
        <Badge tone="waiting">
          <Hourglass className="h-3 w-3" /> Needs review
        </Badge>
      );
    case "PROCESSING":
      return (
        <Badge tone="info">
          <Sparkles className="h-3 w-3" /> Analysing
        </Badge>
      );
    case "QUEUED":
      return (
        <Badge tone="info">
          <Clock className="h-3 w-3" /> Queued
        </Badge>
      );
    case "FAILED":
      return (
        <Badge tone="critical">
          <XCircle className="h-3 w-3" /> Failed
        </Badge>
      );
    case "SKIPPED":
      return <Badge tone="neutral">Skipped</Badge>;
    default:
      return <Badge tone="neutral">Pending</Badge>;
  }
}

/** Channel chips used by the notification detail and the audit log. */
export function ChannelChip({ channel, sent }: { channel: ChannelName; sent?: boolean }) {
  const Icon =
    channel === "SLACK" ? Send : channel === "WHATSAPP" ? Send : channel === "VOICE" ? Phone : channel === "EMAIL" ? Mail : BellRing;
  const label = channel === "DASHBOARD" ? "MailOps" : channel === "VOICE" ? "Voice call" : channel[0] + channel.slice(1).toLowerCase();

  return (
    <Badge tone={sent === undefined ? "neutral" : sent ? "success" : "critical"}>
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

/** "Action required" flag — the thing that must not be missed. */
export function ActionRequiredBadge({ deadline }: { deadline?: string | null }) {
  const overdue = deadline ? new Date(deadline).getTime() < Date.now() : false;
  return (
    <Badge tone={overdue ? "critical" : "waiting"}>
      <CalendarClock className="h-3 w-3" />
      {overdue ? "Overdue" : "Action required"}
    </Badge>
  );
}

export function DuplicateBadge() {
  return (
    <Badge tone="waiting" title="A similar application already exists">
      <AlertCircle className="h-3 w-3" /> Possible duplicate
    </Badge>
  );
}

export function DemoBadge() {
  return (
    <Badge tone="neutral" title="Seeded demo data, not from your mailbox">
      <FileText className="h-3 w-3" /> Demo
    </Badge>
  );
}

/** Compact confidence + category pair used in list rows. */
export function AnalysisSummary({
  category,
  subCategory,
  priority,
  confidence,
}: {
  category: EmailCategory;
  subCategory: JobSubCategory | null;
  priority: Priority;
  confidence: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <CategoryBadge category={category} />
      {subCategory && <SubCategoryBadge subCategory={subCategory} />}
      {(priority === "HIGH" || priority === "CRITICAL") && <PriorityBadge priority={priority} />}
      <ConfidenceMeter confidence={confidence} />
    </div>
  );
}

export { Badge };
export type { BadgeProps };
