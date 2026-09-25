import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import {
  USER_OWNED_MODEL_KEYS,
  type UserOwnedModel,
} from "../../src/services/account/deletion.service";

/**
 * Account-deletion drift guard.
 *
 * The most likely way this feature breaks in future is not a bug in the code — it is
 * someone adding a new user-owned model and not thinking about account deletion. The
 * data then survives an erasure that reports success, which is the worst possible
 * failure for a privacy feature: silent.
 *
 * So nothing here is hardcoded to "today's 16 models". The real relationship is
 * derived from two sources:
 *
 *   1. the Prisma DMMF (the actual generated schema) — which models exist and which
 *      relation fields hold foreign keys;
 *   2. the migration SQL — the actual ON DELETE rule on each foreign key, which is
 *      what PostgreSQL enforces at runtime.
 *
 * From those it computes the set of models that a `DELETE FROM "User"` really
 * cascades, and asserts that this set is exactly the set the deletion service counts.
 * Add a model with a cascading FK to User and this test fails until the service
 * accounts for it.
 */

const DMMF_MODELS = Prisma.dmmf.datamodel.models;

/** (table, column) → ON DELETE rule, read from the migration history. */
function foreignKeyRules(): Map<string, string> {
  const dir = path.resolve(process.cwd(), "prisma", "migrations");
  const sql = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(path.join(dir, entry.name))
        .filter((file) => file.endsWith(".sql"))
        .map((file) => path.join(dir, entry.name, file)),
    )
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  const rules = new Map<string, string>();
  const pattern =
    /ALTER TABLE "(\w+)"\s+ADD CONSTRAINT "[^"]*" FOREIGN KEY \("(\w+)"\) REFERENCES "(\w+)"\("(\w+)"\) ON DELETE (\w+)/gi;

  for (const match of sql.matchAll(pattern)) {
    rules.set(`${match[1]}.${match[2]}`, match[5].toUpperCase());
  }
  return rules;
}

/**
 * Models whose rows are removed by the cascade when `modelName` is deleted.
 *
 * A model is a cascade child when it holds a relation to `modelName` and *every*
 * foreign-key column of that relation is `ON DELETE CASCADE`. A relation that is
 * `SET NULL` deliberately keeps the row, so it is not a child.
 */
function cascadeChildren(modelName: string, rules: Map<string, string>): string[] {
  const children: string[] = [];

  for (const model of DMMF_MODELS) {
    for (const field of model.fields) {
      if (field.kind !== "object") continue;
      if (field.type !== modelName) continue;

      const fromFields = field.relationFromFields ?? [];
      if (fromFields.length === 0) continue;

      const allCascade = fromFields.every(
        (column) => rules.get(`${model.name}.${column}`) === "CASCADE",
      );
      if (allCascade) {
        children.push(model.name);
        break;
      }
    }
  }

  return children;
}

/** Every model erased, transitively, by deleting a User row (User itself excluded). */
function cascadeReachableFromUser(rules: Map<string, string>): Set<string> {
  const reached = new Set<string>();
  const queue = ["User"];

  while (queue.length) {
    const current = queue.shift() as string;
    for (const child of cascadeChildren(current, rules)) {
      if (reached.has(child)) continue;
      reached.add(child);
      queue.push(child);
    }
  }

  return reached;
}

const RULES = foreignKeyRules();
const CASCADED = cascadeReachableFromUser(RULES);
const MAPPED = (Object.keys(USER_OWNED_MODEL_KEYS) as UserOwnedModel[]).filter(
  (model) => model !== "User",
);

