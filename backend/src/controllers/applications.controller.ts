import type { Request, Response } from "express";
import { z } from "zod";
import { currentUserId } from "../middleware/auth";
import { ok, paginated } from "../utils/http";
import {
  addApplicationDeadline,
  addApplicationNote,
  getApplicationDetail,
  getApplicationSummary,
  listApplications,
  listRejectedApplications,
  overrideApplicationStatus,
  resolveDuplicate,
  updateApplicationFields,
  type ApplicationListFilters,
} from "../services/applications/application.service";

const STATUS_VALUES = [
  "APPLIED",
  "ACKNOWLEDGED",
  "SHORTLISTED",
  "ASSESSMENT",
  "INTERVIEW",
  "FINAL_ROUND",
  "OFFER",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
  "ON_HOLD",
  "NO_RESPONSE",
] as const;

export const applicationIdParamSchema = z.object({ applicationId: z.string().min(1).max(64) });

export const applicationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(["company", "role", "appliedDate", "status", "lastUpdated", "createdAt"]).optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  status: z.union([z.enum(STATUS_VALUES), z.array(z.enum(STATUS_VALUES))]).optional(),
  company: z.string().trim().max(120).optional(),
  role: z.string().trim().max(120).optional(),
  location: z.string().trim().max(120).optional(),
  jobId: z.string().trim().max(64).optional(),
  search: z.string().trim().max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  needsReview: z.coerce.boolean().optional(),
});

export async function list(req: Request, res: Response) {
  const userId = currentUserId(req);
  const query = req.query as unknown as z.infer<typeof applicationListQuerySchema>;

  const filters: ApplicationListFilters = {
    page: query.page,
    pageSize: query.pageSize,
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    status: query.status,
    company: query.company,
    role: query.role,
    location: query.location,
    jobId: query.jobId,
    search: query.search,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
    needsReview: query.needsReview,
  };

  const { items, page } = await listApplications(userId, filters);
  return paginated(res, items, page);
}

export async function detail(req: Request, res: Response) {
  const userId = currentUserId(req);
  const application = await getApplicationDetail(userId, req.params.applicationId);
  return ok(res, application);
}

export async function summary(req: Request, res: Response) {
  const userId = currentUserId(req);
  return ok(res, await getApplicationSummary(userId));
}

export const rejectedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
});

export async function rejected(req: Request, res: Response) {
  const userId = currentUserId(req);
  const query = req.query as unknown as z.infer<typeof rejectedQuerySchema>;
  const { items, page } = await listRejectedApplications(userId, query);

  return paginated(
    res,
    items.map((application) => ({
      id: application.id,
      company: application.company,
      role: application.role,
      jobId: application.jobId,
      appliedDate: application.appliedDate,
      rejectedDate: application.statusChangedAt,
      status: application.status,
      location: application.location,
      /** Kept even when the Gmail message is gone (product requirement). */
      originalEmail: application.emails[0]
        ? {
            id: application.emails[0].id,
            subject: application.emails[0].subject,
            fromEmail: application.emails[0].fromEmail,
            receivedAt: application.emails[0].receivedAt,
            snippet: application.emails[0].snippet,
            bodyAvailable: Boolean(application.emails[0].bodyText),
            deletedFromGmail: application.emails[0].deletedFromGmail,
          }
        : null,
      rejectionEvent: application.events[0]
        ? {
            id: application.events[0].id,
            title: application.events[0].title,
            description: application.events[0].description,
            occurredAt: application.events[0].occurredAt,
            confidence: application.events[0].confidence,
          }
        : null,
    })),
    page,
  );
}

export const statusOverrideSchema = z.object({
  status: z.enum(STATUS_VALUES),
  note: z.string().trim().max(300).optional(),
});

export async function overrideStatus(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = req.body as z.infer<typeof statusOverrideSchema>;
  const updated = await overrideApplicationStatus(userId, req.params.applicationId, body.status, body.note);
  return ok(res, updated);
}

export const updateApplicationSchema = z
  .object({
    company: z.string().trim().min(1).max(160).optional(),
    role: z.string().trim().min(1).max(160).optional(),
    location: z.string().trim().max(120).nullable().optional(),
    jobId: z.string().trim().max(64).nullable().optional(),
    applicationUrl: z.string().trim().max(500).nullable().optional(),
    salary: z.string().trim().max(160).nullable().optional(),
    recruiterName: z.string().trim().max(120).nullable().optional(),
    recruiterEmail: z.string().trim().max(160).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

export async function update(req: Request, res: Response) {
  const userId = currentUserId(req);
  const patch = req.body as z.infer<typeof updateApplicationSchema>;
  const updated = await updateApplicationFields(userId, req.params.applicationId, patch);
  return ok(res, updated);
}

export const noteSchema = z.object({
  note: z.string().trim().min(1).max(4000),
  dueAt: z.string().datetime().optional(),
});

export async function addNote(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = req.body as z.infer<typeof noteSchema>;

  const event = body.dueAt
    ? await addApplicationDeadline(userId, req.params.applicationId, new Date(body.dueAt), body.note)
    : await addApplicationNote(userId, req.params.applicationId, body.note);

  return ok(res, event, undefined, 201);
}

export const duplicateDecisionSchema = z.object({ decision: z.enum(["CONTINUE", "MERGE"]) });

export async function duplicateDecision(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = req.body as z.infer<typeof duplicateDecisionSchema>;
  const result = await resolveDuplicate(userId, req.params.applicationId, body.decision);
  return ok(res, result);
}
