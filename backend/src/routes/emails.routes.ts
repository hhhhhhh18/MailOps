import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import { validate, validateBody } from "../middleware/validate";
import { counters, detail, emailIdParamSchema, list, overrideAnalysis, reprocess, resolveReview, reviewQueue } from "../controllers/emails.controller";
import { emailFiltersSchema, analysisOverrideSchema, reviewDecisionSchema } from "../services/emails/emails.service";

export const emailsRouter = Router();

emailsRouter.get("/", requireAuth, validate({ query: emailFiltersSchema }), asyncHandler(list));
emailsRouter.get("/counters", requireAuth, asyncHandler(counters));
emailsRouter.get("/review-queue", requireAuth, asyncHandler(reviewQueue));
emailsRouter.get("/:emailId", requireAuth, validate({ params: emailIdParamSchema }), asyncHandler(detail));

// AI decisions remain overridable by the user at all times.
emailsRouter.patch(
  "/:emailId/analysis",
  requireAuth,
  validate({ params: emailIdParamSchema, body: analysisOverrideSchema }),
  asyncHandler(overrideAnalysis),
);

emailsRouter.post(
  "/:emailId/review",
  requireAuth,
  validate({ params: emailIdParamSchema, body: reviewDecisionSchema }),
  asyncHandler(resolveReview),
);

emailsRouter.post("/:emailId/reprocess", requireAuth, validate({ params: emailIdParamSchema }), asyncHandler(reprocess));

export { validateBody };