describe("account deletion: schema coverage", () => {
  it("reads a real cascade graph from the schema and migrations", () => {
    // If either source silently stopped working, every assertion below would pass
    // vacuously. Guard against that explicitly.
    expect(DMMF_MODELS.length).toBeGreaterThanOrEqual(16);
    expect(RULES.size).toBeGreaterThanOrEqual(14);
    expect(CASCADED.size).toBeGreaterThanOrEqual(15);
    expect(RULES.get("Email.userId")).toBe("CASCADE");
    expect(RULES.get("NotificationAttempt.notificationId")).toBe("CASCADE");
  });

  it("covers every cascaded model in the deletion inventory", () => {
    const unmapped = [...CASCADED].filter((model) => !(model in USER_OWNED_MODEL_KEYS)).sort();

    expect(
      unmapped,
      `These models are erased by the User cascade but are absent from USER_OWNED_MODEL_KEYS, ` +
        `so their rows would be deleted without being counted or reported. Add them to the ` +
        `inventory and to countOne() in services/account/deletion.service.ts.`,
    ).toEqual([]);
  });

  it("does not claim to erase anything the cascade leaves behind", () => {
    const notCascaded = MAPPED.filter((model) => !CASCADED.has(model)).sort();

    expect(
      notCascaded,
      `These models are listed as user-owned but are NOT removed by deleting the User row. ` +
        `Either the foreign key needs ON DELETE CASCADE, or the model needs explicit ` +
        `deletion in the account-deletion service.`,
    ).toEqual([]);
  });

  it("accounts for the model with no userId of its own", () => {
    // NotificationAttempt is reachable only through Notification. It is the row a
    // hand-written inventory forgets, which is why it is asserted by name as well as
    // by the generic graph check above.
    const attempt = DMMF_MODELS.find((model) => model.name === "NotificationAttempt");
    expect(attempt, "NotificationAttempt model must exist").toBeDefined();
    expect(
      attempt?.fields.some((field) => field.name === "userId"),
      "NotificationAttempt is expected to have no userId; if that changed, remove this exemption",
    ).toBe(false);

    expect(CASCADED.has("NotificationAttempt")).toBe(true);
    expect(USER_OWNED_MODEL_KEYS.NotificationAttempt).toBe("notificationAttempts");
  });

  it("keeps the receipt table free of any User foreign key", () => {
    // The receipt must outlive the user row it describes. A foreign key to User would
    // make it cascade away with the very deletion it exists to prove.
    const receipt = DMMF_MODELS.find((model) => model.name === "AccountDeletionRecord");
    expect(receipt, "AccountDeletionRecord model must exist").toBeDefined();

    const relationsToUser = (receipt?.fields ?? []).filter(
      (field) => field.kind === "object" && field.type === "User",
    );
    expect(relationsToUser, "AccountDeletionRecord must not relate to User").toEqual([]);
    expect(
      (receipt?.fields ?? []).some((field) => field.name === "userId"),
      "AccountDeletionRecord must not carry a raw userId",
    ).toBe(false);

    expect(RULES.has("AccountDeletionRecord.userId")).toBe(false);
    expect(CASCADED.has("AccountDeletionRecord")).toBe(false);
  });

  it("does not carry stale model names in the inventory", () => {
    const known = new Set(DMMF_MODELS.map((model) => model.name));
    const stale = Object.keys(USER_OWNED_MODEL_KEYS).filter((model) => !known.has(model));

    expect(stale, "USER_OWNED_MODEL_KEYS names a model that no longer exists").toEqual([]);
  });

  it("keeps the receipt migration additive and free of destructive statements", () => {
    const dir = path.resolve(process.cwd(), "prisma", "migrations");
    const receiptMigration = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.includes("account_deletion"))
      .map((entry) => path.join(dir, entry.name, "migration.sql"))
      .filter((file) => existsSync(file));

    expect(receiptMigration.length, "a receipt migration must exist").toBeGreaterThan(0);

    const sql = receiptMigration.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(sql).toMatch(/CREATE TABLE "AccountDeletionRecord"/);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    // No existing table may be altered by this migration.
    expect(sql).not.toMatch(/ALTER TABLE "(?!AccountDeletionRecord)/);
  });
});
