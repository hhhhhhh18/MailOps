import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { currentUserId } from "../middleware/auth";
import { safeRedirectPath } from "../middleware/security";
import { ok } from "../utils/http";
import { AppError, ERROR_CODES, NotFoundError } from "../utils/errors";
import {
  buildConsentUrl,
  connectGmailAccount,
  consumeState,
  disconnectGmailAccount,
  isGmailConfigured,
} from "../services/gmail/oauth.service";
import { describeScopes, auditGrantedScopes } from "../services/gmail/scopes";
import { getScanJobs, getScanSchedule, scanGmailAccount } from "../services/gmail/sync.service";
import { enqueueAccountScan } from "../queues";
import { AUDIT_ACTIONS, recordAudit } from "../services/audit/audit.service";

export const oauthStartSchema = z.object({
  /** Same-app path to return to after the Google round trip. */
  returnTo: z.string().max(300).optional(),
});

/** Returns the consent URL and the exact permission set the user will be asked for. */
export async function startOAuth(req: Request, res: Response) {
  const userId = currentUserId(req);

  if (!isGmailConfigured()) {
    throw new AppError(
      "Gmail is not configured on this server. An administrator must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      { statusCode: 503, code: ERROR_CODES.INTEGRATION_NOT_CONFIGURED, degraded: true },
    );
  }

  const returnTo = safeRedirectPath(req.body?.returnTo);
  const url = buildConsentUrl(userId);

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.gmailConnected,
    entityType: "GmailAccount",
    summary: "Started the Gmail connection flow",
    metadata: { scopes: describeScopes().map((s) => s.scope) },
    ip: req.ip ?? null,
  });

  return ok(res, {
    consentUrl: url,
    returnTo,
    scopes: describeScopes(),
    /** Surfaced verbatim in the connect dialog so consent is informed. */
    explanation:
      "MailOps asks for read access plus permission to archive or trash, because cleanup only happens after you approve each batch. It never sends mail on your behalf and cannot read your Google Drive, Contacts or Calendar.",
  });
}

/**
 * OAuth callback. Google redirects the browser here, so this endpoint responds
 * with a redirect to the app rather than JSON.
 */
export async function oauthCallback(req: Request, res: Response) {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const errorParam = typeof req.query.error === "string" ? req.query.error : undefined;

  const webBase = env.WEB_BASE_URL.replace(/\/$/, "");

  if (errorParam) {
    return res.redirect(`${webBase}/settings?section=gmail&gmail=denied&reason=${encodeURIComponent(errorParam)}`);
  }
  if (!code) {
    return res.redirect(`${webBase}/settings?section=gmail&gmail=failed&reason=missing_code`);
  }

  try {
    // State is single-use and bound to the user who started the flow.
    const userId = consumeState(state);
    const account = await connectGmailAccount(userId, code);

    // Kick off the first scan immediately so the dashboard has data quickly.
    await enqueueAccountScan(
      { userId, gmailAccountId: account.id, type: "INITIAL", triggeredBy: "oauth-callback" },
      { required: false },
    );

    await recordAudit({
      userId,
      actor: "USER",
      action: AUDIT_ACTIONS.gmailConnected,
      entityType: "GmailAccount",
      entityId: account.id,
      summary: `Connected ${account.emailAddress}`,
      metadata: { scopes: account.scopes, missingScopes: account.missingScopes },
      ip: req.ip ?? null,
    });

    const note = account.missingScopes.length ? "&reason=missing_scopes" : "";
    return res.redirect(`${webBase}/settings?section=gmail&gmail=connected${note}`);
  } catch (error) {
    const code_ = error instanceof AppError ? error.code : ERROR_CODES.INTERNAL_ERROR;
    return res.redirect(`${webBase}/settings?section=gmail&gmail=failed&reason=${encodeURIComponent(code_)}`);
  }
}

