import type { Request, Response } from "express";
import { z } from "zod";
import { currentUserId } from "../middleware/auth";
import { paginated, ok } from "../utils/http";
import {
  analysisOverrideSchema,
  emailFiltersSchema,
  getEmailCounters,
  getEmailDetail,
  listEmails,
  listReviewQueue,
  overrideEmailAnalysis,
  reprocessEmail,
  resolveReviewDecision,
  reviewDecisionSchema,
} from "../services/emails/emails.service";

export const emailIdParamSchema = z.object({ emailId: z.string().min(1).max(64) });

export async function list(req: Request, res: Response) {
  const userId = currentUserId(req);
  const filters = req.query as unknown as z.infer<typeof emailFiltersSchema>;
  const { items, page } = await listEmails(userId, filters);
  return paginated(res, items, page);
}

export async function detail(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { emailId } = req.params;
  const email = await getEmailDetail(userId, emailId);

  return ok(res, {
    ...email,
    /** The UI renders this instead of exposing raw model output. */
    aiAnalysis: email.analysis
      ? {
          category: email.analysis.category,
          subCategory: email.analysis.subCategory,
          priority: email.analysis.priority,
          confidence: email.analysis.confidence,
          requiresAction: email.analysis.requiresAction,
          needsReview: email.analysis.needsReview,
          summary: email.analysis.summary,
          reasoning: email.analysis.reasoning,
          provider: email.analysis.provider,
          model: email.analysis.model,
          promptVersion: email.analysis.promptVersion,
          analysedAt: email.analysis.createdAt,
        }
      : null,
  });
}

export async function counters(req: Request, res: Response) {
  const userId = currentUserId(req);
  return ok(res, await getEmailCounters(userId));
}

export async function reviewQueue(req: Request, res: Response) {
  const userId = currentUserId(req);
  return ok(res, await listReviewQueue(userId));
}

export async function overrideAnalysis(req: Request, res: Response) {
  const userId = currentUserId(req);
  const override = req.body as z.infer<typeof analysisOverrideSchema>;
  const updated = await overrideEmailAnalysis(userId, req.params.emailId, override);
  return ok(res, updated);
}

export async function resolveReview(req: Request, res: Response) {
  const userId = currentUserId(req);
  const decision = req.body as z.infer<typeof reviewDecisionSchema>;
  const result = await resolveReviewDecision(userId, req.params.emailId, decision);
  return ok(res, result);
}

export async function reprocess(req: Request, res: Response) {
  const userId = currentUserId(req);
  const result = await reprocessEmail(userId, req.params.emailId);
  return ok(res, result, undefined, 202);
}
