/**
 * Diagnostics sanitization (F3).
 *
 * `GET /api/settings/diagnostics` is reachable by *any* authenticated account, yet it
 * used to return whatever the underlying probes handed back: raw PostgreSQL and Redis
 * driver errors (which embed host, port, username and database name), the full
 * `getQueueHealth()` array — internal queue names, job counters and per-queue error
 * strings — and the encryption key's length and fingerprint.
 *
 * These tests pin the sanitized contract from both directions:
 *   - the allow-listed shape (so a future field cannot be added silently), and
 *   - the redaction (a failing dependency must not leak its error anywhere), and
 *   - `status` semantics matching `GET /health`, which must stay unchanged.
 *
 * The three health probes are mocked with pass-through mocks so both the healthy and
 * the failing paths are deterministic and never depend on a live Redis. `prisma`
 * itself is left real, because the tests still need a database to authenticate.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true because it needs PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma, checkDatabase } from "../../src/config/prisma";
import { checkRedis } from "../../src/config/redis";
import { getQueueHealth } from "../../src/queues";
import { issueTokens } from "../../src/services/auth/auth.service";

vi.mock("../../src/config/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/prisma")>();
  return { ...actual, checkDatabase: vi.fn() };
});

vi.mock("../../src/config/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/redis")>();
  return { ...actual, checkRedis: vi.fn() };
});

vi.mock("../../src/queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/queues")>();
  return { ...actual, getQueueHealth: vi.fn() };
});

const checkDatabaseMock = vi.mocked(checkDatabase);
const checkRedisMock = vi.mocked(checkRedis);
const getQueueHealthMock = vi.mocked(getQueueHealth);

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const app = createApp();
const DIAGNOSTICS_PATH = "/api/settings/diagnostics";

const createdUserIds: string[] = [];

/** Realistic failure text, each token of which must never reach a client. */
const LEAKY_DB_ERROR =
  'Can\'t reach database server at "postgres-primary.internal.acme:5432" for user "mailops_app" on database "mailops_prod"';
const LEAKY_REDIS_ERROR = "connect ECONNREFUSED 10.4.2.9:6379 (NOAUTH Authentication required)";
const LEAKY_QUEUE_ERROR = "WRONGPASS invalid username-password pair at redis-primary.internal:6379";

/** Every substring above that would betray infrastructure detail if it appeared. */
const FORBIDDEN_SUBSTRINGS = [
  "postgres-primary.internal.acme",
  "5432",
  "mailops_app",
  "mailops_prod",
  "ECONNREFUSED",
  "10.4.2.9",
  "6379",
  "NOAUTH",
  "WRONGPASS",
  "redis-primary.internal",
  "internal.acme",
];

/** A healthy queue row, and a deliberately hostile one. */
const healthyQueues = [
  { name: "cleanup", waiting: 0, active: 0, delayed: 0, failed: 0, completed: 3, available: true },
];

const unhealthyQueues = [
  {
    // The name alone identifies internal topology; the numbers expose email volume.
    name: "mailops:email:process",
    waiting: 412,
    active: 7,
    delayed: 3,
    failed: 19,
    completed: 8842,
    available: false,
    error: LEAKY_QUEUE_ERROR,
  },
];

async function seedUser() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: { email: `diagnostics-${suffix}@example.com`, passwordHash: "not-a-real-hash" },
  });
  createdUserIds.push(user.id);

  const { accessToken } = await issueTokens(
    { id: user.id, email: user.email },
    { ip: null, userAgent: null },
  );

  return { user, authHeader: `Bearer ${accessToken}` };
}

function getDiagnostics(authHeader: string) {
  return request(app).get(DIAGNOSTICS_PATH).set("Authorization", authHeader);
}

