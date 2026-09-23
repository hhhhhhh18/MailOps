import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { requireAuth, blockDemoWrites } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import {
  disconnect,
  disconnectSchema,
  listAccounts,
  oauthCallback,
  runScanInline,
  scanSchema,
  scanStatus,
  startOAuth,
  triggerScan,
  oauthStartSchema,
} from "../controllers/gmail.controller";

/**
 * Gmail integration routes.
 *
 * /oauth/callback is intentionally public: Google's redirect arrives without our
 * session cookie in some browsers, and the CSRF protection is the single-use,
 * user-bound `state` parameter instead.
 */
export const gmailRouter = Router();

gmailRouter.get("/oauth/callback", asyncHandler(oauthCallback));
gmailRouter.post("/oauth/start", requireAuth, blockDemoWrites, validateBody(oauthStartSchema), asyncHandler(startOAuth));

gmailRouter.get("/accounts", requireAuth, asyncHandler(listAccounts));
gmailRouter.post("/disconnect", requireAuth, blockDemoWrites, validateBody(disconnectSchema), asyncHandler(disconnect));

gmailRouter.post("/scan", requireAuth, blockDemoWrites, validateBody(scanSchema), asyncHandler(triggerScan));
gmailRouter.post("/scan/inline", requireAuth, blockDemoWrites, validateBody(scanSchema), asyncHandler(runScanInline));
gmailRouter.get("/scan/status", requireAuth, asyncHandler(scanStatus));
