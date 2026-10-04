/**
 * F2: the retention sweep must be blocked for the read-only demo account.
 *
 * `POST /api/settings/privacy/retention-sweep` purges email rows and trims bodies,
 * but unlike every other mutating route in the settings router it carried no
 * `blockDemoWrites` guard. The demo account's credentials are shared and publicly
 * documented, so any visitor could trigger an irreversible purge of the shared demo
 * dataset — permanently degrading the demo and violating the documented read-only
 * contract.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true because it needs PostgreSQL. Authentication
 * uses a bearer token minted through the real `issueTokens`, which also exercises the
 * documented CSRF exemption for non-cookie callers (`csrfMiddleware`).
 *
 *   RUN_INTEGRATION_TESTS=true npm test
 */
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { issueTokens } from "../../src/services/auth/auth.service";
import { getOrCreateSettings } from "../../src/services/settings/settings.service";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const app = createApp();
const SWEEP_PATH = "/api/settings/privacy/retention-sweep";

const createdUserIds: string[] = [];

/**
 * A user whose stored mail is already past its retention window, plus a bearer token
 * for it. `dataRetentionDays` is 1 so the 60-day-old rows below are purgeable.
 */
async function seedUser(options: { isDemo: boolean; emails?: number }) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const address = `sweep-${options.isDemo ? "demo" : "user"}-${suffix}@example.com`;

  const user = await prisma.user.create({
    data: { email: address, passwordHash: "not-a-real-hash", isDemo: options.isDemo },
  });
  createdUserIds.push(user.id);

  await getOrCreateSettings(user.id);
  await prisma.userSettings.update({ where: { userId: user.id }, data: { dataRetentionDays: 1 } });

  const account = await prisma.gmailAccount.create({
    data: { userId: user.id, emailAddress: address, grantedScopes: [] },
  });

  const count = options.emails ?? 3;
  for (let i = 0; i < count; i += 1) {
    await prisma.email.create({
      data: {
        userId: user.id,
        gmailAccountId: account.id,
        gmailMessageId: `msg_${suffix}_${i}`,
        subject: `Archived newsletter ${i}`,
        bodyText: "body content that retention should trim",
        receivedAt: new Date(Date.now() - 60 * 86_400_000),
        processingState: "PROCESSED",
      },
    });
  }

  const { accessToken } = await issueTokens(
    { id: user.id, email: user.email },
    { ip: null, userAgent: null },
  );

  return { user, authHeader: `Bearer ${accessToken}` };
}

/** Snapshot used to prove a blocked sweep changed absolutely nothing. */
async function snapshot(userId: string) {
  return {
    emails: await prisma.email.findMany({
      where: { userId },
      orderBy: { id: "asc" },
      select: { id: true, bodyText: true },
    }),
    auditRows: await prisma.auditLog.count({ where: { userId } }),
  };
}

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

describeIntegration("POST /privacy/retention-sweep — demo guard", () => {
  it("rejects the demo account with 403 FORBIDDEN", async () => {
    const demo = await seedUser({ isDemo: true });

    const response = await request(app).post(SWEEP_PATH).set("Authorization", demo.authHeader);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("deletes and modifies nothing for the demo account", async () => {
    const demo = await seedUser({ isDemo: true, emails: 3 });
    const before = await snapshot(demo.user.id);

    const response = await request(app).post(SWEEP_PATH).set("Authorization", demo.authHeader);
    expect(response.status).toBe(403);

    const after = await snapshot(demo.user.id);

    // No row was purged and no body was trimmed…
    expect(after.emails).toEqual(before.emails);
    expect(after.emails).toHaveLength(3);
    expect(after.emails.every((row) => row.bodyText !== null)).toBe(true);
    // …and nothing was audited, which proves the service never ran.
    expect(after.auditRows).toBe(before.auditRows);
    expect(after.auditRows).toBe(0);
  });

  it("still sweeps for a normal account", async () => {
    const user = await seedUser({ isDemo: false, emails: 3 });

    const response = await request(app).post(SWEEP_PATH).set("Authorization", user.authHeader);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.emailsPurged).toBe(3);
    // Bodies are trimmed before rows are purged, so both counters move.
    expect(response.body.data.bodiesTrimmed).toBe(3);

    expect(await prisma.email.count({ where: { userId: user.user.id } })).toBe(0);
  });

  it("still requires authentication", async () => {
    // CSRF is mounted app-wide ahead of the routers, so an unauthenticated POST that
    // carries no CSRF pair is refused by that guard before `requireAuth` is reached.
    const withoutCsrf = await request(app).post(SWEEP_PATH);
    expect(withoutCsrf.status).toBe(403);
    expect(withoutCsrf.body.error.code).toBe("FORBIDDEN");

    // Once CSRF is satisfied the request does reach `requireAuth`, and the missing
    // session is what stops it. Adding `blockDemoWrites` did not change either step.
    const withCsrf = await request(app)
      .post(SWEEP_PATH)
      .set("Cookie", "mailops_csrf=matched")
      .set("X-CSRF-Token", "matched");
    expect(withCsrf.status).toBe(401);
    expect(withCsrf.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describeIntegration("existing settings/privacy routes are unaffected", () => {
  it("still lets the demo account read settings, privacy and export", async () => {
    const demo = await seedUser({ isDemo: true });

    for (const path of ["/api/settings", "/api/settings/privacy", "/api/settings/privacy/export"]) {
      const response = await request(app).get(path).set("Authorization", demo.authHeader);
      expect(response.status, `${path} should remain readable for the demo account`).toBe(200);
    }
  });

  it("still blocks the demo account on the other guarded mutations", async () => {
    const demo = await seedUser({ isDemo: true });

    const emailData = await request(app)
      .delete("/api/settings/privacy/email-data")
      .set("Authorization", demo.authHeader)
      .send({ keepApplicationHistory: true });
    expect(emailData.status).toBe(403);
    expect(emailData.body.error.code).toBe("FORBIDDEN");

    const integration = await request(app)
      .put("/api/settings/integrations/slack")
      .set("Authorization", demo.authHeader)
      .send({ enabled: true });
    expect(integration.status).toBe(403);
  });

  it("lets a normal account reach the guarded privacy route", async () => {
    const user = await seedUser({ isDemo: false, emails: 1 });

    // The guard must discriminate on `isDemo`, not block everyone.
    const response = await request(app)
      .delete("/api/settings/privacy/email-data")
      .set("Authorization", user.authHeader)
      .send({ keepApplicationHistory: true });

    expect(response.status).toBe(200);
  });
});
