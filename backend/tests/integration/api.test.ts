import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";

/**
 * API contract tests.
 *
 * These run with no database and no Redis: everything asserted here is the HTTP
 * layer's own behaviour (envelope shape, validation, auth, CSRF, error codes).
 * That makes them fast enough to run on every commit and independent of the
 * developer's local infrastructure.
 */

const app = createApp();

describe("health", () => {
  it("reports liveness without touching dependencies", async () => {
    const response = await request(app).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toBe("mailops-api");
  });

  it("returns a readiness payload with per-dependency status", async () => {
    const response = await request(app).get("/health");
    expect([200, 503]).toContain(response.status);
    expect(response.body.dependencies).toHaveProperty("database");
    expect(response.body.dependencies).toHaveProperty("redis");
    expect(Array.isArray(response.body.degradedCapabilities)).toBe(true);
  });

  it("exposes a service root", async () => {
    const response = await request(app).get("/");
    expect(response.status).toBe(200);
    expect(response.body.name).toBe("MailOps API");
  });
});

describe("error envelope", () => {
  it("returns a structured 404 for an unknown route", async () => {
    const response = await request(app).get("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.requestId).toBeTruthy();
  });

  it("sets a correlation id header on every response", async () => {
    const response = await request(app).get("/health/live");
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("echoes a client-supplied request id", async () => {
    const response = await request(app).get("/health/live").set("x-request-id", "trace-abc-123");
    expect(response.headers["x-request-id"]).toBe("trace-abc-123");
  });
});

describe("authentication boundary", () => {
  it("rejects an unauthenticated request to a protected route", async () => {
    const response = await request(app).get("/api/applications");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a malformed bearer token", async () => {
    const response = await request(app).get("/api/applications").set("authorization", "Bearer not-a-real-jwt");
    expect(response.status).toBe(401);
  });
});

describe("validation", () => {
  it("rejects a weak password before any account work happens", async () => {
    const response = await request(app)
      .post("/api/auth/register")
      .set("x-csrf-token", "x")
      .set("cookie", "mailops_csrf=x")
      .send({ email: "person@example.com", password: "short" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid email address", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("x-csrf-token", "x")
      .set("cookie", "mailops_csrf=x")
      .send({ email: "not-an-email", password: "whatever12345" });

    expect(response.status).toBe(422);
  });

  it("rejects a missing body field", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("x-csrf-token", "x")
      .set("cookie", "mailops_csrf=x")
      .send({ email: "person@example.com" });

    expect(response.status).toBe(422);
    expect(response.body.error.details).toBeTruthy();
  });
});

describe("CSRF protection", () => {
  it("blocks a state-changing request without a CSRF token", async () => {
    const response = await request(app).post("/api/auth/login").send({ email: "person@example.com", password: "validpass123" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("blocks a state-changing request whose token does not match the cookie", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("x-csrf-token", "attacker-supplied")
      .set("cookie", "mailops_csrf=victim-value")
      .send({ email: "person@example.com", password: "validpass123" });

    expect(response.status).toBe(403);
  });

  it("allows safe methods without a CSRF token", async () => {
    const response = await request(app).get("/api/meta/taxonomy");
    expect(response.status).toBe(200);
  });
});

describe("taxonomy contract", () => {
  it("publishes the canonical enums the UI renders", async () => {
    const response = await request(app).get("/api/meta/taxonomy");
    expect(response.status).toBe(200);
    expect(response.body.data.emailCategories).toContain("JOB");
    expect(response.body.data.jobSubCategories).toContain("SHORTLISTED");
    expect(response.body.data.jobSubCategories).toContain("REJECTION");
    expect(response.body.data.applicationStatuses).toContain("OFFER");
    expect(response.body.data.escalationStages).toEqual(["SLACK", "WHATSAPP", "VOICE"]);
    expect(response.body.data.voiceEventKeys).toContain("OFFER");
  });
});

describe("security headers", () => {
  it("sets hardening headers", async () => {
    const response = await request(app).get("/health/live");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects a disallowed CORS origin", async () => {
    const response = await request(app).get("/health/live").set("origin", "https://evil.example.com");
    expect([403, 500]).toContain(response.status);
  });

  it("allows the configured web origin", async () => {
    const response = await request(app).get("/health/live").set("origin", "http://localhost:3000");
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });
});

describe("rate limiting", () => {
  it("exposes standard rate-limit headers", async () => {
    const response = await request(app).get("/api/meta/taxonomy");
    expect(response.headers["ratelimit-limit"] ?? response.headers["ratelimit"]).toBeTruthy();
  });
});
