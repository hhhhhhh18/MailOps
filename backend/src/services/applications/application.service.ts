import type {
  Application,
  ApplicationEventType,
  ApplicationStatus,
  EmailCategory,
  JobSubCategory,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import {
  STATUS_LABELS,
  STATUS_RANK,
  SUBCATEGORY_LABELS,
  SUBCATEGORY_TO_STATUS,
} from "../../config/constants";
import { buildPageMeta, type PageMeta } from "../../utils/http";
import { normalizeCompany, normalizeJobId, normalizeRole } from "../../utils/text";
import {
  DUPLICATE_THRESHOLD,
  normalizeUrl,
  blendedSimilarity,
  matchApplicationIdentity,
  type ApplicationIdentity,
} from "../../utils/similarity";
import { NotFoundError, ValidationError } from "../../utils/errors";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";

/**
 * Application intelligence.
 *
 * The invariant this module protects: one Application row per (user, company,
 * role) application cycle, with an append-only timeline of ApplicationEvent
 * rows. Email rows may be deleted at any time without affecting the history —
 * Email -> Application is a nullable relation and events keep their own copy of
 * the facts that mattered.
 */

export interface ApplicationDraft {
  company: string;
  role: string;
  jobId?: string | null;
  applicationRefId?: string | null;
  location?: string | null;
  employmentType?: string | null;
  salary?: string | null;
  source?: string | null;
  applicationUrl?: string | null;
  jobUrl?: string | null;
  recruiterName?: string | null;
  recruiterEmail?: string | null;
  appliedDate?: Date | null;
  status?: ApplicationStatus;
  confidence?: number | null;
}

export interface ApplicationCandidatesQuery {
  company?: string | null;
  role?: string | null;
  jobId?: string | null;
  applicationUrl?: string | null;
  limit?: number;
}

const SUB_TO_EVENT: Partial<Record<JobSubCategory, ApplicationEventType>> = {
  APPLICATION_RECEIVED: "APPLICATION_CREATED",
  APPLICATION_ACKNOWLEDGED: "STATUS_CHANGED",
  SHORTLISTED: "STATUS_CHANGED",
  ASSESSMENT: "ASSESSMENT_ASSIGNED",
  INTERVIEW: "INTERVIEW_SCHEDULED",
  NEXT_ROUND: "INTERVIEW_SCHEDULED",
  FINAL_ROUND: "INTERVIEW_SCHEDULED",
  RECRUITER_CONTACT: "RECRUITER_CONTACT",
  OFFER: "OFFER_ISSUED",
  OFFER_ACCEPTED: "STATUS_CHANGED",
  REJECTION: "REJECTION_RECEIVED",
  WITHDRAWN: "WITHDRAWN",
  JOB_ALERT: "EMAIL_LINKED",
  OTHER_JOB: "EMAIL_LINKED",
};

/** Creates an application and its opening timeline event. */
export async function createApplication(
  userId: string,
  draft: ApplicationDraft,
  options: { emailId?: string | null; occurredAt?: Date; actor?: "AI" | "USER" | "SYSTEM"; isDemo?: boolean } = {},
): Promise<Application> {
  if (!draft.company?.trim() || !draft.role?.trim()) {
    throw new ValidationError("An application requires both a company and a role");
  }

  const companyKey = normalizeCompany(draft.company);
  const roleKey = normalizeRole(draft.role);
  const status: ApplicationStatus = draft.status ?? "APPLIED";
  const occurredAt = options.occurredAt ?? new Date();

  const application = await prisma.application.create({
    data: {
      userId,
      company: draft.company.trim(),
      role: draft.role.trim(),
      jobId: draft.jobId ?? null,
      applicationRefId: draft.applicationRefId ?? null,
      location: draft.location ?? null,
      employmentType: draft.employmentType ?? null,
      salary: draft.salary ?? null,
      source: draft.source ?? null,
      applicationUrl: draft.applicationUrl ?? null,
      jobUrl: draft.jobUrl ?? null,
      recruiterName: draft.recruiterName ?? null,
      recruiterEmail: draft.recruiterEmail ?? null,
      appliedDate: draft.appliedDate ?? occurredAt,
      status,
      statusChangedAt: occurredAt,
      lastEmailAt: occurredAt,
      companyKey,
      roleKey,
      confidence: draft.confidence ?? null,
      isDemo: options.isDemo ?? false,
      needsReview: false,
    },
  });

  await createEvent({
    userId,
    applicationId: application.id,
    type: "APPLICATION_CREATED",
    actor: options.actor ?? "AI",
    title: "Application created",
    description: `MailOps created this application from a ${draft.source ?? "recruitment"} email.`,
    toStatus: status,
    occurredAt: draft.appliedDate ?? occurredAt,
    emailId: options.emailId ?? null,
    confidence: draft.confidence ?? null,
    isDemo: options.isDemo ?? false,
  });

  await recordAudit({
    userId,
    actor: options.actor ?? "AI",
    action: AUDIT_ACTIONS.applicationCreated,
    entityType: "Application",
    entityId: application.id,
    summary: `${draft.company} — ${draft.role}`,
    metadata: { status, source: draft.source, jobId: draft.jobId },
  });

  return application;
}

export interface CreateEventInput {
  userId: string;
  applicationId: string;
  type: ApplicationEventType;
  actor?: "AI" | "USER" | "SYSTEM";
  title: string;
  description?: string | null;
  fromStatus?: ApplicationStatus | null;
  toStatus?: ApplicationStatus | null;
  occurredAt?: Date;
  dueAt?: Date | null;
  emailId?: string | null;
  confidence?: number | null;
  isDemo?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Appends a timeline event. Events are immutable — there is deliberately no
 * update path, so the history cannot be rewritten by later processing.
 */
export async function createEvent(input: CreateEventInput) {
  return prisma.applicationEvent.create({
    data: {
      userId: input.userId,
      applicationId: input.applicationId,
      type: input.type,
      actor: input.actor ?? "AI",
      title: input.title,
      description: input.description ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      dueAt: input.dueAt ?? null,
      emailId: input.emailId ?? null,
      confidence: input.confidence ?? null,
      isDemo: input.isDemo ?? false,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** True when an event of this type already exists for this email. */
async function eventExists(applicationId: string, emailId: string | null, types: ApplicationEventType[]): Promise<boolean> {
  if (!emailId) return false;
  const count = await prisma.applicationEvent.count({
    where: { applicationId, emailId, type: { in: types } },
  });
  return count > 0;
}

export interface ApplyEmailInput {
  userId: string;
  emailId: string;
  applicationId: string;
  subCategory: JobSubCategory | null;
  category: EmailCategory;
  priority: string;
  confidence: number;
  requiresAction: boolean;
  summary?: string | null;
  occurredAt?: Date;
  dueAt?: Date | null;
  extracted?: Record<string, unknown>;
  isDemo?: boolean;
}

export interface ApplyEmailResult {
  application: Application;
  statusChanged: boolean;
  fromStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  eventsCreated: string[];
}

/**
 * Links an email to an application and applies any status transition it implies.
 *
 * Transition policy:
 *  - REJECTION / WITHDRAWN always apply (terminal states).
 *  - Every other status only moves the application *forward* on the pipeline
 *    ranking, so a late-arriving "application received" email can never rewound
 *    an application that is already at interview stage.
 */
export async function applyEmailToApplication(input: ApplyEmailInput): Promise<ApplyEmailResult> {
  const application = await prisma.application.findFirst({
    where: { id: input.applicationId, userId: input.userId },
  });
  if (!application) throw new NotFoundError("Application");

  const occurredAt = input.occurredAt ?? new Date();
  const targetStatus = input.subCategory ? SUBCATEGORY_TO_STATUS[input.subCategory] ?? null : null;
  const fromStatus = application.status;
  let toStatus = fromStatus;
  let statusChanged = false;

  if (targetStatus) {
    const isTerminal = targetStatus === "REJECTED" || targetStatus === "WITHDRAWN";
    const forward = STATUS_RANK[targetStatus] > STATUS_RANK[fromStatus];
    const sameStatusReaffirmed = targetStatus === fromStatus && input.subCategory === "OFFER_ACCEPTED";
    if (isTerminal || forward || sameStatusReaffirmed) {
      toStatus = targetStatus;
      statusChanged = targetStatus !== fromStatus;
    }
  }

  const eventsCreated: string[] = [];

  // 1. Always record that an email was linked, so the timeline shows evidence.
  const linkType: ApplicationEventType = "EMAIL_LINKED";
  if (!(await eventExists(application.id, input.emailId, [linkType]))) {
    const label = input.subCategory ? SUBCATEGORY_LABELS[input.subCategory] : "Recruitment email";
    await createEvent({
      userId: input.userId,
      applicationId: application.id,
      type: linkType,
      actor: "AI",
      title: label,
      description: input.summary ?? null,
      occurredAt,
      emailId: input.emailId,
      confidence: input.confidence,
      isDemo: input.isDemo,
      metadata: {
        category: input.category,
        subCategory: input.subCategory,
        priority: input.priority,
        extracted: input.extracted ?? {},
      },
    });
    eventsCreated.push(linkType);
  }

  // 2. Record the status transition when one occurs.
  if (statusChanged) {
    const eventType: ApplicationEventType = input.subCategory
      ? SUB_TO_EVENT[input.subCategory] ?? "STATUS_CHANGED"
      : "STATUS_CHANGED";

    await createEvent({
      userId: input.userId,
      applicationId: application.id,
      type: eventType,
      actor: "AI",
      title: input.subCategory ? SUBCATEGORY_LABELS[input.subCategory] : `Status changed to ${STATUS_LABELS[toStatus]}`,
      description: `Status moved from ${STATUS_LABELS[fromStatus]} to ${STATUS_LABELS[toStatus]}.`,
      fromStatus,
      toStatus,
      occurredAt,
      dueAt: input.dueAt ?? null,
      emailId: input.emailId,
      confidence: input.confidence,
      isDemo: input.isDemo,
      metadata: { subCategory: input.subCategory, priority: input.priority },
    });
    eventsCreated.push(eventType);
  }

  // 3. Record an action requirement / deadline independently of status changes.
  if (input.requiresAction && !(await eventExists(application.id, input.emailId, ["ACTION_REQUIRED"]))) {
    await createEvent({
      userId: input.userId,
      applicationId: application.id,
      type: "ACTION_REQUIRED",
      actor: "AI",
      title: "Action required",
      description: input.summary ?? "The employer is waiting on you.",
      occurredAt,
      dueAt: input.dueAt ?? null,
      emailId: input.emailId,
      confidence: input.confidence,
      isDemo: input.isDemo,
    });
    eventsCreated.push("ACTION_REQUIRED");
  }

  const updated = await prisma.application.update({
    where: { id: application.id },
    data: {
      status: toStatus,
      ...(statusChanged ? { statusChangedAt: occurredAt } : {}),
      lastEmailAt: occurredAt,
      ...(input.extracted?.location && !application.location ? { location: String(input.extracted.location) } : {}),
      ...(input.extracted?.jobId && !application.jobId ? { jobId: String(input.extracted.jobId) } : {}),
      ...(input.extracted?.recruiterName && !application.recruiterName
        ? { recruiterName: String(input.extracted.recruiterName) }
        : {}),
      ...(input.extracted?.recruiterEmail && !application.recruiterEmail
        ? { recruiterEmail: String(input.extracted.recruiterEmail) }
        : {}),
    },
  });

  await prisma.email.update({ where: { id: input.emailId }, data: { applicationId: application.id } });

  if (statusChanged) {
    await recordAudit({
      userId: input.userId,
      actor: "AI",
      action: AUDIT_ACTIONS.applicationStatusChanged,
      entityType: "Application",
      entityId: application.id,
      summary: `${application.company} — ${application.role}: ${STATUS_LABELS[fromStatus]} → ${STATUS_LABELS[toStatus]}`,
      metadata: { fromStatus, toStatus, subCategory: input.subCategory, emailId: input.emailId, confidence: input.confidence },
    });
  }

  return {
    application: updated,
    statusChanged,
    fromStatus,
    toStatus,
    eventsCreated,
  };
}

/** -------------------------------------------------------------------------- */
/** Candidate retrieval for matching / duplicate detection                       */
/** -------------------------------------------------------------------------- */

export interface CandidateRecord extends ApplicationIdentity {
  id: string;
  company: string;
  role: string;
  jobId: string | null;
  status: ApplicationStatus;
  appliedDate: string | null;
  lastUpdated: string | null;
  applicationUrl: string | null;
}

/**
 * Finds plausible existing applications for an incoming email. Uses indexed
 * lookups first (normalised company/role keys, exact job id) and widens only
 * when nothing exact is found.
 */
export async function findApplicationCandidates(
  userId: string,
  query: ApplicationCandidatesQuery,
): Promise<CandidateRecord[]> {
  const limit = query.limit ?? 12;
  const companyKey = normalizeCompany(query.company ?? "");
  const roleKey = normalizeRole(query.role ?? "");
  const jobIdKey = normalizeJobId(query.jobId ?? "");

  const or: Prisma.ApplicationWhereInput[] = [];
  if (companyKey) or.push({ companyKey: { contains: companyKey } });
  if (roleKey) or.push({ roleKey: { contains: roleKey } });
  if (query.jobId) or.push({ jobId: { equals: query.jobId } });
  if (companyKey) or.push({ company: { contains: (query.company ?? "").trim(), mode: "insensitive" } } as Prisma.ApplicationWhereInput);

  const candidates = await prisma.application.findMany({
    where: { userId, ...(or.length ? { OR: or } : {}) },
    orderBy: [{ lastEmailAt: "desc" }, { lastUpdated: "desc" }],
    take: Math.max(limit * 3, 30),
  });

  const scored = candidates
    .map((candidate) => {
      const identity = {
        company: query.company ?? "",
        role: query.role ?? "",
        jobId: query.jobId ?? null,
        applicationUrl: query.applicationUrl ?? null,
      };
      const match = matchApplicationIdentity(identity, {
        company: candidate.company,
        role: candidate.role,
        jobId: candidate.jobId,
        applicationUrl: candidate.applicationUrl,
        companyKey: candidate.companyKey,
        roleKey: candidate.roleKey,
      });
      return { candidate, score: match.score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => toCandidateRecord(candidate));

  // Guarantee the exact-job-id row is present even if the prefilter missed it.
  if (jobIdKey && !scored.some((c) => normalizeJobId(c.jobId) === jobIdKey)) {
    const exact = await prisma.application.findFirst({
      where: { userId, jobId: { equals: query.jobId ?? undefined } },
    });
    if (exact) scored.unshift(toCandidateRecord(exact));
  }

  return scored.slice(0, limit);
}

function toCandidateRecord(application: Application): CandidateRecord {
  return {
    id: application.id,
    company: application.company,
    role: application.role,
    jobId: application.jobId,
    status: application.status,
    appliedDate: application.appliedDate ? application.appliedDate.toISOString() : null,
    lastUpdated: application.lastUpdated.toISOString(),
    applicationUrl: application.applicationUrl,
    companyKey: application.companyKey,
    roleKey: application.roleKey,
  };
}

/**
 * Cheap, deterministic duplicate pre-scan. Used before calling the AI duplicate
 * detector so the common case (no plausible duplicate) costs no AI tokens.
 */
export async function findDuplicateCandidates(
  userId: string,
  identity: { company?: string | null; role?: string | null; jobId?: string | null; applicationUrl?: string | null },
): Promise<CandidateRecord[]> {
  if (!identity.company && !identity.role) return [];
  const candidates = await findApplicationCandidates(userId, { ...identity, limit: 10 });

  return candidates.filter((candidate) => {
    const match = matchApplicationIdentity(
      {
        company: identity.company ?? "",
        role: identity.role ?? "",
        jobId: identity.jobId ?? null,
        applicationUrl: identity.applicationUrl ?? null,
      },
      candidate,
    );
    return match.score >= DUPLICATE_THRESHOLD;
  });
}

export interface DuplicateFlag {
  previousApplicationId: string;
  company: string;
  role: string;
  appliedDate: string | null;
  status: ApplicationStatus;
  similarity: number;
  rationale: string;
}

/** Marks a newly created application as a possible duplicate of an earlier one. */
export async function flagPossibleDuplicate(
  userId: string,
  applicationId: string,
  previous: CandidateRecord,
  similarity: number,
): Promise<DuplicateFlag> {
  const rationale =
    `You may have previously applied for a similar role. Previous application: ${previous.company} — ${previous.role}` +
    `${previous.appliedDate ? ` (applied ${previous.appliedDate.slice(0, 10)})` : ""}, currently ${STATUS_LABELS[previous.status]}.`;

  await prisma.application.update({
    where: { id: applicationId },
    data: { needsReview: true },
  });

  const existing = await prisma.applicationEvent.count({
    where: { applicationId, type: "DUPLICATE_FLAGGED" },
  });

  if (existing === 0) {
    await createEvent({
      userId,
      applicationId,
      type: "DUPLICATE_FLAGGED",
      actor: "AI",
      title: "Possible duplicate application",
      description: rationale,
      confidence: similarity,
      metadata: { previousApplicationId: previous.id, previousStatus: previous.status, similarity },
    });
  }

  await recordAudit({
    userId,
    actor: "AI",
    action: AUDIT_ACTIONS.duplicateDetected,
    entityType: "Application",
    entityId: applicationId,
    summary: rationale,
    metadata: { previousApplicationId: previous.id, similarity },
  });

  return {
    previousApplicationId: previous.id,
    company: previous.company,
    role: previous.role,
    appliedDate: previous.appliedDate,
    status: previous.status,
    similarity,
    rationale,
  };
}

/** Resolves the duplicate prompt: the user keeps both, or merges into the old one. */
export async function resolveDuplicate(
  userId: string,
  applicationId: string,
  decision: "CONTINUE" | "MERGE",
): Promise<{ merged: boolean }> {
  const application = await prisma.application.findFirst({
    where: { id: applicationId, userId },
    include: { events: { where: { type: "DUPLICATE_FLAGGED" }, orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!application) throw new NotFoundError("Application");

  if (decision === "CONTINUE") {
    await prisma.application.update({ where: { id: applicationId }, data: { needsReview: false } });
    await createEvent({
      userId,
      applicationId,
      type: "USER_OVERRIDE",
      actor: "USER",
      title: "Continuing with this application",
      description: "The user reviewed the duplicate suggestion and chose to continue.",
    });
    return { merged: false };
  }

  const metadata = (application.events[0]?.metadata ?? {}) as { previousApplicationId?: string };
  const previousId = metadata.previousApplicationId;
  if (!previousId) {
    throw new ValidationError("There is no previous application to merge into");
  }

  const previous = await prisma.application.findFirst({ where: { id: previousId, userId } });
  if (!previous) throw new NotFoundError("Previous application");

  // Merge: re-point emails and timeline entries, then archive the newer record.
  await prisma.$transaction([
    prisma.email.updateMany({ where: { applicationId, userId }, data: { applicationId: previousId } }),
    prisma.applicationEvent.updateMany({ where: { applicationId, userId }, data: { applicationId: previousId } }),
    prisma.notification.updateMany({ where: { applicationId, userId }, data: { applicationId: previousId } }),
    prisma.application.delete({ where: { id: applicationId } }),
  ]);

  await createEvent({
    userId,
    applicationId: previousId,
    type: "USER_OVERRIDE",
    actor: "USER",
    title: "Merged duplicate application",
    description: `A duplicate record for ${application.company} — ${application.role} was merged into this application.`,
  });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.applicationUpdatedByUser,
    entityType: "Application",
    entityId: previousId,
    summary: `Merged duplicate application ${applicationId}`,
  });

  return { merged: true };
}

/** -------------------------------------------------------------------------- */
/** Reads                                                                        */
/** -------------------------------------------------------------------------- */

export interface ApplicationListFilters {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortDir: "asc" | "desc";
  status?: ApplicationStatus | ApplicationStatus[];
  company?: string;
  role?: string;
  location?: string;
  jobId?: string;
  search?: string;
  from?: Date;
  to?: Date;
  needsReview?: boolean;
}

const SORTABLE = ["company", "role", "appliedDate", "status", "lastUpdated", "createdAt"] as const;

export async function listApplications(
  userId: string,
  filters: ApplicationListFilters,
): Promise<{ items: Array<Application & { _count: { events: number; emails: number } }>; page: PageMeta }> {
  const where: Prisma.ApplicationWhereInput = {
    userId,
    ...(filters.status
      ? { status: Array.isArray(filters.status) ? { in: filters.status } : filters.status }
      : {}),
    ...(filters.company ? { company: { contains: filters.company, mode: "insensitive" } } : {}),
    ...(filters.role ? { role: { contains: filters.role, mode: "insensitive" } } : {}),
    ...(filters.location ? { location: { contains: filters.location, mode: "insensitive" } } : {}),
    ...(filters.jobId ? { jobId: { contains: filters.jobId, mode: "insensitive" } } : {}),
    ...(filters.needsReview !== undefined ? { needsReview: filters.needsReview } : {}),
    ...(filters.from || filters.to
      ? {
          appliedDate: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
    ...(filters.search
      ? {
          OR: [
            { company: { contains: filters.search, mode: "insensitive" } },
            { role: { contains: filters.search, mode: "insensitive" } },
            { jobId: { contains: filters.search, mode: "insensitive" } },
            { location: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const sortBy = filters.sortBy && (SORTABLE as readonly string[]).includes(filters.sortBy) ? filters.sortBy : "lastUpdated";

  const [items, total] = await Promise.all([
    prisma.application.findMany({
      where,
      orderBy: { [sortBy]: filters.sortDir },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: { _count: { select: { events: true, emails: true } } },
    }),
    prisma.application.count({ where }),
  ]);

  return { items, page: buildPageMeta(filters.page, filters.pageSize, total) };
}

export async function getApplicationDetail(userId: string, applicationId: string) {
  const application = await prisma.application.findFirst({
    where: { id: applicationId, userId },
    include: {
      events: { orderBy: { occurredAt: "asc" } },
      emails: {
        orderBy: { receivedAt: "desc" },
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          fromName: true,
          receivedAt: true,
          snippet: true,
          processingState: true,
          deletedFromGmail: true,
          deletedFromMailops: true,
          analysis: { select: { category: true, subCategory: true, priority: true, confidence: true, summary: true } },
        },
      },
      notifications: { orderBy: { createdAt: "desc" }, take: 25 },
    },
  });

  if (!application) throw new NotFoundError("Application");
  return application;
}

export async function listRejectedApplications(
  userId: string,
  options: { page: number; pageSize: number; search?: string },
) {
  const where: Prisma.ApplicationWhereInput = {
    userId,
    status: { in: ["REJECTED", "WITHDRAWN"] },
    ...(options.search
      ? {
          OR: [
            { company: { contains: options.search, mode: "insensitive" } },
            { role: { contains: options.search, mode: "insensitive" } },
            { jobId: { contains: options.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.application.findMany({
      where,
      orderBy: { statusChangedAt: "desc" },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
      include: {
        events: {
          where: { type: "REJECTION_RECEIVED" },
          orderBy: { occurredAt: "desc" },
          take: 1,
        },
        emails: {
          where: { analysis: { subCategory: "REJECTION" } },
          orderBy: { receivedAt: "desc" },
          take: 1,
          select: {
            id: true,
            subject: true,
            fromEmail: true,
            receivedAt: true,
            deletedFromGmail: true,
            deletedFromMailops: true,
            snippet: true,
            bodyText: true,
          },
        },
      },
    }),
    prisma.application.count({ where }),
  ]);

  return { items, page: buildPageMeta(options.page, options.pageSize, total) };
}

/** -------------------------------------------------------------------------- */
/** Mutations by the user                                                        */
/** -------------------------------------------------------------------------- */

export async function overrideApplicationStatus(
  userId: string,
  applicationId: string,
  status: ApplicationStatus,
  note?: string,
) {
  const application = await prisma.application.findFirst({ where: { id: applicationId, userId } });
  if (!application) throw new NotFoundError("Application");

  const from = application.status;
  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: { status, statusChangedAt: new Date(), needsReview: false },
  });

  await createEvent({
    userId,
    applicationId,
    type: "USER_OVERRIDE",
    actor: "USER",
    title: `Status set to ${STATUS_LABELS[status]}`,
    description: note ?? `You changed the status from ${STATUS_LABELS[from]} to ${STATUS_LABELS[status]}.`,
    fromStatus: from,
    toStatus: status,
  });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.applicationUpdatedByUser,
    entityType: "Application",
    entityId: applicationId,
    summary: `Status overridden to ${status}`,
    metadata: { from, to: status },
  });

  return updated;
}

export interface ApplicationFieldPatch {
  company?: string;
  role?: string;
  location?: string | null;
  jobId?: string | null;
  applicationUrl?: string | null;
  salary?: string | null;
  recruiterName?: string | null;
  recruiterEmail?: string | null;
  notes?: string | null;
}

export async function updateApplicationFields(
  userId: string,
  applicationId: string,
  patch: ApplicationFieldPatch,
) {
  const application = await prisma.application.findFirst({ where: { id: applicationId, userId } });
  if (!application) throw new NotFoundError("Application");

  const data: Prisma.ApplicationUpdateInput = {};
  if (patch.company !== undefined) {
    data.company = patch.company;
    data.companyKey = normalizeCompany(patch.company);
  }
  if (patch.role !== undefined) {
    data.role = patch.role;
    data.roleKey = normalizeRole(patch.role);
  }
  if (patch.location !== undefined) data.location = patch.location;
  if (patch.jobId !== undefined) data.jobId = patch.jobId;
  if (patch.applicationUrl !== undefined) data.applicationUrl = patch.applicationUrl;
  if (patch.salary !== undefined) data.salary = patch.salary;
  if (patch.recruiterName !== undefined) data.recruiterName = patch.recruiterName;
  if (patch.recruiterEmail !== undefined) data.recruiterEmail = patch.recruiterEmail;
  if (patch.notes !== undefined) data.notes = patch.notes;

  const updated = await prisma.application.update({ where: { id: applicationId }, data });

  await createEvent({
    userId,
    applicationId,
    type: "NOTE_ADDED",
    actor: "USER",
    title: "Application details updated",
    description: patch.notes ?? "You edited this application's details.",
    metadata: { fields: Object.keys(data) },
  });

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.applicationUpdatedByUser,
    entityType: "Application",
    entityId: applicationId,
    summary: "Application details updated",
    metadata: { fields: Object.keys(data) },
  });

  return updated;
}

export async function addApplicationNote(userId: string, applicationId: string, note: string) {
  const application = await prisma.application.findFirst({ where: { id: applicationId, userId } });
  if (!application) throw new NotFoundError("Application");

  return createEvent({
    userId,
    applicationId,
    type: "NOTE_ADDED",
    actor: "USER",
    title: "Note added",
    description: note,
  });
}

/** Adds a deadline the user cares about (e.g. a follow-up reminder). */
export async function addApplicationDeadline(userId: string, applicationId: string, dueAt: Date, label: string) {
  const application = await prisma.application.findFirst({ where: { id: applicationId, userId } });
  if (!application) throw new NotFoundError("Application");

  return createEvent({
    userId,
    applicationId,
    type: "DEADLINE_SET",
    actor: "USER",
    title: label,
    dueAt,
    description: `You set this deadline for ${dueAt.toISOString().slice(0, 10)}.`,
  });
}

/** -------------------------------------------------------------------------- */
/** Summary metrics                                                              */
/** -------------------------------------------------------------------------- */

export interface ApplicationSummary {
  total: number;
  thisWeek: number;
  thisMonth: number;
  shortlisted: number;
  assessments: number;
  interviews: number;
  offers: number;
  rejected: number;
  withdrawn: number;
  active: number;
  needsReview: number;
  byStatus: Record<string, number>;
}

export async function getApplicationSummary(userId: string): Promise<ApplicationSummary> {
  const now = new Date();
  const weekStart = new Date(now);
  const day = (weekStart.getUTCDay() + 6) % 7;
  weekStart.setUTCDate(weekStart.getUTCDate() - day);
  weekStart.setUTCHours(0, 0, 0, 0);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [grouped, total, thisWeek, thisMonth, needsReview] = await Promise.all([
    prisma.application.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    prisma.application.count({ where: { userId } }),
    prisma.application.count({ where: { userId, appliedDate: { gte: weekStart } } }),
    prisma.application.count({ where: { userId, appliedDate: { gte: monthStart } } }),
    prisma.application.count({ where: { userId, needsReview: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of grouped) byStatus[row.status] = row._count._all;

  return {
    total,
    thisWeek,
    thisMonth,
    shortlisted: byStatus.SHORTLISTED ?? 0,
    assessments: byStatus.ASSESSMENT ?? 0,
    interviews: byStatus.INTERVIEW ?? 0,
    offers: (byStatus.OFFER ?? 0) + (byStatus.ACCEPTED ?? 0),
    rejected: byStatus.REJECTED ?? 0,
    withdrawn: byStatus.WITHDRAWN ?? 0,
    active: (byStatus.APPLIED ?? 0) + (byStatus.ACKNOWLEDGED ?? 0) + (byStatus.SHORTLISTED ?? 0) + (byStatus.ASSESSMENT ?? 0) + (byStatus.INTERVIEW ?? 0) + (byStatus.FINAL_ROUND ?? 0),
    needsReview,
    byStatus,
  };
}

/** Similarity between two free-text values; re-exported for the review UI. */
export function similarity(a: string, b: string): number {
  return blendedSimilarity(normalizeUrl(a), normalizeUrl(b));
}

export { logger };
