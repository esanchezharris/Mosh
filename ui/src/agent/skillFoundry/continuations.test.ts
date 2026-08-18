// Task 6 — Bounded Single-Use Continuations.
//
// `createContinuationStoreV1` is a small in-memory `ContinuationStoreV1`: it stores a
// caller-built `ContinuationPayloadV1` behind a random token, hands it back exactly once
// (`take` deletes before returning, win or lose), enforces the SKILL_LIMITS_V1 caps
// (16-entry capacity, 5-choice cap, 3-attempt terminal cap), and treats a payload that is
// already expired at issuance as malformed. Nothing here decides WHEN to reissue, WHAT
// `choiceReason`/`pendingKind` a skill is in, or how to recompute `confirmationPlanSha256`
// — that is Task 8's declarative executor. This store only has to be honest about what it
// was handed and forget it exactly once.
//
// TIME CONTROL: every test drives the store's own injected `now` and `take`'s explicit
// `nowMs` parameter — nothing here sleeps on the real wall clock. Expiry is deterministic
// by construction.

import { describe, expect, it } from "vitest";
import type {
  ContinuationPayloadBaseV1,
  ContinuationPayloadV1,
} from "./contracts";
import { createContinuationStoreV1, type ContinuationStoreDepsV1 } from "./continuations";
import { SKILL_LIMITS_V1 } from "./limits";

const TTL = SKILL_LIMITS_V1.continuationTtlMs;

// Test payloads use small, arbitrary logical timestamps (1_000, 5_000, ...) rather than
// real epoch millis — so every store under test is built with a fixed `now` of 0 unless a
// test is specifically exercising the "already expired at issuance" guard, which injects
// its own `now` explicitly. Without this, the store's real default clock (`Date.now`) would
// see every fixture payload as already expired, for reasons having nothing to do with the
// behavior under test.
function testStore(deps: ContinuationStoreDepsV1 = {}): ReturnType<typeof createContinuationStoreV1> {
  return createContinuationStoreV1({ now: () => 0, ...deps });
}

function basePayload(overrides: Partial<ContinuationPayloadBaseV1> = {}): ContinuationPayloadBaseV1 {
  return {
    skillId: "owner-test-skill",
    version: "1.0.0",
    artifactSha256: "a".repeat(64),
    choices: [],
    targetIdentities: [{ role: "trackId", entityKind: "track", entityId: "track-1" }],
    projectEpoch: 1,
    registryGeneration: 1,
    sourceStatusGeneration: 1,
    createdAtMs: 1_000,
    expiresAtMs: 1_000 + TTL,
    attempts: 0,
    ...overrides,
  };
}

function choicePayload(overrides: Partial<ContinuationPayloadBaseV1> = {}): ContinuationPayloadV1 {
  return {
    ...basePayload(overrides),
    pendingKind: "choice",
    pendingSlot: "trackId",
    choiceReason: "ambiguity",
  };
}

function confirmationPayload(overrides: Partial<ContinuationPayloadBaseV1> = {}): ContinuationPayloadV1 {
  return {
    ...basePayload(overrides),
    pendingKind: "confirmation",
    pendingSlot: "confirmation",
    confirmationPlanSha256: "b".repeat(64),
  };
}

/** A `randomToken` stub that returns queued values in order, then falls back to a counter
 *  so tests never stall on an empty queue. */
function tokenSequence(...tokens: readonly string[]): () => string {
  const queue = [...tokens];
  let counter = 0;
  return () => queue.shift() ?? `auto-${(counter += 1)}`;
}

