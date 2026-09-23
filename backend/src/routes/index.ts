import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { analyticsRouter, dashboardRouter } from "./analytics.routes";
import { applicationsRouter } from "./applications.routes";
import { authRouter } from "./auth.routes";
import { cleanupRouter } from "./cleanup.routes";
import { emailsRouter } from "./emails.routes";
import { gmailRouter } from "./gmail.routes";
import { notificationsRouter } from "./notifications.routes";
import { settingsRouter } from "./settings.routes";
import { integrationKindSchema } from "../controllers/settings.controller";
import { listIntegrationStatus } from "../services/notifications/integration-resolver";
import { currentUserId } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { ok } from "../utils/http";

/**
 * API surface.
 *
 *   /api/auth            identity + session
 *   /api/gmail           Gmail OAuth, accounts, scanning
 *   /api/emails          processed mail + AI analysis + overrides
 *   /api/applications    application intelligence + timeline
 *   /api/notifications   feed, acknowledgement, escalation controls
 *   /api/cleanup         proposals + approved execution
 *   /api/analytics       metrics
 *   /api/dashboard       aggregated morning view
 *   /api/settings        settings, integrations, audit, privacy
 */
export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/gmail", gmailRouter);
apiRouter.use("/emails", emailsRouter);
apiRouter.use("/applications", applicationsRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/cleanup", cleanupRouter);
apiRouter.use("/analytics", analyticsRouter);
apiRouter.use("/dashboard", dashboardRouter);
apiRouter.use("/settings", settingsRouter);

/** Convenience alias so the client can read integration state without settings. */
apiRouter.get("/integrations", requireAuth, asyncHandler(async (req, res) => {
  const userId = currentUserId(req);
  return ok(res, await listIntegrationStatus(userId));
}));

apiRouter.get(
  "/integrations/:kind",
  requireAuth,
  validate({ params: integrationKindSchema }),
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const all = await listIntegrationStatus(userId);
    return ok(res, all.find((integration) => integration.kind === req.params.kind) ?? null);
  }),
);

/** Canonical taxonomy so the UI never hard-codes enums. */
apiRouter.get("/meta/taxonomy", asyncHandler(async (_req, res) =>
  ok(res, {
    emailCategories: ["JOB", "PROMOTIONAL", "SPAM", "NEWSLETTER", "SOCIAL", "PERSONAL", "TRANSACTIONAL", "OTHER"],
    jobSubCategories: [
      "APPLICATION_RECEIVED",
      "APPLICATION_ACKNOWLEDGED",
      "SHORTLISTED",
      "ASSESSMENT",
      "INTERVIEW",
      "NEXT_ROUND",
      "FINAL_ROUND",
      "RECRUITER_CONTACT",
      "OFFER",
      "OFFER_ACCEPTED",
      "REJECTION",
      "WITHDRAWN",
      "JOB_ALERT",
      "OTHER_JOB",
    ],
    applicationStatuses: [
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
    ],
    priorities: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    channels: ["DASHBOARD", "SLACK", "WHATSAPP", "EMAIL", "VOICE"],
    escalationStages: ["SLACK", "WHATSAPP", "VOICE"],
    cleanupActions: ["DELETE", "ARCHIVE", "KEEP", "IGNORE_SENDER"],
    voiceEventKeys: ["OFFER", "INTERVIEW", "ASSESSMENT", "RECRUITER_ACTION", "DEADLINE_APPROACHING"],
  }),
));
