"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  ExternalLink,
  Mail,
  MapPin,
  MessageSquarePlus,
  User,
} from "lucide-react";
import { Badge, Button, Card, EmptyState, InlineAlert, Input, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, Modal, useToast } from "@/components/ui/feedback";
import { KeyValue } from "@/components/ui/data";
import { ConfidenceMeter, DuplicateBadge, StatusBadge, SubCategoryBadge } from "@/components/domain/badges";
import { ApplicationTimeline } from "@/components/domain/timeline";
import {
  useAddApplicationNote,
  useApplication,
  useDuplicateDecision,
  useOverrideApplicationStatus,
  useUpdateApplication,
} from "@/lib/hooks";
import { STATUS_LABELS, formatDate, formatDateTime, formatRelative } from "@/lib/utils";
import type { ApplicationStatus } from "@/lib/types";

/**
 * Application detail (spec #8, #9, #12).
 *
 * The timeline is the primary artefact here — it is the "career memory" the whole
 * product is built to preserve. Status editing, notes and duplicate resolution all
 * write through the audit trail.
 */
export default function ApplicationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const applicationId = params?.id ?? null;
  const toast = useToast();

  const { data: application, isLoading, isError, error } = useApplication(applicationId);
  const overrideStatus = useOverrideApplicationStatus();
  const updateApplication = useUpdateApplication();
  const addNote = useAddApplicationNote();
  const duplicateDecision = useDuplicateDecision();

  const [showStatusEditor, setShowStatusEditor] = useState(false);
  const [showNoteEditor, setShowNoteEditor] = useState(false);
  const [duplicatePromptOpen, setDuplicatePromptOpen] = useState(false);

  const [newStatus, setNewStatus] = useState<ApplicationStatus>("APPLIED");
  const [statusNote, setStatusNote] = useState("");
  const [note, setNote] = useState("");
  const [noteDue, setNoteDue] = useState("");

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-72 w-full lg:col-span-2" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !application) {
    return (
      <Card>
        <EmptyState
          title="Application not found"
          description={error instanceof Error ? error.message : "This application may have been removed."}
          action={
            <Link href="/applications">
              <Button size="sm" variant="secondary">
                Back to applications
              </Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const duplicateEvent = application.events.find((event) => event.type === "DUPLICATE_FLAGGED");
  const previousId = (duplicateEvent?.metadata as { previousApplicationId?: string })?.previousApplicationId;

  return (
    <div className="space-y-4">
      <Link href="/applications" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-[color:var(--content-primary)]">
        <ArrowLeft className="h-3.5 w-3.5" /> All applications
      </Link>

      {/* ---- Header ---- */}
      <div className="surface-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{application.company}</h1>
              <StatusBadge status={application.status} />
              {application.applicationRefId && <Badge tone="neutral">Emp ref {application.applicationRefId}</Badge>}
              {application.isDemo && <Badge tone="neutral">Demo</Badge>}
              {application.needsReview && <DuplicateBadge />}
            </div>
            <p className="mt-1 text-sm text-secondary">{application.role}</p>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-muted">
              {application.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> {application.location}
                </span>
              )}
              {application.employmentType && <span>{application.employmentType}</span>}
              {application.jobId && <span className="font-mono">{application.jobId}</span>}
              <span>Applied {formatDate(application.appliedDate)}</span>
              <span>Last updated {formatRelative(application.lastUpdated)}</span>
              {application.confidence !== null && <ConfidenceMeter confidence={application.confidence} />}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setNewStatus(application.status); setShowStatusEditor(true); }}>
              Update status
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowNoteEditor(true)} icon={<MessageSquarePlus className="h-3.5 w-3.5" />}>
              Add note
            </Button>
            {(application.applicationUrl || application.jobUrl) && (
              <a
                href={application.applicationUrl ?? application.jobUrl ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--surface-border)] bg-[color:var(--surface-overlay)] px-3 text-xs hover:bg-[color:var(--surface-hover)]"
              >
                Open posting <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>

        {duplicateEvent && (
          <div className="mt-4">
            <InlineAlert
              tone="waiting"
              title="Possible duplicate application"
              action={
                <Button size="sm" variant="secondary" onClick={() => setDuplicatePromptOpen(true)}>
                  Resolve
                </Button>
              }
            >
              {duplicateEvent.description}
              {previousId && (
                <Link href={`/applications/${previousId}`} className="ml-1 underline">
                  View previous application
                </Link>
              )}
            </InlineAlert>
          </div>
        )}

        {application.notes && <p className="mt-4 rounded-lg bg-[color:var(--surface-overlay)] p-3 text-xs text-secondary">{application.notes}</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---- Timeline ---- */}
        <Card className="lg:col-span-2" flush title="Timeline" description="Every status change is recorded as an immutable event">
          <ApplicationTimeline events={application.events} />
        </Card>

        {/* ---- Side panels ---- */}
        <div className="space-y-4">
          <Card title="Details">
            <dl>
              <KeyValue label="Company">{application.company}</KeyValue>
              <KeyValue label="Role">{application.role}</KeyValue>
              <KeyValue label="Job ID">{application.jobId ?? "—"}</KeyValue>
              <KeyValue label="Location">{application.location ?? "—"}</KeyValue>
              <KeyValue label="Employment">{application.employmentType ?? "—"}</KeyValue>
              <KeyValue label="Salary">{application.salary ?? "—"}</KeyValue>
              <KeyValue label="Source">{application.source ?? "—"}</KeyValue>
              <KeyValue label="Applied">{formatDate(application.appliedDate)}</KeyValue>
              <KeyValue label="Status since">{formatDateTime(application.statusChangedAt)}</KeyValue>
            </dl>
          </Card>

          <Card title="Recruiter">
            {application.recruiterName || application.recruiterEmail ? (
              <div className="space-y-1.5 text-xs">
                {application.recruiterName && (
                  <p className="inline-flex items-center gap-1.5">
                    <User className="h-3 w-3 text-muted" /> {application.recruiterName}
                  </p>
                )}
                {application.recruiterEmail && (
                  <p className="inline-flex items-center gap-1.5">
                    <Mail className="h-3 w-3 text-muted" /> {application.recruiterEmail}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">No recruiter contact was stated in the emails MailOps has seen.</p>
            )}
          </Card>

          <Card title={`Related emails (${application.emails.length})`} flush>
            {!application.emails.length ? (
              <EmptyState icon={<Building2 className="h-6 w-6" />} title="No linked emails yet" />
            ) : (
              <ul className="divide-y divide-[color:var(--surface-border)]">
                {application.emails.map((email) => (
                  <li key={email.id}>
                    <Link href={`/emails?emailId=${email.id}`} className="block px-4 py-2.5 hover:bg-[color:var(--surface-hover)]">
                      <p className="truncate text-xs font-medium">
                        {email.deletedFromGmail && <span className="mr-1 text-muted">[deleted from Gmail]</span>}
                        {email.subject ?? "(no subject)"}
                      </p>
                      <p className="truncate text-2xs text-muted">
                        {email.fromName ?? email.fromEmail} · {formatRelative(email.receivedAt)}
                      </p>
                      {email.analysis && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {email.analysis.subCategory && <SubCategoryBadge subCategory={email.analysis.subCategory} />}
                          <ConfidenceMeter confidence={email.analysis.confidence} />
                        </div>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Notifications (${application.notifications.length})`} flush>
            {!application.notifications.length ? (
              <EmptyState icon={<CalendarClock className="h-6 w-6" />} title="No notifications for this application" />
            ) : (
              <ul className="divide-y divide-[color:var(--surface-border)]">
                {application.notifications.map((notification) => (
                  <li key={notification.id} className="px-4 py-2.5">
                    <p className="truncate text-xs font-medium">{notification.title}</p>
                    <p className="mt-0.5 text-2xs text-muted">
                      {notification.status.toLowerCase()} · {formatRelative(notification.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {/* ---- Status editor ---- */}
      <Modal
        open={showStatusEditor}
        onClose={() => setShowStatusEditor(false)}
        title="Update application status"
        description="You can always override what MailOps detected. The change is recorded in the timeline and audit log."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowStatusEditor(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={overrideStatus.isPending}
              onClick={() =>
                overrideStatus.mutate(
                  { id: application.id, status: newStatus, note: statusNote || undefined },
                  {
                    onSuccess: () => {
                      setShowStatusEditor(false);
                      setStatusNote("");
                      toast.success("Status updated", `Set to ${STATUS_LABELS[newStatus]}.`);
                    },
                  },
                )
              }
            >
              Save status
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Select label="Status" value={newStatus} onChange={(event) => setNewStatus(event.target.value as ApplicationStatus)}>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Textarea
            label="Note (optional)"
            value={statusNote}
            onChange={(event) => setStatusNote(event.target.value)}
            placeholder="Why did the status change?"
          />
        </div>
      </Modal>

      {/* ---- Note editor ---- */}
      <Modal
        open={showNoteEditor}
        onClose={() => setShowNoteEditor(false)}
        title="Add a note"
        description="Notes are added to the timeline. Add a due date to make it a tracked deadline."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowNoteEditor(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={addNote.isPending}
              disabled={!note.trim()}
              onClick={() =>
                addNote.mutate(
                  { id: application.id, note: note.trim(), dueAt: noteDue ? new Date(noteDue).toISOString() : undefined },
                  {
                    onSuccess: () => {
                      setShowNoteEditor(false);
                      setNote("");
                      setNoteDue("");
                      toast.success("Note added");
                    },
                  },
                )
              }
            >
              Add note
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Textarea label="Note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Follow up with the recruiter…" />
          <Input
            label="Due date (optional)"
            type="date"
            value={noteDue}
            onChange={(event) => setNoteDue(event.target.value)}
            hint="Creating a due date adds a deadline MailOps will track."
          />
        </div>
      </Modal>

      {/* ---- Duplicate resolution ---- */}
      <ConfirmDialog
        open={duplicatePromptOpen}
        onClose={() => setDuplicatePromptOpen(false)}
        onConfirm={() =>
          duplicateDecision.mutate(
            { id: application.id, decision: "MERGE" },
            {
              onSuccess: () => {
                setDuplicatePromptOpen(false);
                toast.success("Merged", "The duplicate record was merged into the earlier application.");
                router.push(previousId ? `/applications/${previousId}` : "/applications");
              },
            },
          )
        }
        loading={duplicateDecision.isPending}
        variant="primary"
        title="Merge this into the previous application?"
        confirmLabel="Merge records"
        cancelLabel="Keep both"
        description={
          <p>
            MailOps found a similar earlier application. Merging moves every email, event and notification onto the earlier
            record and removes this one. Choosing <span className="font-medium">Keep both</span> leaves them separate and marks
            this one as reviewed.
          </p>
        }
      />

      {application.needsReview && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              duplicateDecision.mutate(
                { id: application.id, decision: "CONTINUE" },
                { onSuccess: () => toast.success("Marked as reviewed") },
              )
            }
          >
            Keep both and mark as reviewed
          </Button>
        </div>
      )}
    </div>
  );
}
