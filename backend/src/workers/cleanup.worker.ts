import { Worker, type Job } from "bullmq";
import type { EmailCategory } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { JOBS, QUEUES } from "../config/constants";
import { prisma } from "../config/prisma";
import { checkProtection, proposeCleanupForEmail, runRetentionSweep } from "../services/cleanup/cleanup.service";
import { describeError } from "../utils/errors";

export interface CleanupJobData {
  userId?: string;
  batchId?: string;
  emailIds?: string[];
}

/**
 * cleanup worker.
 *
 * Note what it does NOT do: it never deletes mail. It only builds proposals (so
 * the user has something to review) and enforces retention on stored records.
 * Actual deletion happens exclusively through POST /api/cleanup/approve, in the
 * request path, where the approval payload is present.
 */
export function createCleanupWorker(): Worker {
  return new Worker(
    QUEUES.cleanup,
    async (job: Job<CleanupJobData>) => {
      if (job.name === JOBS.retentionSweep) {
        const result = await runRetentionSweep(job.data?.userId);
        logger.info(result, "retention sweep completed");
        return result;
      }

      if (job.name === JOBS.proposeCleanup) {
        return proposeCleanupForUser(job.data.userId);
      }

      // execute-cleanup jobs are intentionally unsupported: destruction requires
      // an explicit per-batch approval in the API request path.
      if (job.name === JOBS.executeCleanup) {
        logger.warn({ jobId: job.id }, "execute-cleanup jobs are not processed by the queue; use the approval endpoint");
        return { skipped: true, reason: "requires explicit user approval through POST /api/cleanup/approve" };
      }

      return { skipped: true, reason: `unknown cleanup job ${job.name}` };
    },
    {
      connection: redis,
      // Retention sweeps touch many rows; a single concurrent run avoids lock contention.
      concurrency: 1,
    },
  );
}

/**
 * Scans analysed mail for cleanup candidates and records proposals.
 * Bounded per run so a large backlog cannot exhaust the worker.
 */
async function proposeCleanupForUser(userId?: string): Promise<{ proposed: number; blocked: number; scanned: number }> {
  const settings = userId ? await prisma.userSettings.findUnique({ where: { userId } }) : null;
  const categories = (settings?.cleanupCategories ?? ["PROMOTIONAL", "SPAM", "NEWSLETTER"]) as EmailCategory[];

  /**
   * Candidates are emails the classifier already marked unwanted, that are not
   * linked to an application, and that have no cleanup record yet. The query is
   * bounded so a large backlog cannot exhaust the worker.
   */
  const candidates = await prisma.email.findMany({
    where: {
      ...(userId ? { userId } : {}),
      processingState: { in: ["PROCESSED", "NEEDS_REVIEW"] },
      applicationId: null,
      cleanupActions: { none: {} },
      analysis: {
        is: {
          category: { in: categories },
          isUnwanted: true,
        },
      },
    },
    take: 500,
    include: { analysis: true },
  });

  let proposed = 0;
  let blocked = 0;

  for (const email of candidates) {
    if (!email.analysis) continue;

    const protection = checkProtection(
      {
        category: email.analysis.category,
        subCategory: email.analysis.subCategory,
        fromEmail: email.fromEmail,
        applicationId: email.applicationId,
        labels: email.labels,
      },
      settings,
    );

    const action = await proposeCleanupForEmail(
      email.userId,
      email.id,
      {
        category: email.analysis.category,
        subCategory: email.analysis.subCategory,
        isUnwanted: true,
        unwantedReason: email.analysis.unwantedReason,
      },
      { fromEmail: email.fromEmail, applicationId: email.applicationId, labels: email.labels },
    );

    if (action) {
      if (protection.protected) blocked += 1;
      else proposed += 1;
    }
  }

  logger.info({ proposed, blocked, scanned: candidates.length }, "cleanup proposals generated");
  return { proposed, blocked, scanned: candidates.length };
}

export function attachCleanupLogging(worker: Worker): void {
  worker.on("failed", (job, error) => {
    const { message, name: errorName } = describeError(error);
    logger.error({ jobId: job?.id, jobName: job?.name, errorName, message }, "cleanup job failed");
  });
}
