/**
 * Demo-account write guard across the settings router.
 *
 * `SECURITY.md` states the contract: demo accounts "are blocked from all non-`GET`
 * requests by `blockDemoWrites`", and the middleware gates on exactly that
 * (`req.method !== "GET"`). `PATCH /api/settings` was the one route that did not carry
 * it, so the shared, publicly-documented demo account could rename itself, disable
 * scanning and flip notification channels for every later visitor — contradicting both
 * the documented contract and the "Demo account — read only" badge in the UI.
 *
 * The last suite here is an invariant: it discovers the router's non-`GET` routes and
 * asserts each one refuses a demo account, so a future mutating route cannot quietly
 * ship without the guard.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true because it needs PostgreSQL.
 */
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { settingsRouter } from "../../src/routes/settings.routes";
import { issueTokens } from "../../src/services/auth/auth.service";
import { getOrCreateSettings } from "../../src/services/settings/settings.service";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const app = createApp();
const API_PREFIX = "/api/settings";

const createdUserIds: string[] = [];

async function seedUser(options: { isDemo: boolean }) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const address = `demo-guard-${options.isDemo ? "demo" : "user"}-${suffix}@example.com`;

  const user = await prisma.user.create({
    data: { email: address, passwordHash: "not-a-real-hash", isDemo: options.isDemo },
  });
  createdUserIds.push(user.id);

  await getOrCreateSettings(user.id);

  const { accessToken } = await issueTokens(
    { id: user.id, email: user.email },
    { ip: null, userAgent: null },
  );

  return { user, authHeader: `Bearer ${accessToken}` };
}

/**
 * Everything a PATCH can touch.
 *
 * `updateSettings` splits the patch: `name` and `timezone` are written to `User`
 * while the rest go to `UserSettings`. Snapshotting only one of the two tables would
 * miss half the damage a demo write could do.
 */
async function settingsSnapshot(userId: string) {
  const [user, settings] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, timezone: true },
    }),
    prisma.userSettings.findUniqueOrThrow({ where: { userId } }),
  ]);

  const stable: Record<string, unknown> = { ...settings };
  delete stable.updatedAt;

  return { user, settings: stable };
}

/** A payload that would visibly change things if the guard were missing. */
const WRITE_PAYLOAD = { name: "Renamed by demo", timezone: "Asia/Tokyo", scanningEnabled: false };

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

function sendAs(method: string, url: string, authHeader: string) {
  return request(app)
    [method as HttpMethod](url)
    .set("Authorization", authHeader)
    .send({});
}

/* -------------------------------------------------------------------------- */
/* PATCH /api/settings                                                        */
/* -------------------------------------------------------------------------- */

