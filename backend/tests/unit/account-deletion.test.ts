import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { deleteAccountSchema } from "../../src/controllers/auth.controller";
import {
  MAILBOX_NOTICE,
  MANUAL_REVOCATION_GUIDANCE,
  USER_OWNED_MODEL_KEYS,
} from "../../src/services/account/deletion.service";

/**
 * Account deletion: everything that needs no database.
 *
 * The destructive path itself (erasure, revocation ordering, receipts, Redis purge)
 * is covered in tests/integration/account-deletion.test.ts. Anything here that does
 * touch the database would be a mistake — these run on every commit.
 */
const app = createApp();

const VALID_BODY = { password: "SomePassw0rd!", confirmation: "someone@example.com" };

function withCsrf() {
  return request(app)
    .delete("/api/auth/account")
    .set("Cookie", "mailops_csrf=matched")
    .set("X-CSRF-Token", "matched");
}

describe("DELETE /api/auth/account — access control", () => {
  it("rejects an unauthenticated request", async () => {
    // Proves both that the route exists and that it requires a session: an
    // unregistered route would 404, and an unguarded one would not 401.
    const response = await withCsrf().send(VALID_BODY);
    expect(response.status).toBe(401);
  });

  it("rejects a request with no CSRF token at all", async () => {
    const response = await request(app).delete("/api/auth/account").send(VALID_BODY);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a CSRF cookie/header mismatch", async () => {
    const response = await request(app)
      .delete("/api/auth/account")
      .set("Cookie", "mailops_csrf=cookie-value")
      .set("X-CSRF-Token", "a-different-value")
      .send(VALID_BODY);

    expect(response.status).toBe(403);
  });

  it("rejects a bearer-token caller that has no CSRF token", async () => {
    // Bearer auth is exempt from CSRF by design (not cookie-reachable), so this must
    // fail on authentication instead — and must not have deleted anything.
    const response = await request(app)
      .delete("/api/auth/account")
      .set("Authorization", "Bearer not-a-real-token")
      .send(VALID_BODY);

    expect(response.status).toBe(401);
  });

  it("never echoes the submitted password back", async () => {
    const response = await withCsrf().send(VALID_BODY);
    expect(JSON.stringify(response.body)).not.toContain(VALID_BODY.password);
  });
});

describe("delete account request schema", () => {
  it("accepts exactly a password and a confirmation", () => {
    expect(deleteAccountSchema.safeParse(VALID_BODY).success).toBe(true);
  });

  it("rejects a smuggled target account id", () => {
    // The account being deleted comes only from the session. A client must not be
    // able to name a target, and `.strict()` turns the attempt into a 422 rather
    // than silently ignoring it.
    const result = deleteAccountSchema.safeParse({ ...VALID_BODY, userId: "someone-elses-id" });
    expect(result.success).toBe(false);
  });

  it("rejects any other unexpected field", () => {
    expect(deleteAccountSchema.safeParse({ ...VALID_BODY, keepApplicationHistory: false }).success).toBe(
      false,
    );
    expect(deleteAccountSchema.safeParse({ ...VALID_BODY, isDemo: true }).success).toBe(false);
  });

  it("requires the password", () => {
    const { password: _password, ...withoutPassword } = VALID_BODY;
    expect(deleteAccountSchema.safeParse(withoutPassword).success).toBe(false);
    expect(deleteAccountSchema.safeParse({ ...VALID_BODY, password: "" }).success).toBe(false);
  });

  it("requires the confirmation phrase", () => {
    const { confirmation: _confirmation, ...withoutConfirmation } = VALID_BODY;
    expect(deleteAccountSchema.safeParse(withoutConfirmation).success).toBe(false);
    expect(deleteAccountSchema.safeParse({ ...VALID_BODY, confirmation: "   " }).success).toBe(false);
  });

  it("trims the confirmation rather than rejecting padding", () => {
    const result = deleteAccountSchema.safeParse({ ...VALID_BODY, confirmation: "  a@b.com  " });
    expect(result.success).toBe(true);
    expect(result.success && result.data.confirmation).toBe("a@b.com");
  });
});

describe("external revocation disclosure", () => {
  it("claims automatic revocation only for Gmail", () => {
    // Only Google exposes a token revocation API that MailOps actually calls. Any
    // other entry claiming to be automatic would be a false statement to the user.
    const automatic = MANUAL_REVOCATION_GUIDANCE.filter((item) => item.automatic);
    expect(automatic.map((item) => item.id)).toEqual(["gmail"]);
  });

  it("covers every integration kind MailOps can hold credentials for", () => {
    const ids = MANUAL_REVOCATION_GUIDANCE.map((item) => item.id);
    for (const expected of ["gmail", "slack", "whatsapp", "voice", "email", "ai", "delivered"]) {
      expect(ids, `missing revocation guidance for ${expected}`).toContain(expected);
    }
  });

  it("states that delivered messages cannot be recalled", () => {
    const delivered = MANUAL_REVOCATION_GUIDANCE.find((item) => item.id === "delivered");
    expect(delivered?.automatic).toBe(false);
    expect(delivered?.detail).toMatch(/cannot be recalled/i);
  });

  it("states that the Gmail mailbox itself is untouched", () => {
    expect(MAILBOX_NOTICE).toMatch(/does not delete messages from your Gmail mailbox/i);
    const gmail = MANUAL_REVOCATION_GUIDANCE.find((item) => item.id === "gmail");
    expect(gmail?.detail).toMatch(/never modified or deleted by MailOps/i);
  });
});

describe("deletion inventory", () => {
  it("includes the model with no userId of its own", () => {
    // NotificationAttempt is only reachable through Notification. Omitting it would
    // mean an erasure that was not actually complete.
    expect(USER_OWNED_MODEL_KEYS.NotificationAttempt).toBe("notificationAttempts");
  });

  it("uses a unique count key per model", () => {
    const keys = Object.values(USER_OWNED_MODEL_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starts with the user row itself", () => {
    expect(USER_OWNED_MODEL_KEYS.User).toBe("user");
  });
});
