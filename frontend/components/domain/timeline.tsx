"use client";

import {
  Bot,
  CalendarClock,
  FileText,
  MessageSquare,
  Sparkles,
  StickyNote,
  User,
  XCircle,
} from "lucide-react";
import { StatusBadge } from "./badges";
import { ConfidenceMeter } from "./badges";
import { cn, formatDateTime, isOverdue } from "@/lib/utils";
import type { ApplicationEvent } from "@/lib/types";

/**
 * Application timeline (spec #9).
 *
 * Renders the immutable event log. Each entry shows who caused it (AI, the user,
 * or the system) because trust in an automated agent depends on always being able
 * to tell which decisions were the machine's.
 */

const EVENT_STYLE: Record<string, { tone: string; icon: typeof Bot; label: string }> = {
  APPLICATION_CREATED: { tone: "var(--tone-info)", icon: FileText, label: "Created" },
  STATUS_CHANGED: { tone: "var(--tone-accent)", icon: Sparkles, label: "Status change" },
  EMAIL_LINKED: { tone: "var(--tone-neutral)", icon: FileText, label: "Email" },
  ACTION_REQUIRED: { tone: "var(--tone-waiting)", icon: CalendarClock, label: "Action" },
  DEADLINE_SET: { tone: "var(--tone-waiting)", icon: CalendarClock, label: "Deadline" },
  INTERVIEW_SCHEDULED: { tone: "var(--tone-waiting)", icon: CalendarClock, label: "Interview" },
  ASSESSMENT_ASSIGNED: { tone: "var(--tone-waiting)", icon: FileText, label: "Assessment" },
  OFFER_ISSUED: { tone: "var(--tone-success)", icon: Sparkles, label: "Offer" },
  REJECTION_RECEIVED: { tone: "var(--tone-critical)", icon: XCircle, label: "Rejection" },
  WITHDRAWN: { tone: "var(--tone-neutral)", icon: XCircle, label: "Withdrawn" },
  DUPLICATE_FLAGGED: { tone: "var(--tone-waiting)", icon: MessageSquare, label: "Duplicate" },
  USER_OVERRIDE: { tone: "var(--tone-accent)", icon: User, label: "Your change" },
  NOTE_ADDED: { tone: "var(--tone-info)", icon: StickyNote, label: "Note" },
  RECRUITER_CONTACT: { tone: "var(--tone-info)", icon: MessageSquare, label: "Recruiter" },
};

export function ApplicationTimeline({ events }: { events: ApplicationEvent[] }) {
  if (!events.length) {
    return <p className="px-4 py-8 text-center text-xs text-muted">No timeline events yet.</p>;
  }

  return (
    <ol className="relative space-y-0">
      {events.map((event, index) => {
        const style = EVENT_STYLE[event.type] ?? { tone: "var(--tone-neutral)", icon: FileText, label: event.type };
        const Icon = style.icon;
        const overdue = event.dueAt ? isOverdue(event.dueAt) : false;

        return (
          <li key={event.id} className="relative flex gap-3 px-4 py-3">
            {/* Connector line (omitted on the last row). */}
            {index < events.length - 1 && (
              <span className="absolute left-[1.6rem] top-10 h-[calc(100%-1.5rem)] w-px bg-[color:var(--surface-border)]" aria-hidden />
            )}

            <span
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-white/10"
              style={{ backgroundColor: `color-mix(in srgb, ${style.tone} 14%, transparent)`, color: style.tone }}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-[color:var(--content-primary)]">{event.title}</p>
                {event.toStatus && <StatusBadge status={event.toStatus} />}
                {event.dueAt && (
                  <span className={cn("text-2xs", overdue ? "text-[color:var(--tone-critical)]" : "text-muted")}>
                    due {formatDateTime(event.dueAt)}
                    {overdue && " · overdue"}
                  </span>
                )}
              </div>

              {event.description && <p className="mt-1 text-xs text-secondary">{event.description}</p>}

              <div className="mt-1.5 flex flex-wrap items-center gap-3 text-2xs text-muted">
                <span>{formatDateTime(event.occurredAt)}</span>
                <span className="inline-flex items-center gap-1">
                  {event.actor === "AI" ? <Bot className="h-3 w-3" /> : event.actor === "USER" ? <User className="h-3 w-3" /> : null}
                  {event.actor === "AI" ? "Detected by MailOps" : event.actor === "USER" ? "You" : "System"}
                </span>
                {event.confidence !== null && event.actor === "AI" && <ConfidenceMeter confidence={event.confidence} />}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
