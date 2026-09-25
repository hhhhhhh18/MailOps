import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { env } from "../../src/config/env";

/**
 * Rate limiting for the verification endpoints.
 *
 * This file exists on its own because the test deliberately exhausts the auth
 * limiter: doing that in a shared file would make every subsequent request in that
 * process return 429, which is a false failure for unrelated assertions. Vitest runs
 * each file in its own isolated module registry, so the counter here cannot leak.
 */
const app = createApp();

describe("rate limiting on resend-verification", () => {
  it("allows AUTH_RATE_LIMIT_MAX requests and then throttles", async () => {
    const attempts = env.AUTH_RATE_LIMIT_MAX + 1;
    const statuses: number[] = [];

    for (let i = 0; i < attempts; i += 1) {
      const response = await request(app)
        .post("/api/auth/resend-verification")
        // The limiter runs before authentication, so a session is not needed and no
        // database is touched — only the throttling behaviour is asserted.
        .set("Cookie", "mailops_csrf=matched")
        .set("X-CSRF-Token", "matched");

      statuses.push(response.status);
    }

    // Nothing before the limit was throttled…
    expect(statuses.slice(0, env.AUTH_RATE_LIMIT_MAX)).not.toContain(429);
    // …and the request past it is refused with a retryable rate-limit error.
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  // CSRF on this endpoint is asserted in email-verification.test.ts. It is not
  // repeated here on purpose: once the burst above has exhausted the limiter, every
  // later request in this file returns 429 and could not reach the CSRF check.
});
