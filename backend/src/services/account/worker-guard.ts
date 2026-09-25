import { prisma } from "../../config/prisma";

/**
 * Worker-side account-deletion guards.
 *
 * A user can be erased while jobs for them are already queued, delayed or in
 * flight. The database foreign keys are the backstop — once the `User` row is gone,
 * any insert carrying that `userId` fails — but relying on that alone is the wrong
 * behaviour for three reasons:
 *
 *  1. it produces a burst of FK-violation failures and BullMQ retries for a job
 *     whose work is meaningless;
 *  2. it cannot stop work that performs **no database write**, which is precisely
 *     the dangerous case: a cleanup job talking to the Gmail API could still modify
 *     a mailbox after the user asked to be erased;
 *  3. a deleted account is a normal, expected state — not an error condition.
 *
 * So every PII-bearing worker checks first and returns cleanly. Returning (rather
 * than throwing) marks the job complete, so there is no retry storm.
 */

/**
 * True when the referenced account still exists.
 *
 * A missing/absent `userId` returns true: global jobs (e.g. a retention sweep across
 * all users) carry no user and are not affected by any single account's deletion.
 */
export async function userStillExists(userId?: string | null): Promise<boolean> {
  if (!userId) return true;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  return user !== null;
}

/** Canonical early-return payload, so a skip is distinguishably not a failure. */
export function skippedForDeletedAccount(): { skipped: true; reason: string } {
  return { skipped: true, reason: "account-deleted" };
}
