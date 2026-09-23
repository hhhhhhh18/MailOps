import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { requireAuth, blockDemoWrites } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  approve,
  approveSchema,
  cleanupActionParamSchema,
  cleanupListQuerySchema,
  list,
  revert,
  summary,
} from "../controllers/cleanup.controller";

/**
 * Cleanup routes.
 *
 * Read endpoints propose; the single POST /approve endpoint executes. There is
 * deliberately no endpoint that deletes without a per-batch approval payload.
 */
export const cleanupRouter = Router();

cleanupRouter.get("/", requireAuth, validate({ query: cleanupListQuerySchema }), asyncHandler(list));
cleanupRouter.get("/summary", requireAuth, asyncHandler(summary));
cleanupRouter.post("/approve", requireAuth, blockDemoWrites, validate({ body: approveSchema }), asyncHandler(approve));
cleanupRouter.post(
  "/:cleanupActionId/revert",
  requireAuth,
  blockDemoWrites,
  validate({ params: cleanupActionParamSchema }),
  asyncHandler(revert),
);
