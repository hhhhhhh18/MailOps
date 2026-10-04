import { google, type Auth } from "googleapis";
import type { GmailAccount, User } from "@prisma/client";
import { env, googleOAuthConfigured } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../config/prisma";
import { decryptSecret, encryptSecret, safeEqual } from "../../utils/crypto";
import { AppError, ERROR_CODES, IntegrationError } from "../../utils/errors";
import { GMAIL_SCOPES, auditGrantedScopes } from "./scopes";
import { issueState } from "./oauth-state.store";

/**
 * Google OAuth 2.0 for Gmail.
 *
 * Security properties:
 *  - offline access + consent prompt so a refresh token is issued exactly once
 *  - refresh tokens are envelope-encrypted at rest (AES-256-GCM)
 *  - CSRF-protected state parameter, single-use, bound to the user
 *  - revocation on disconnect (so the grant actually disappears from the user's
 *    Google account, not just from our database)
 *  - tokens are never logged, never returned to the client
 *
 * The `state` parameter now lives in Redis rather than process memory, so a callback
 * can land on any API instance and survives a restart mid-flow. `oauth-state.store.ts`
 * owns issuance, the 10-minute TTL, atomic single-use consumption and the fail-closed
 * behaviour when Redis is unreachable. The state helpers are re-exported here because
 * every existing caller — the controller and the test suite — imports them from this
 * module.
 */

export { consumeState, peekState, STATE_TTL_SECONDS } from "./oauth-state.store";

export function isGmailConfigured(): boolean {
  return googleOAuthConfigured;
}

function createOAuthClient(): Auth.OAuth2Client {
  if (!isGmailConfigured()) {
    throw new AppError(
      "Gmail integration is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing)",
      { statusCode: 503, code: ERROR_CODES.INTEGRATION_NOT_CONFIGURED, degraded: true },
    );
  }
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_OAUTH_REDIRECT_URI);
}

export async function buildConsentUrl(userId: string): Promise<string> {
  // Configuration is checked before the state is written, so a misconfigured server
  // fails without leaving a usable state behind.
  const client = createOAuthClient();
  const nonce = await issueState(userId);

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
    state: nonce,
    include_granted_scopes: true,
  });
}

export interface ConnectedGmailAccount {
  id: string;
  emailAddress: string;
  scopes: string[];
  status: string;
  missingScopes: string[];
}

/**
 * Exchanges the authorization code, verifies the grant, and persists the
 * encrypted credentials.
 */
export async function connectGmailAccount(userId: string, code: string): Promise<ConnectedGmailAccount> {
  const client = createOAuthClient();

  let tokens: Auth.Credentials;
  try {
    const result = await client.getToken(code);
    tokens = result.tokens;
  } catch (error) {
    logger.warn({ userId }, "gmail oauth code exchange failed");
    throw new IntegrationError(
      "Google rejected the authorization code. Please try connecting again.",
      ERROR_CODES.GMAIL_INVALID_TOKEN,
      { retryable: true, cause: error },
    );
  }

  if (!tokens.refresh_token) {
    // Without a refresh token MailOps cannot scan in the background. This happens
    // when the user has already granted access and Google skips the consent step.
    throw new AppError(
      "Google did not return a refresh token. Remove MailOps from your Google account permissions and connect again.",
      { statusCode: 400, code: ERROR_CODES.GMAIL_INVALID_TOKEN },
    );
  }

  client.setCredentials(tokens);
  const grantedScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  const scopeAudit = auditGrantedScopes(grantedScopes);

  const profile = await fetchGmailProfile(client);
  const emailAddress = profile.emailAddress;

  if (!emailAddress) {
    throw new IntegrationError("Unable to determine the connected Gmail address", ERROR_CODES.GMAIL_API_UNAVAILABLE, {
      retryable: true,
    });
  }

  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  const account = await prisma.gmailAccount.upsert({
    where: { userId_emailAddress: { userId, emailAddress } },
    create: {
      userId,
      emailAddress,
      status: scopeAudit.ok ? "CONNECTED" : "ERROR",
      accessTokenEnc: tokens.access_token ? encryptSecret(tokens.access_token) : null,
      refreshTokenEnc: encryptSecret(tokens.refresh_token),
      tokenExpiresAt: expiresAt,
      grantedScopes,
      lastError: scopeAudit.ok ? null : `Missing required scopes: ${scopeAudit.missing.join(", ")}`,
      lastErrorAt: scopeAudit.ok ? null : new Date(),
    },
    update: {
      status: scopeAudit.ok ? "CONNECTED" : "ERROR",
      accessTokenEnc: tokens.access_token ? encryptSecret(tokens.access_token) : null,
      refreshTokenEnc: encryptSecret(tokens.refresh_token),
      tokenExpiresAt: expiresAt,
      grantedScopes,
      lastError: scopeAudit.ok ? null : `Missing required scopes: ${scopeAudit.missing.join(", ")}`,
      lastErrorAt: scopeAudit.ok ? null : new Date(),
    },
  });

  // Record the integration so Settings can render connection state uniformly.
  await prisma.integration.upsert({
    where: { userId_kind: { userId, kind: "EMAIL" } },
    create: {
      userId,
      kind: "EMAIL",
      status: "CONNECTED",
      displayName: emailAddress,
      config: { provider: "gmail", scopes: grantedScopes },
      lastVerifiedAt: new Date(),
    },
    update: {
      status: "CONNECTED",
      displayName: emailAddress,
      config: { provider: "gmail", scopes: grantedScopes },
      lastVerifiedAt: new Date(),
      lastError: null,
    },
  });

  logger.info({ userId, accountId: account.id, scopes: grantedScopes.length }, "gmail account connected");

  return {
    id: account.id,
    emailAddress,
    scopes: grantedScopes,
    status: account.status,
    missingScopes: scopeAudit.missing,
  };
}

