import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { dashboard, overview, overviewQuerySchema, systemStatus } from "../controllers/analytics.controller";

export const dashboardRouter = Router();
dashboardRouter.get("/", requireAuth, asyncHandler(dashboard));
dashboardRouter.get("/system", requireAuth, asyncHandler(systemStatus));

export const analyticsRouter = Router();
analyticsRouter.get("/", requireAuth, validate({ query: overviewQuerySchema }), asyncHandler(overview));
analyticsRouter.get("/overview", requireAuth, validate({ query: overviewQuerySchema }), asyncHandler(overview));