/** Every key name appearing anywhere in a JSON value, at any depth. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key);
      collectKeys(nested, out);
    }
  }
  return out;
}

beforeEach(() => {
  // Healthy by default; individual tests override.
  checkDatabaseMock.mockResolvedValue({ ok: true });
  checkRedisMock.mockResolvedValue({ ok: true });
  getQueueHealthMock.mockResolvedValue(healthyQueues);
});

/* -------------------------------------------------------------------------- */
/* Access control                                                             */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /api/settings/diagnostics — access control", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await request(app).get(DIAGNOSTICS_PATH);

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it("serves an ordinary authenticated user", async () => {
    const user = await seedUser();
    const response = await getDiagnostics(user.authHeader);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Sanitized shape                                                            */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /api/settings/diagnostics — sanitized payload", () => {
  it("returns exactly the allow-listed keys, at every level", async () => {
    const user = await seedUser();
    const { body } = await getDiagnostics(user.authHeader);
    const data = body.data;

    // An allow-list rather than a spot check: an extra field must fail the build.
    expect(Object.keys(data).sort()).toEqual(["dependencies", "encryption", "environment", "status"]);
    expect(Object.keys(data.dependencies).sort()).toEqual([
      "aiConfigured",
      "aiProvider",
      "database",
      "queues",
      "redis",
    ]);
    expect(Object.keys(data.dependencies.database)).toEqual(["ok"]);
    expect(Object.keys(data.dependencies.redis)).toEqual(["ok"]);
    expect(Object.keys(data.dependencies.queues)).toEqual(["available"]);
    expect(Object.keys(data.encryption)).toEqual(["configured"]);

    // No `error`, `length`, `fingerprint`, `name`, `waiting`, `failed`… anywhere.
    const keys = collectKeys(body);
    for (const forbidden of ["error", "fingerprint", "length", "stack", "name", "waiting", "failed"]) {
      expect(keys, `response must not expose a "${forbidden}" field`).not.toContain(forbidden);
    }
  });

  it("reports reachability as booleans and the encryption key as presence only", async () => {
    const user = await seedUser();
    const { body } = await getDiagnostics(user.authHeader);

    expect(body.data.dependencies.database.ok).toBe(true);
    expect(body.data.dependencies.redis.ok).toBe(true);
    expect(body.data.dependencies.queues.available).toBe(true);

    // setup.ts provisions a key, so presence must be detected — without revealing
    // anything derived from the key itself.
    expect(body.data.encryption.configured).toBe(true);
  });

  it("never surfaces raw datastore errors, even when both dependencies are down", async () => {
    const user = await seedUser();

    checkDatabaseMock.mockResolvedValue({ ok: false, error: LEAKY_DB_ERROR });
    checkRedisMock.mockResolvedValue({ ok: false, error: LEAKY_REDIS_ERROR });
    getQueueHealthMock.mockResolvedValue(unhealthyQueues);

    const response = await getDiagnostics(user.authHeader);
    expect(response.status).toBe(200);

    const raw = JSON.stringify(response.body);
    for (const secret of FORBIDDEN_SUBSTRINGS) {
      expect(raw, `response leaked "${secret}"`).not.toContain(secret);
    }

    // Still a valid status payload, just without the diagnosis.
    expect(response.body.data.status).toBe("unavailable");
    expect(response.body.data.dependencies.database).toEqual({ ok: false });
    expect(response.body.data.dependencies.redis).toEqual({ ok: false });

    // Re-assert the exact shape here as well, not only on the healthy path.
    // `JSON.stringify` drops `undefined`, so a failing dependency is the *only* case
    // where an added `error` field would actually appear — asserting the shape on a
    // healthy payload alone would miss it.
    expect(Object.keys(response.body.data.dependencies.database)).toEqual(["ok"]);
    expect(Object.keys(response.body.data.dependencies.redis)).toEqual(["ok"]);
    expect(collectKeys(response.body)).not.toContain("error");
  });

  it("never surfaces queue names, depths or per-queue errors", async () => {
    const user = await seedUser();
    getQueueHealthMock.mockResolvedValue(unhealthyQueues);

    const { body } = await getDiagnostics(user.authHeader);

    // Collapsed to a single aggregate flag.
    expect(body.data.dependencies.queues).toEqual({ available: false });

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("mailops:email:process");
    expect(raw).not.toContain("8842"); // completed count
    expect(raw).not.toContain("412"); // waiting depth
  });
});

/* -------------------------------------------------------------------------- */
/* Status semantics                                                           */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /api/settings/diagnostics — status semantics", () => {
  const cases = [
    { database: true, redis: true, expected: "ok" },
    { database: true, redis: false, expected: "degraded" },
    { database: false, redis: true, expected: "unavailable" },
    { database: false, redis: false, expected: "unavailable" },
  ] as const;

  for (const scenario of cases) {
    it(`reports "${scenario.expected}" when database=${scenario.database} redis=${scenario.redis}`, async () => {
      const user = await seedUser();
      checkDatabaseMock.mockResolvedValue({ ok: scenario.database });
      checkRedisMock.mockResolvedValue({ ok: scenario.redis });

      const { body } = await getDiagnostics(user.authHeader);
      expect(body.data.status).toBe(scenario.expected);

      // The same derivation must hold on /health, which this change must not alter.
      const health = await request(app).get("/health");
      expect(health.body.status).toBe(scenario.expected);
      expect(health.status).toBe(scenario.database ? 200 : 503);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Unrelated health endpoint                                                  */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /health is unaffected by the diagnostics change", () => {
  it("still exposes per-dependency status and degraded capabilities", async () => {
    checkRedisMock.mockResolvedValue({ ok: false });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.dependencies).toMatchObject({ database: "ok", redis: "unavailable" });
    expect(response.body.degradedCapabilities).toContain("background scanning");
    // /health never carried raw errors and still must not.
    const keys = collectKeys(response.body);
    expect(keys).not.toContain("error");
  });
});

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});
