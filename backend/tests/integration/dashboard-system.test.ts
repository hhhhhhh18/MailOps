/**
 * `GET /api/dashboard/system` sanitization (P2 follow-up to F3).
 *
 * The endpoint is reachable by *any* authenticated account — including the read-only demo
 * account — and it used to return the raw `getQueueHealth()` array. On a queue failure that
 * array inlined the BullMQ/ioredis `error.message`, which embeds host, port and auth
 * semantics, so infrastructure detail left the server inside a **successful 200 response**.
 * That bypassed the connection-error sanitization in `middleware/error.ts`, which only ever
 * sees *thrown* errors, never a string placed into a value field.
 *
 * Two layers are pinned independently, because either one alone is a single point of
 * failure and the regression we most care about is a future field being added upstream:
 *
 *   1. the source — `getQueueHealth()` must never return infrastructure error text;
 *   2. the controller — `systemStatus()` must project an explicit allow-list, so an
 *      unknown field added to `QueueHealth` cannot reach a client by default.
 *
 * Queue names and counters are *deliberately preserved*: they are the documented operator
 * monitoring signal (DEPLOYMENT.md §10). So these tests assert both directions — nothing
 * forbidden may appear, and the legitimate counters must survive unmodified. A test that
 * only proved "no leak" would pass trivially if the endpoint returned nothing at all.
 *
 * `bullmq` is stubbed at its lowest layer rather than mocking `src/queues`, so the *real*
 * `getQueueHealth()` and the *real* `systemStatus()` both run. That is what makes the
 * non-vacuity check meaningful: reintroducing `error: error.message` in the source is
 * caught by the source-level test, and removing the controller allow-list is caught by the
 * endpoint tests. Only `Queue` is replaced — `Worker` and every other export stay real, so
 * nothing else in the import graph is perturbed.
 *
 * Gated behind RUN_INTEGRATION_TESTS=true because authentication needs PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/* -------------------------------------------------------------------------- */
/* bullmq stub — per-queue healthy / failing behaviour                        */
/* -------------------------------------------------------------------------- */

const QUEUE_NAMES = [
  "email-scan",
  "email-processing",
  "application-processing",
  "notification",
  "cleanup",
  "escalation",
] as const;

/** Realistic failure text, each token of which must never reach a client. */
const LEAKY_REDIS_SOCKET = "connect ECONNREFUSED 10.4.2.9:6379 (NOAUTH Authentication required)";
const LEAKY_QUEUE_AUTH = "WRONGPASS invalid username-password pair at redis-primary.internal:6379";
const LEAKY_QUEUE_DNS = "getaddrinfo ENOTFOUND redis-primary.internal.acme";

/**
 * Every substring above that would betray infrastructure detail if it appeared.
 * Deliberately spans all three fixtures, not just the first.
 */
const FORBIDDEN_SUBSTRINGS = [
  "ECONNREFUSED",
  "10.4.2.9",
  "6379",
  "NOAUTH",
  "WRONGPASS",
  "ENOTFOUND",
  "redis-primary.internal",
  "redis-primary.internal.acme",
  "internal.acme",
  "postgres-primary.internal.acme",
  "5432",
  "mailops_app",
  "mailops_prod",
];

/** Which queues fail, and what they throw. Reset before every test. */
let failingQueues: Record<string, string> = {};

/** Counts a healthy queue reports. `email-processing` matches the DEPLOYMENT.md signal. */
const HEALTHY_COUNTS: Record<string, Record<string, number>> = {
  "email-processing": { waiting: 412, active: 7, delayed: 3, failed: 19, completed: 8842 },
};

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();

  class FakeQueue {
    readonly name: string;

    constructor(name: string, _options: unknown) {
      this.name = name;
    }

    // The real constructor registers an error listener; the stub only needs to not throw.
    on(): this {
      return this;
    }

    // `closeQueues()` calls this while clearing the registry.
    async close(): Promise<void> {
      return undefined;
    }

    async getJobCounts(...states: string[]): Promise<Record<string, number>> {
      const failure = failingQueues[this.name];
      if (failure) {
        // Shaped like a real ioredis failure, including a `code`, so this exercises the
        // same catch path a live Redis outage would.
        throw Object.assign(new Error(failure), { code: "ECONNREFUSED" });
      }

      const base = HEALTHY_COUNTS[this.name] ?? {};
      const counts: Record<string, number> = {};
      for (const state of states) counts[state] = base[state] ?? 0;
      return counts;
    }
  }

  return { ...actual, Queue: FakeQueue };
});

import { createApp } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import { closeQueues, getQueueHealth, queues } from "../../src/queues";
import { issueTokens } from "../../src/services/auth/auth.service";

const app = createApp();
const SYSTEM_PATH = "/api/dashboard/system";

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const createdUserIds: string[] = [];

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

