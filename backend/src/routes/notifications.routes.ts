import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  acknowledge,
  ackSchema,
  counts,
  list,
  notificationIdParamSchema,
  notificationListQuerySchema,
  pause,
  pauseSchema,
  reconcile,
  resolve,
  retry,
  sweep,
} from "../controllers/notifications.controller";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, validate({ query: notificationListQuerySchema }), asyncHandler(list));
notificationsRouter.get("/counts", requireAuth, asyncHandler(counts));

// Acknowledgement is the single control that stops the escalation ladder.
notificationsRouter.post(
  "/:notificationId/acknowledge",
  requireAuth,
  validate({ params: notificationIdParamSchema, body: ackSchema }),
  asyncHandler(acknowledge),
);

notificationsRouter.post("/:notificationId/resolve", requireAuth, validate({ params: notificationIdParamSchema }), asyncHandler(resolve));
notificationsRouter.post(
  "/:notificationId/pause",
  requireAuth,
  validate({ params: notificationIdParamSchema, body: pauseSchema }),
  asyncHandler(pause),
);
notificationsRouter.post("/:notificationId/retry", requireAuth, validate({ params: notificationIdParamSchema }), asyncHandler(retry));

notificationsRouter.post("/reconcile", requireAuth, asyncHandler(reconcile));
notificationsRouter.post("/sweep", requireAuth, asyncHandler(sweep));