async function fetchGmailProfile(client: Auth.OAuth2Client): Promise<{ emailAddress: string | null }> {
  try {
    const gmail = google.gmail({ version: "v1", auth: client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    return { emailAddress: profile.data.emailAddress ?? null };
  } catch (error) {
    // Fall back to the OIDC userinfo endpoint when the Gmail profile call fails.
    try {
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const info = await oauth2.userinfo.get();
      return { emailAddress: info.data.email ?? null };
    } catch {
      logger.warn({ err: (error as Error).message }, "failed to read gmail profile");
      return { emailAddress: null };
    }
  }
}

/**
 * Returns a usable OAuth2 client for an account, refreshing the access token
 * when it is close to expiry. Persists the refreshed token, encrypted.
 */
export async function getAuthorizedClient(account: GmailAccount): Promise<Auth.OAuth2Client> {
  const client = createOAuthClient();
  const refreshToken = decryptSecret(account.refreshTokenEnc);
  const accessToken = decryptSecret(account.accessTokenEnc);

  if (!refreshToken) {
    await markAccountStatus(account.id, "ERROR", "Stored credentials are unusable. Please reconnect Gmail.");
    throw new AppError("Gmail credentials are unusable. Please reconnect your account.", {
      statusCode: 409,
      code: ERROR_CODES.GMAIL_CONNECTION_EXPIRED,
    });
  }

  client.setCredentials({
    refresh_token: refreshToken,
    access_token: accessToken ?? undefined,
    expiry_date: account.tokenExpiresAt ? account.tokenExpiresAt.getTime() : undefined,
  });

  const expiresSoon = !account.tokenExpiresAt || account.tokenExpiresAt.getTime() - Date.now() < 60_000;

  if (expiresSoon) {
    try {
      const { credentials } = await client.refreshAccessToken();
      if (credentials.access_token) {
        await prisma.gmailAccount.update({
          where: { id: account.id },
          data: {
            accessTokenEnc: encryptSecret(credentials.access_token),
            tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
            status: "CONNECTED",
            lastError: null,
          },
        });
        client.setCredentials(credentials);
      }
    } catch (error) {
      const message = (error as Error).message ?? "unknown error";
      const expired = /invalid_grant|expired|revoked/i.test(message);
      await markAccountStatus(
        account.id,
        expired ? "EXPIRED" : "ERROR",
        expired ? "Gmail access was revoked or expired. Please reconnect your account." : message,
      );
      throw new IntegrationError(
        expired
          ? "Gmail access has expired. Please reconnect your Gmail account."
          : "Gmail API is temporarily unavailable. MailOps will retry automatically.",
        expired ? ERROR_CODES.GMAIL_CONNECTION_EXPIRED : ERROR_CODES.GMAIL_API_UNAVAILABLE,
        { retryable: !expired, details: { expired } },
      );
    }
  }

  return client;
}

async function markAccountStatus(
  accountId: string,
  status: "CONNECTED" | "EXPIRED" | "DISCONNECTED" | "ERROR",
  error: string | null,
): Promise<void> {
  await prisma.gmailAccount
    .update({
      where: { id: accountId },
      data: { status, lastError: error, lastErrorAt: error ? new Date() : null },
    })
    .catch(() => undefined);
}

/** Revokes the Google grant and clears stored credentials. */
export async function disconnectGmailAccount(user: User, gmailAccountId: string): Promise<{ revoked: boolean }> {
  const account = await prisma.gmailAccount.findFirst({ where: { id: gmailAccountId, userId: user.id } });
  if (!account) {
    throw new AppError("Gmail account not found", { statusCode: 404, code: ERROR_CODES.NOT_FOUND });
  }

  let revoked = false;
  const token = decryptSecret(account.refreshTokenEnc) ?? decryptSecret(account.accessTokenEnc);
  if (token && isGmailConfigured()) {
    try {
      const client = createOAuthClient();
      await client.revokeToken(token);
      revoked = true;
    } catch (error) {
      // Non-fatal: the user may revoke manually from their Google account page.
      logger.warn({ accountId: account.id, err: (error as Error).message }, "gmail token revocation failed");
    }
  }

  await prisma.gmailAccount.update({
    where: { id: account.id },
    data: {
      status: "DISCONNECTED",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      historyId: null,
      lastError: null,
    },
  });

  await prisma.integration.updateMany({
    where: { userId: user.id, kind: "EMAIL" },
    data: { status: "DISCONNECTED", secretsEnc: null, lastError: null },
  });

  logger.info({ userId: user.id, accountId: account.id, revoked }, "gmail account disconnected");
  return { revoked };
}

export function assertStateMatches(state: string, expected: string): boolean {
  return safeEqual(state, expected);
}