export async function listAccounts(req: Request, res: Response) {
  const userId = currentUserId(req);
  const accounts = await prisma.gmailAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      emailAddress: true,
      status: true,
      grantedScopes: true,
      lastSyncAt: true,
      lastError: true,
      lastErrorAt: true,
      tokenExpiresAt: true,
      createdAt: true,
      _count: { select: { emails: true } },
    },
  });

  return ok(res, {
    accounts: accounts.map((account) => ({
      ...account,
      scopeAudit: auditGrantedScopes(account.grantedScopes),
      // Token values are never serialised; only their presence is exposed.
      hasCredentials: true,
    })),
    gmailConfigured: isGmailConfigured(),
    scopes: describeScopes(),
  });
}

export const disconnectSchema = z.object({ gmailAccountId: z.string().min(1) });

export async function disconnect(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { gmailAccountId } = req.body as z.infer<typeof disconnectSchema>;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User");

  const result = await disconnectGmailAccount(user, gmailAccountId);

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.gmailDisconnected,
    entityType: "GmailAccount",
    entityId: gmailAccountId,
    summary: result.revoked ? "Disconnected Gmail and revoked the Google grant" : "Disconnected Gmail",
    metadata: { revoked: result.revoked },
    ip: req.ip ?? null,
  });

  return ok(res, {
    disconnected: true,
    revoked: result.revoked,
    note: "Your emails remain in Gmail untouched. MailOps deleted the stored OAuth tokens and stopped scanning.",
  });
}

export const scanSchema = z.object({
  gmailAccountId: z.string().min(1).optional(),
  fullRescan: z.boolean().optional().default(false),
});

export async function triggerScan(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = (req.body ?? {}) as z.infer<typeof scanSchema>;

  const account = body.gmailAccountId
    ? await prisma.gmailAccount.findFirst({ where: { id: body.gmailAccountId, userId } })
    : await prisma.gmailAccount.findFirst({ where: { userId, status: { in: ["CONNECTED", "ERROR"] } }, orderBy: { createdAt: "desc" } });

  if (!account) {
    throw new AppError("Connect a Gmail account before scanning.", {
      statusCode: 409,
      code: ERROR_CODES.GMAIL_NOT_CONNECTED,
    });
  }

  const jobId = await enqueueAccountScan(
    { userId, gmailAccountId: account.id, type: "MANUAL", triggeredBy: "user", fullRescan: body.fullRescan },
    { required: true, jobId: `scan:${account.id}:MANUAL:${Date.now()}` },
  );

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.gmailScanStarted,
    entityType: "GmailAccount",
    entityId: account.id,
    summary: "Manual scan requested",
    metadata: { fullRescan: body.fullRescan, jobId },
  });

  return ok(res, { queued: true, jobId, gmailAccountId: account.id, fullRescan: body.fullRescan });
}

/** Synchronous scan for tests/local demos. Disabled in production. */
export async function runScanInline(req: Request, res: Response) {
  if (env.NODE_ENV === "production") {
    throw new AppError("Inline scans are disabled in production. Use the queued scan endpoint.", {
      statusCode: 403,
      code: ERROR_CODES.FORBIDDEN,
    });
  }

  const userId = currentUserId(req);
  const body = (req.body ?? {}) as z.infer<typeof scanSchema>;

  const account = body.gmailAccountId
    ? await prisma.gmailAccount.findFirst({ where: { id: body.gmailAccountId, userId } })
    : await prisma.gmailAccount.findFirst({ where: { userId, status: "CONNECTED" }, orderBy: { createdAt: "desc" } });

  if (!account) {
    throw new AppError("Connect a Gmail account before scanning.", {
      statusCode: 409,
      code: ERROR_CODES.GMAIL_NOT_CONNECTED,
    });
  }

  const outcome = await scanGmailAccount({
    userId,
    gmailAccountId: account.id,
    type: "MANUAL",
    triggeredBy: "inline",
    fullRescan: body.fullRescan,
  });

  return ok(res, outcome);
}

export async function scanStatus(req: Request, res: Response) {
  const userId = currentUserId(req);
  const [schedule, jobs] = await Promise.all([getScanSchedule(userId), getScanJobs(userId, 10)]);
  return ok(res, { schedule, jobs });
}
