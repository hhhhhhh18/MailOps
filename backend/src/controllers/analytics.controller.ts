import type { Request, Response } from "express";
import { z } from "zod";
import { currentUserId } from "../middleware/auth";
import { ok } from "../utils/http";
import { getAnalyticsOverview, getResponseTimeByCompany } from "../services/analytics/analytics.service";
import { getDashboard, subCategoryLabel } from "../services/dashboard/dashboard.service";
import { getQueueHealth } from "../queues";

export const overviewQuerySchema = z.object({
  weeks: z.coerce.number().int().min(4).max(52).default(12),
});

export async function overview(req: Request, res: Response) {
  const userId = currentUserId(req);
  const query = req.query as unknown as z.infer<typeof overviewQuerySchema>;
  const [data, responseTime] = await Promise.all([
    getAnalyticsOverview(userId, query.weeks),
    getResponseTimeByCompany(userId),
  ]);
  return ok(res, { ...data, responseTimeByCompany: responseTime });
}

export async function dashboard(req: Request, res: Response) {
  const userId = currentUserId(req);
  const payload = await getDashboard(userId);

  // Attach human labels so the client does not duplicate the taxonomy.
  const important = payload.importantEmails.map((email) => ({
    ...email,
    subCategoryLabel: email.subCategoryLabel ?? subCategoryLabel(email.subCategory),
  }));

  return ok(res, { ...payload, importantEmails: important });
}

/**
 * Operational health for the scan panel: queue depth + datastore reachability.
 * Deliberately non-throwing so a Redis outage still renders the dashboard.
 */
export async function systemStatus(_req: Request, res: Response) {
  const queueHealth = await getQueueHealth().catch(() => []);
  return ok(res, {
    queues: queueHealth,
    queueAvailable: queueHealth.some((q) => q.available),
    degraded: queueHealth.length > 0 && queueHealth.every((q) => !q.available),
  });
}
