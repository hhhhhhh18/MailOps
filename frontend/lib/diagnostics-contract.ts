/**
 * Compile-time regression guard for the sanitized diagnostics contract (F3).
 *
 * The frontend has no test runner, so this file is checked by `npm run typecheck`
 * (`tsc --noEmit`) and by `scripts/check-exports.mjs`, both of which run in CI and in
 * the standard verification sequence. It asserts the *exact* key set of `Diagnostics`,
 * so re-adding a field the backend deliberately removed — raw error strings, internal
 * queue names/depths, or the encryption key's length/fingerprint — fails the build
 * instead of silently reaching the UI.
 *
 * Type-level only: there is no runtime behaviour to test, and nothing imports this
 * module. Keep the assertions in sync with the sanitizer in
 * `backend/src/controllers/settings.controller.ts` (`diagnostics`).
 */
import type { Diagnostics } from "./types";

/** Standard exact-type equality that does not collapse unions or widen `any`. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/**
 * Each entry must type-check as `true`. `Expect<false>` is a compile error, so any
 * added or removed key anywhere below breaks `tsc`.
 */
export type DiagnosticsContractAssertions = [
  // Top level: status + dependencies + encryption presence + environment, nothing else.
  Expect<Equal<keyof Diagnostics, "status" | "dependencies" | "encryption" | "environment">>,

  // Status vocabulary must stay in step with the backend (and with GET /health).
  Expect<Equal<Diagnostics["status"], "ok" | "degraded" | "unavailable">>,

  // Dependencies: no `error` on database/redis; queues is an aggregate, not a list.
  Expect<
    Equal<
      keyof Diagnostics["dependencies"],
      "database" | "redis" | "queues" | "aiProvider" | "aiConfigured"
    >
  >,
  Expect<Equal<keyof Diagnostics["dependencies"]["database"], "ok">>,
  Expect<Equal<keyof Diagnostics["dependencies"]["redis"], "ok">>,
  Expect<Equal<keyof Diagnostics["dependencies"]["queues"], "available">>,

  // Encryption: presence only. No `length`, no `fingerprint`.
  Expect<Equal<keyof Diagnostics["encryption"], "configured">>,
];