describe("createContinuationStoreV1", () => {
  it("issue()'d token is single-use: a second take() sees unknown_token", () => {
    const store = testStore();
    const issued = store.issue(choicePayload());
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("unreachable");

    const first = store.take(issued.token, 1_000);
    expect(first).toEqual({ ok: true, payload: choicePayload() });

    const second = store.take(issued.token, 1_000);
    expect(second).toEqual({ ok: false, code: "unknown_token" });
  });

  it("take() on a token that was never issued reports unknown_token", () => {
    const store = testStore();
    expect(store.take("never-issued", 1_000)).toEqual({ ok: false, code: "unknown_token" });
  });

  describe("ten-minute expiry", () => {
    it("take() strictly before expiresAtMs succeeds", () => {
      const store = testStore();
      const payload = choicePayload({ createdAtMs: 1_000, expiresAtMs: 1_000 + TTL });
      const issued = store.issue(payload);
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error("unreachable");
      expect(issued.expiresAtMs).toBe(1_000 + TTL);

      expect(store.take(issued.token, 1_000 + TTL - 1)).toEqual({ ok: true, payload });
    });

    it("take() at or after expiresAtMs reports expired, and still consumes the token", () => {
      const store = testStore();
      const payload = choicePayload({ createdAtMs: 1_000, expiresAtMs: 1_000 + TTL });
      const issued = store.issue(payload);
      if (!issued.ok) throw new Error("unreachable");

      expect(store.take(issued.token, 1_000 + TTL)).toEqual({ ok: false, code: "expired" });
      // Single-use even on the failure path: a later take() (were it not deleted) would
      // otherwise still report "expired" rather than "unknown_token", masking a leak.
      expect(store.take(issued.token, 1_000 + TTL)).toEqual({ ok: false, code: "unknown_token" });
    });

    it("rejects issuing a payload that is already expired at issuance", () => {
      const store = testStore({ now: () => 2_000_000 });
      const payload = choicePayload({ createdAtMs: 1_000, expiresAtMs: 1_000 + TTL });
      expect(store.issue(payload)).toEqual({ ok: false, code: "invalid_payload" });
    });
  });

  it("evicts the oldest unused entry once 16 are held", () => {
    const capacity = SKILL_LIMITS_V1.continuations;
    expect(capacity).toBe(16); // pin: the boundary below is meaningless if this constant drifts
    const tokens = Array.from({ length: capacity + 1 }, (_, i) => `tok-${i}`);
    const store = testStore({ randomToken: tokenSequence(...tokens) });

    for (const token of tokens) {
      const issued = store.issue(choicePayload({ createdAtMs: 1_000, expiresAtMs: 1_000 + TTL }));
      expect(issued).toMatchObject({ ok: true, token });
    }

    // The oldest (first-issued) entry was evicted to make room for the 17th.
    expect(store.take(tokens[0]!, 1_000)).toEqual({ ok: false, code: "unknown_token" });
    // Every entry issued after it is still resolvable.
    for (const token of tokens.slice(1)) {
      expect(store.take(token, 1_000)).toEqual({
        ok: true,
        payload: choicePayload({ createdAtMs: 1_000, expiresAtMs: 1_000 + TTL }),
      });
    }
  });

  it("rejects a duplicate token instead of overwriting the existing entry", () => {
    const store = testStore({ randomToken: tokenSequence("dup", "dup") });
    const first = store.issue(choicePayload({ artifactSha256: "1".repeat(64) }));
    expect(first).toEqual({ ok: true, token: "dup", expiresAtMs: 1_000 + TTL });

    const second = store.issue(choicePayload({ artifactSha256: "2".repeat(64) }));
    expect(second).toEqual({ ok: false, code: "token_collision" });

    // The original entry is untouched by the rejected collision.
    expect(store.take("dup", 1_000)).toEqual({
      ok: true,
      payload: choicePayload({ artifactSha256: "1".repeat(64) }),
    });
  });

  it("clear() forgets every held continuation", () => {
    const store = testStore({ randomToken: tokenSequence("a", "b") });
    const a = store.issue(choicePayload());
    const b = store.issue(confirmationPayload());
    if (!a.ok || !b.ok) throw new Error("unreachable");

    store.clear();

    expect(store.take(a.token, 1_000)).toEqual({ ok: false, code: "unknown_token" });
    expect(store.take(b.token, 1_000)).toEqual({ ok: false, code: "unknown_token" });
  });

  it("preserves the original createdAtMs/expiresAtMs across a reissue at a later store clock", () => {
    const store = testStore({ randomToken: tokenSequence("first", "second") });
    const original = choicePayload({ createdAtMs: 1_000, expiresAtMs: 1_000 + TTL, attempts: 0 });
    const issued = store.issue(original);
    if (!issued.ok) throw new Error("unreachable");

    // Caller consumes an invalid reply, then reissues with attempts+1 — same
    // createdAtMs/expiresAtMs as the original, well after the original issuance moment.
    const takeResult = store.take(issued.token, 1_000 + 500);
    expect(takeResult.ok).toBe(true);
    const reissued = store.issue({ ...original, attempts: 1 });
    expect(reissued).toEqual({ ok: true, token: "second", expiresAtMs: 1_000 + TTL });

    // The reissued continuation still expires at the ORIGINAL deadline, not TTL-from-now.
    expect(store.take("second", 1_000 + TTL - 1)).toMatchObject({
      ok: true,
      payload: { attempts: 1, createdAtMs: 1_000, expiresAtMs: 1_000 + TTL },
    });
  });

  describe("attempts cap", () => {
    it("accepts attempts 1 and 2", () => {
      const store = testStore({ randomToken: tokenSequence("t1", "t2") });
      expect(store.issue(choicePayload({ attempts: 1 }))).toMatchObject({ ok: true });
      expect(store.issue(choicePayload({ attempts: 2 }))).toMatchObject({ ok: true });
    });

    it("terminally blocks at attempts 3", () => {
      const store = testStore();
      expect(SKILL_LIMITS_V1.continuationInvalidAttempts).toBe(3); // pin: see capacity pin above
      expect(store.issue(choicePayload({ attempts: 3 }))).toEqual({
        ok: false,
        code: "invalid_payload",
      });
    });

    it("rejects a negative or non-integer attempts count", () => {
      const store = testStore();
      expect(store.issue(choicePayload({ attempts: -1 }))).toEqual({
        ok: false,
        code: "invalid_payload",
      });
      expect(store.issue(choicePayload({ attempts: 1.5 }))).toEqual({
        ok: false,
        code: "invalid_payload",
      });
    });
  });

  describe("choices cap", () => {
    const choice = (id: string) => ({ id, label: id, value: id });

    it("accepts exactly the cap and rejects one over", () => {
      const store = testStore({ randomToken: tokenSequence("ok", "over") });
      const atCap = Array.from({ length: SKILL_LIMITS_V1.choices }, (_, i) => choice(`c${i}`));
      const overCap = [...atCap, choice("one-too-many")];

      expect(store.issue(choicePayload({ choices: atCap }))).toMatchObject({ ok: true });
      expect(store.issue(choicePayload({ choices: overCap }))).toEqual({
        ok: false,
        code: "invalid_payload",
      });
    });
  });

  it("rejects a payload whose expiresAtMs does not come after createdAtMs", () => {
    const store = testStore();
    expect(
      store.issue(choicePayload({ createdAtMs: 5_000, expiresAtMs: 5_000 })),
    ).toEqual({ ok: false, code: "invalid_payload" });
    expect(
      store.issue(choicePayload({ createdAtMs: 5_000, expiresAtMs: 4_999 })),
    ).toEqual({ ok: false, code: "invalid_payload" });
  });

  it("round-trips every payload field exactly, for both pending kinds", () => {
    const store = testStore({ randomToken: tokenSequence("choice-tok", "confirm-tok") });
    const choice = choicePayload({
      skillId: "owner-mix-down",
      version: "2.3.1",
      artifactSha256: "c".repeat(64),
      choices: [{ id: "opt-1", label: "Track 1", value: "trk1" }],
      targetIdentities: [{ role: "trackId", entityKind: "track", entityId: "trk1" }],
      projectEpoch: 42,
      registryGeneration: 7,
      sourceStatusGeneration: 3,
      attempts: 1,
    });
    const confirmation = confirmationPayload({ skillId: "owner-mix-down", attempts: 2 });

    const choiceToken = store.issue(choice);
    const confirmationToken = store.issue(confirmation);
    if (!choiceToken.ok || !confirmationToken.ok) throw new Error("unreachable");

    expect(store.take(choiceToken.token, choice.createdAtMs)).toEqual({ ok: true, payload: choice });
    expect(store.take(confirmationToken.token, confirmation.createdAtMs)).toEqual({
      ok: true,
      payload: confirmation,
    });
  });

  it("generates 64-character lowercase-hex tokens by default", () => {
    const store = testStore();
    const issued = store.issue(choicePayload());
    if (!issued.ok) throw new Error("unreachable");
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
  });
});
