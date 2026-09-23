import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  addNote,
  applicationIdParamSchema,
  applicationListQuerySchema,
  detail,
  duplicateDecision,
  duplicateDecisionSchema,
  list,
  noteSchema,
  overrideStatus,
  rejected,
  rejectedQuerySchema,
  statusOverrideSchema,
  summary,
  update,
  updateApplicationSchema,
} from "../controllers/applications.controller";

export const applicationsRouter = Router();

applicationsRouter.get("/", requireAuth, validate({ query: applicationListQuerySchema }), asyncHandler(list));
applicationsRouter.get("/summary", requireAuth, asyncHandler(summary));
applicationsRouter.get("/rejected", requireAuth, validate({ query: rejectedQuerySchema }), asyncHandler(rejected));
applicationsRouter.get("/:applicationId", requireAuth, validate({ params: applicationIdParamSchema }), asyncHandler(detail));

applicationsRouter.patch(
  "/:applicationId",
  requireAuth,
  validate({ params: applicationIdParamSchema, body: updateApplicationSchema }),
  asyncHandler(update),
);

applicationsRouter.post(
  "/:applicationId/status",
  requireAuth,
  validate({ params: applicationIdParamSchema, body: statusOverrideSchema }),
  asyncHandler(overrideStatus),
);

applicationsRouter.post(
  "/:applicationId/notes",
  requireAuth,
  validate({ params: applicationIdParamSchema, body: noteSchema }),
  asyncHandler(addNote),
);

applicationsRouter.post(
  "/:applicationId/duplicate-decision",
  requireAuth,
  validate({ params: applicationIdParamSchema, body: duplicateDecisionSchema }),
  asyncHandler(duplicateDecision),
);