async function seedUser(options: { demo?: boolean } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `dashboard-system-${suffix}@example.com`,
      passwordHash: "not-a-real-hash",
      ...(options.demo ? { isDemo: true } : {}),
    },
  });
  createdUserIds.push(user.id);

  const { accessToken } = await issueTokens(
    { id: user.id, email: user.email },
    { ip: null, userAgent: null },
  );

  return { user, authHeader: `Bearer ${accessToken}` };
}

function getSystem(authHeader: string) {
  return request(app).get(SYSTEM_PATH).set("Authorization", authHeader);
}

/** Every queue failing, with a leaky message attached to each. */
function failEveryQueue(message: string = LEAKY_REDIS_SOCKET): Record<string, string> {
  return Object.fromEntries(QUEUE_NAMES.map((name) => [name, message]));
}

/**
 * Populates the module-level queue registry. `getQueueHealth()` iterates whatever has been
 * registered, so without this it would return an empty array and every assertion below
 * would be vacuous.
 */
function registerAllQueues(): void {
  void queues.emailScan;
  void queues.emailProcessing;
  void queues.applicationProcessing;
  void queues.notification;
  void queues.cleanup;
  void queues.escalation;
}

beforeEach(() => {
  failingQueues = {};
  registerAllQueues();
});

/* -------------------------------------------------------------------------- */
/* Access control                                                             */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /api/dashboard/system — access control", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await request(app).get(SYSTEM_PATH);

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it("serves an ordinary authenticated user", async () => {
    const user = await seedUser();
    const response = await getSystem(user.authHeader);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it("serves the demo account the same sanitized shape (GET stays permitted)", async () => {
    const demo = await seedUser({ demo: true });
    failingQueues = { cleanup: LEAKY_QUEUE_AUTH };

    const response = await getSystem(demo.authHeader);

    // The demo account is read-only, but reading is exactly what it may do.
    expect(response.status).toBe(200);
    expect(Object.keys(response.body.data).sort()).toEqual(["degraded", "queueAvailable", "queues"]);

    const raw = JSON.stringify(response.body);
    for (const secret of FORBIDDEN_SUBSTRINGS) {
      expect(raw, `demo response leaked "${secret}"`).not.toContain(secret);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Allow-listed shape                                                         */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /api/dashboard/system — allow-listed payload", () => {
  it("returns exactly the allow-listed keys, at every level", async () => {
    failingQueues = { cleanup: LEAKY_QUEUE_AUTH, notification: LEAKY_QUEUE_DNS };

    const user = await seedUser();
    const { body } = await getSystem(user.authHeader);

    // An allow-list rather than a spot check: an extra field must fail the build.
    expect(Object.keys(body.data).sort()).toEqual(["degraded", "queueAvailable", "queues"]);
    expect(body.data.queues.length).toBe(QUEUE_NAMES.length);

    for (const row of body.data.queues) {
      expect(Object.keys(row).sort()).toEqual([
        "active",
        "available",
        "completed",
        "delayed",
        "failed",
        "name",
        "waiting",
      ]);
    }
  });

  it("exposes no forbidden or unexpected key anywhere in the response", async () => {
    const user = await seedUser();
    failingQueues = { cleanup: LEAKY_QUEUE_AUTH };

    const { body } = await getSystem(user.authHeader);
    const keys = collectKeys(body);

    for (const forbidden of [
      "error",
      "message",
      "stack",
      "stackTrace",
      "code",
      "errno",
      "syscall",
      "address",
      "port",
      "host",
      "hostname",
      "redis",
      "password",
      "url",
      "userId",
      "jobId",
      "jobs",
    ]) {
      expect(keys, `response must not expose a "${forbidden}" field`).not.toContain(forbidden);
    }
  });

  it("keeps every per-queue value a plain primitive (no room for an embedded diagnostic)", async () => {
    const user = await seedUser();
    failingQueues = { cleanup: LEAKY_REDIS_SOCKET };

    const { body } = await getSystem(user.authHeader);

    for (const row of body.data.queues) {
      for (const [key, value] of Object.entries(row)) {
        if (key === "name") {
          expect(typeof value).toBe("string");
        } else if (key === "available") {
          expect(typeof value).toBe("boolean");
        } else {
          // A string here is the shape a leaked error message takes.
          expect(typeof value, `${key} must be numeric`).toBe("number");
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /api/dashboard/system — redaction", () => {
  it("never surfaces raw queue errors, even when every queue is down", async () => {
    const user = await seedUser();
    failingQueues = {
      "email-scan": LEAKY_REDIS_SOCKET,
      "email-processing": LEAKY_QUEUE_AUTH,
      "application-processing": LEAKY_QUEUE_DNS,
      notification: LEAKY_REDIS_SOCKET,
      cleanup: LEAKY_QUEUE_AUTH,
      escalation: LEAKY_QUEUE_DNS,
    };

    const response = await getSystem(user.authHeader);
    expect(response.status).toBe(200);

    const raw = JSON.stringify(response.body);
    for (const secret of FORBIDDEN_SUBSTRINGS) {
      expect(raw, `response leaked "${secret}"`).not.toContain(secret);
    }
  });

  it("the leaky fixtures genuinely contain the tokens they are trusted to carry", () => {
    // Non-vacuity guard for the redaction tests: if these fixtures were benign,
    // "no leak" would pass for the wrong reason and prove nothing.
    const fixtures = JSON.stringify([LEAKY_REDIS_SOCKET, LEAKY_QUEUE_AUTH, LEAKY_QUEUE_DNS]);

    expect(fixtures).toContain("ECONNREFUSED");
    expect(fixtures).toContain("6379");
    expect(fixtures).toContain("NOAUTH");
    expect(fixtures).toContain("WRONGPASS");
    expect(fixtures).toContain("redis-primary.internal");
    expect(fixtures).toContain("redis-primary.internal.acme");
  });
});

/* -------------------------------------------------------------------------- */
/* Source-level contract                                                      */
/* -------------------------------------------------------------------------- */

describeIntegration("getQueueHealth — source-level sanitization", () => {
  it("never returns error text when a queue probe fails", async () => {
    failingQueues = { cleanup: LEAKY_QUEUE_AUTH, notification: LEAKY_REDIS_SOCKET };

    const health = await getQueueHealth();

    // Non-vacuity: the failures must actually have happened, otherwise iterating the
    // failed rows below would assert nothing.
    const failed = health.filter((row) => !row.available);
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(health.length).toBe(QUEUE_NAMES.length);

    for (const row of failed) {
      expect(Object.keys(row).sort()).toEqual([
        "active",
        "available",
        "completed",
        "delayed",
        "failed",
        "name",
        "waiting",
      ]);
      expect(row).not.toHaveProperty("error");

      // The availability flag is the whole message; counters fall back to zero.
      expect(row.waiting).toBe(0);
      expect(row.active).toBe(0);
      expect(row.delayed).toBe(0);
      expect(row.failed).toBe(0);
      expect(row.completed).toBe(0);
    }

    // The detail is not discarded from the system, only from the returned value.
    expect(JSON.stringify(health)).not.toContain("WRONGPASS");
    expect(JSON.stringify(health)).not.toContain("ECONNREFUSED");
  });
});

/* -------------------------------------------------------------------------- */
/* Preserved operator signal                                                  */
/* -------------------------------------------------------------------------- */

describeIntegration("GET /api/dashboard/system — operator signal preserved", () => {
  it("passes the documented queue names and counters through unchanged", async () => {
    const user = await seedUser();

    const { body } = await getSystem(user.authHeader);
    const byName = Object.fromEntries(
      body.data.queues.map((row: { name: string }) => [row.name, row]),
    );

    // Every internal queue is still reported, by its real name.
    expect(Object.keys(byName).sort()).toEqual([...QUEUE_NAMES].sort());

    // The DEPLOYMENT.md §10 signal — `email-processing` depth — is intact.
    expect(byName["email-processing"]).toEqual({
      name: "email-processing",
      waiting: 412,
      active: 7,
      delayed: 3,
      failed: 19,
      completed: 8842,
      available: true,
    });

    // A queue with no configured counts reports zeros, not undefined (JSON drops it).
    expect(byName["email-scan"]).toEqual({
      name: "email-scan",
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
      available: true,
    });

    expect(body.data.queueAvailable).toBe(true);
    expect(body.data.degraded).toBe(false);
  });

  it("reports a sanitized availability state when every queue fails", async () => {
    const user = await seedUser();
    failingQueues = failEveryQueue();

    const { body } = await getSystem(user.authHeader);

    // `degraded` still derived exactly as before, from availability alone.
    expect(body.data.queueAvailable).toBe(false);
    expect(body.data.degraded).toBe(true);
    expect(
      body.data.queues.every((row: { available: boolean }) => row.available === false),
    ).toBe(true);

    // Zeroed counters, and no trace of why.
    expect(JSON.stringify(body)).not.toContain("6379");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(collectKeys(body)).not.toContain("error");
  });

  it("reports a partial outage as not degraded, with queueAvailable still true", async () => {
    const user = await seedUser();
    failingQueues = { cleanup: LEAKY_QUEUE_AUTH };

    const { body } = await getSystem(user.authHeader);

    // Unchanged semantics: one healthy queue is enough for `queueAvailable`.
    expect(body.data.queueAvailable).toBe(true);
    expect(body.data.degraded).toBe(false);
  });

  it("does not read an empty queue registry as a system-wide outage", async () => {
    // Pins the `queueHealth.length > 0` clause in the `degraded` formula: with nothing
    // registered, `every()` is vacuously true, so without that clause an empty registry
    // would be reported as fully degraded. The registry is a module singleton, so it is
    // emptied through the module's own `closeQueues()`.
    await closeQueues();

    const user = await seedUser();
    const response = await getSystem(user.authHeader);

    expect(response.status).toBe(200);
    expect(response.body.data.queues).toEqual([]);
    expect(response.body.data.queueAvailable).toBe(false);
    expect(response.body.data.degraded).toBe(false);
    expect(collectKeys(response.body)).not.toContain("error");
  });
});

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});
