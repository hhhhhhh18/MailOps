import type { Request, Response } from "express";
import { z } from "zod";
import { currentUserId } from "../middleware/auth";
import { ok, paginated } from "../utils/http";
import {
  executeCleanupBatch,
  getCleanupSummary,
  listCleanupProposals,
  revertCleanupAction,
} from "../services/cleanup/cleanup.service";

export const cleanupListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["PROPOSED", "APPROVED", "EXECUTED", "FAILED", "SKIPPED", "REVERTED", "BLOCKED"]).optional(),
  category: z.enum(["JOB", "PROMOTIONAL", "SPAM", "NEWSLETTER", "SOCIAL", "PERSONAL", "TRANSACTIONAL", "OTHER"]).optional(),
  batchId: z.string().max(64).optional(),
  sender: z.string().max(200).optional(),
});

export async function list(req: Request, res: Response) {
  const userId = currentUserId(req);
  const query = req.query as unknown as z.infer<typeof cleanupListQuerySchema>;
  const { items, page } = await listCleanupProposals(userId, query);
  return paginated(res, items, page);
}

export async function summary(req: Request, res: Response) {
  const userId = currentUserId(req);
  return ok(res, await getCleanupSummary(userId));
}

export const approveSchema = z.object({
  emailIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  action: z.enum(["DELETE", "ARCHIVE", "KEEP", "IGNORE_SENDER"]),
});

/**
 * The only path that can delete or archive mail.
 *
 * Approval is explicit and per batch — there is no "always allow" flag on this
 * endpoint, and protection rules are re-checked server-side for every item.
 */
export async function approve(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = req.body as z.infer<typeof approveSchema>;

  const result = await executeCleanupBatch({
    userId,
    emailIds: body.emailIds,
    action: body.action,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  return ok(res, {
    ...result,
    message:
      body.action === "KEEP"
        ? `${result.skipped} email(s) kept. Nothing was removed from Gmail.`
        : `${result.executed} email(s) processed. ${result.blocked.length} protected item(s) were left untouched.`,
  });
}

export const cleanupActionParamSchema = z.object({ cleanupActionId: z.string().min(1).max(64) });

export async function revert(req: Request, res: Response) {
  const userId = currentUserId(req);
  const result = await revertCleanupAction(userId, req.params.cleanupActionId);
  return ok(res, result);
}