describeIntegration("PATCH /api/settings — demo guard", () => {
  it("rejects the demo account with 403 FORBIDDEN", async () => {
    const demo = await seedUser({ isDemo: true });

    const response = await request(app)
      .patch(API_PREFIX)
      .set("Authorization", demo.authHeader)
      .send(WRITE_PAYLOAD);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("leaves the demo account's settings untouched", async () => {
    const demo = await seedUser({ isDemo: true });
    const before = await settingsSnapshot(demo.user.id);

    const response = await request(app)
      .patch(API_PREFIX)
      .set("Authorization", demo.authHeader)
      .send(WRITE_PAYLOAD);
    expect(response.status).toBe(403);

    expect(await settingsSnapshot(demo.user.id)).toEqual(before);
  });

  it("still lets a normal account update its settings", async () => {
    const user = await seedUser({ isDemo: false });
    const before = await settingsSnapshot(user.user.id);

    const response = await request(app)
      .patch(API_PREFIX)
      .set("Authorization", user.authHeader)
      .send({ timezone: "Asia/Tokyo" });

    expect(response.status).toBe(200);

    const after = await settingsSnapshot(user.user.id);
    // `timezone` lives on `User`, not `UserSettings`.
    expect(after.user.timezone).toBe("Asia/Tokyo");
    // The guard must not have changed anything else about the update path.
    expect(after.user.name).toEqual(before.user.name);
    expect(after.settings).toEqual(before.settings);
  });
});

/* -------------------------------------------------------------------------- */
/* Existing read routes                                                       */
/* -------------------------------------------------------------------------- */

describeIntegration("settings reads are unaffected", () => {
  it("still lets the demo account read settings, privacy, audit and diagnostics", async () => {
    const demo = await seedUser({ isDemo: true });

    for (const path of [
      API_PREFIX,
      `${API_PREFIX}/privacy`,
      `${API_PREFIX}/privacy/export`,
      `${API_PREFIX}/audit`,
      `${API_PREFIX}/diagnostics`,
    ]) {
      const response = await request(app).get(path).set("Authorization", demo.authHeader);
      expect(response.status, `${path} must stay readable for the demo account`).toBe(200);
    }
  });

  it("still requires authentication for PATCH", async () => {
    const withoutCsrf = await request(app).patch(API_PREFIX).send(WRITE_PAYLOAD);
    expect(withoutCsrf.status).toBe(403); // app-wide CSRF guard runs first

    const withCsrf = await request(app)
      .patch(API_PREFIX)
      .set("Cookie", "mailops_csrf=matched")
      .set("X-CSRF-Token", "matched")
      .send(WRITE_PAYLOAD);
    expect(withCsrf.status).toBe(401);
    expect(withCsrf.body.error.code).toBe("UNAUTHENTICATED");
  });
});

/* -------------------------------------------------------------------------- */
/* Router-wide invariant                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Non-`GET` routes on this router that are intentionally reachable by the demo
 * account. Empty on purpose: per SECURITY.md there are no exemptions. Adding an entry
 * is a deliberate security decision, which is exactly what the test should force.
 */
const DEMO_WRITE_EXEMPTIONS: readonly string[] = [];

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * Every non-`GET` route the router actually serves.
 *
 * Reads Express's route table rather than parsing source text, so refactoring or
 * reformatting cannot silently shrink the list. The assertion below is behavioural —
 * it checks the HTTP outcome for a demo caller, not which middleware is mounted — so
 * it does not lock in handler order or identity.
 */
function discoverNonGetRoutes(): Array<{ method: string; path: string }> {
  const router = settingsRouter as unknown as { stack: RouterLayer[] };
  const routes: Array<{ method: string; path: string }> = [];

  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (method === "_all" || method === "get") continue;
      routes.push({ method, path: layer.route.path });
    }
  }

  return routes;
}

function urlFor(routePath: string): string {
  const suffix = routePath === "/" ? "" : routePath.replace(":kind", "slack");
  return `${API_PREFIX}${suffix}`;
}

describeIntegration("settings router invariant: every non-GET route blocks the demo account", () => {
  it("discovers the router's mutating routes", () => {
    const routes = discoverNonGetRoutes().map((r) => `${r.method.toUpperCase()} ${r.path}`);

    // Non-vacuity: if discovery ever breaks, these fail instead of the suite passing
    // by finding nothing.
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes).toContain("PATCH /");
    expect(routes).toContain("POST /privacy/retention-sweep");
    expect(routes).toContain("DELETE /privacy/email-data");
    expect(routes).toContain("PUT /integrations/:kind");
    expect(routes).toContain("DELETE /integrations/:kind");
  });

  it("refuses a demo account on every one of them", async () => {
    const demo = await seedUser({ isDemo: true });

    const routes = discoverNonGetRoutes();
    const unguarded: string[] = [];

    for (const { method, path } of routes) {
      const label = `${method.toUpperCase()} ${path}`;
      if (DEMO_WRITE_EXEMPTIONS.includes(label)) continue;

      const response = await sendAs(method, urlFor(path), demo.authHeader);
      if (response.status !== 403 || response.body?.error?.code !== "FORBIDDEN") {
        unguarded.push(`${label} -> ${response.status}`);
      }
    }

    expect(
      unguarded,
      "these non-GET settings routes do not block the demo account (add blockDemoWrites)",
    ).toEqual([]);
  });
});

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});
