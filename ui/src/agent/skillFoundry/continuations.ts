// Task 6 — Bounded Single-Use Continuations.
//
// `createContinuationStoreV1` is the only place a `ContinuationPayloadV1` (Task 1,
// contracts.ts) lives between the moment a declarative skill run pauses for a choice or a
// confirmation and the moment a reply resumes it. It is deliberately dumb: it does not know
// what a "choice" or a "confirmation" means, does not recompute `confirmationPlanSha256`,
// and does not decide when to reissue after an invalid reply — Task 8's declarative
// executor owns all of that. This module's only job is to hold what it was given, hand it
// back exactly once, and enforce the bounded-resource invariants from SKILL_LIMITS_V1 so a
// long-running session's continuation table cannot grow, leak, or replay unboundedly.
//
// DESIGN DECISION (factory name/shape not given by the plan — only the `ContinuationStoreV1`
// interface is): a plain closure-returning factory, matching this module's other `createXV1`/
// `buildXV1` constructors (e.g. `runAtomicSkillPlanV1`'s ALWAYS_OK_ATOMIC_GUARD sibling
// pattern) rather than a class — there is nothing here that benefits from `this`, and every
// other Slice A module is function-first.

import type { ContinuationPayloadV1, ContinuationStoreV1 } from "./contracts";
import { SKILL_LIMITS_V1 } from "./limits";

/**
 * `now` and `randomToken` are both injectable so tests never depend on the real wall clock
 * or on `crypto.getRandomValues` producing a particular byte sequence. `now` is used for
 * exactly one thing: `issue()` refuses to store a payload that is already expired at the
 * moment it is handed in (`payload.expiresAtMs <= now()`) — a caller-side bug (e.g. reusing
 * a stale `createdAtMs` past the TTL window) fails closed here rather than silently minting
 * a token nobody can ever redeem. `take(token, nowMs)` takes its own explicit `nowMs`
 * instead of reading the injected clock, because the whole point of the store's cross-slice
 * `take(token, nowMs)` signature (Cross-Slice APIs block) is that expiry is checked against
 * the caller's own clock at redemption time, not the store's clock at construction time.
 */
export type ContinuationStoreDepsV1 = {
  readonly now?: () => number;
  readonly randomToken?: () => string;
};

function defaultRandomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isValidPayload(payload: ContinuationPayloadV1, nowMs: number): boolean {
  if (!Number.isInteger(payload.attempts) || payload.attempts < 0) return false;
  if (payload.attempts >= SKILL_LIMITS_V1.continuationInvalidAttempts) return false;
  if (payload.choices.length > SKILL_LIMITS_V1.choices) return false;
  if (!(payload.expiresAtMs > payload.createdAtMs)) return false;
  if (payload.expiresAtMs <= nowMs) return false;
  return true;
}

/** Bounded, single-use, in-memory `ContinuationStoreV1`. No persistence, no cross-process
 *  sharing — a fresh store is created per skill runtime and cleared on project replacement
 *  or registry regeneration (Task 8's declarative executor calls `clear()` for both). */
export function createContinuationStoreV1(deps: ContinuationStoreDepsV1 = {}): ContinuationStoreV1 {
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? defaultRandomToken;

  // Map iteration order is insertion order, so the first key is always the
  // longest-held (oldest-unused) entry — exactly what "16-entry oldest-unused eviction"
  // needs, with no extra bookkeeping.
  const entries = new Map<string, ContinuationPayloadV1>();

  return {
    issue(payload) {
      if (!isValidPayload(payload, now())) {
        return { ok: false, code: "invalid_payload" };
      }

      const token = randomToken();
      if (entries.has(token)) {
        return { ok: false, code: "token_collision" };
      }

      if (entries.size >= SKILL_LIMITS_V1.continuations) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }

      entries.set(token, payload);
      return { ok: true, token, expiresAtMs: payload.expiresAtMs };
    },

    take(token, nowMs) {
      const payload = entries.get(token);
      // Single-use regardless of outcome: a redeemed OR expired token must never be
      // redeemable again, so delete before inspecting anything about the result.
      entries.delete(token);

      if (!payload) return { ok: false, code: "unknown_token" };
      if (nowMs >= payload.expiresAtMs) return { ok: false, code: "expired" };
      return { ok: true, payload };
    },

    clear() {
      entries.clear();
    },
  };
}
