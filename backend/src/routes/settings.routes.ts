import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { requireAuth, blockDemoWrites } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  auditLog,
  auditQuerySchema,
  deleteDataSchema,
  deleteEmailData,
  diagnostics,
  disconnectIntegration,
  exportData,
  getSettings,
  integrationKindSchema,
  integrationUpdateSchema,
  patchSettings,
  privacy,
  retentionSweep,
  updateIntegration,
} from "../controllers/settings.controller";
import { settingsPatchSchema } from "../services/settings/settings.service";

export const settingsRouter = Router();

settingsRouter.get("/", requireAuth, asyncHandler(getSettings));
settingsRouter.patch("/", requireAuth, validate({ body: settingsPatchSchema }), asyncHandler(patchSettings));

// Integrations
settingsRouter.put(
  "/integrations/:kind",
  requireAuth,
  blockDemoWrites,
  validate({ params: integrationKindSchema, body: integrationUpdateSchema }),
  asyncHandler(updateIntegration),
);
settingsRouter.delete(
  "/integrations/:kind",
  requireAuth,
  blockDemoWrites,
  validate({ params: integrationKindSchema }),
  asyncHandler(disconnectIntegration),
);

// Audit trail
settingsRouter.get("/audit", requireAuth, validate({ query: auditQuerySchema }), asyncHandler(auditLog));

// Privacy controls
settingsRouter.get("/privacy", requireAuth, asyncHandler(privacy));
settingsRouter.get("/privacy/export", requireAuth, asyncHandler(exportData));
settingsRouter.delete(
  "/privacy/email-data",
  requireAuth,
  blockDemoWrites,
  validate({ body: deleteDataSchema }),
  asyncHandler(deleteEmailData),
);
settingsRouter.post("/privacy/retention-sweep", requireAuth, asyncHandler(retentionSweep));

settingsRouter.get("/diagnostics", requireAuth, asyncHandler(diagnostics));
