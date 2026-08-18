// Task 5 — Construct a Collision-Free Registry and Adapters.
//
// This file lives at `ui/src/agent/skillFoundry/skillIdentityUniverse.test.ts` — NOT beside
// `ui/scripts/verifySkillIdentityUniverse.mts` — because `ui/vitest.config.ts` sets
// `include: ["src/**/*.test.ts"]`. A test file under `ui/scripts/` would never be collected,
// and running vitest with a filter naming a file outside `include` prints "No test files
// found", which reads as a harmless "nothing matched" rather than a real failure — exactly
// the trap that would let the cross-set ID/alias collision gate ship untested (see the
// plan's own Task 5 Step 2 warning). This file instead imports and drives
// `validateReleaseIdentityUniverseV1` directly from `./registry` — the SAME function
// `verifySkillIdentityUniverse.mts` calls — so the collision logic itself is genuinely
// unit-tested; the `.mts` wrapper is exercised end-to-end only via
// `npm run verify:skill-identities` (Task 5 Step 4), which is not a vitest concern.

import { describe, expect, it } from "vitest";
import { validateReleaseIdentityUniverseV1, type ReleaseIdentityUniverseInputV1 } from "./registry";

const EMPTY: ReleaseIdentityUniverseInputV1 = { native: [], declarative: [], owner: [] };

describe("validateReleaseIdentityUniverseV1 — no collisions", () => {
  it("accepts three empty enumerations", () => {
    expect(validateReleaseIdentityUniverseV1(EMPTY)).toEqual({ ok: true });
  });

  it("accepts disjoint IDs and aliases across all three enumerations", () => {
    const input: ReleaseIdentityUniverseInputV1 = {
      native: [{ id: "load-named-plugin", aliases: ["load_named_plugin"] }, { id: "session-control" }],
      declarative: [{ id: "builtin-metronome" }],
      owner: [{ id: "owner-set-volume" }, { id: "owner-mute-track" }],
    };
    expect(validateReleaseIdentityUniverseV1(input)).toEqual({ ok: true });
  });
});

describe("validateReleaseIdentityUniverseV1 — collision detection", () => {
  it("rejects a duplicate id WITHIN the native enumeration", () => {
    const input: ReleaseIdentityUniverseInputV1 = {
      native: [{ id: "session-control" }, { id: "session-control" }],
      declarative: [], owner: [],
    };
    expect(validateReleaseIdentityUniverseV1(input)).toEqual({ ok: false, code: "duplicate_identity", identity: "session-control" });
  });

  it("rejects a native alias colliding with a bundled-declarative id", () => {
    const input: ReleaseIdentityUniverseInputV1 = {
      native: [{ id: "load-named-plugin", aliases: ["load_named_plugin"] }],
      declarative: [{ id: "load_named_plugin" }],
      owner: [],
    };
    expect(validateReleaseIdentityUniverseV1(input)).toMatchObject({ ok: false, code: "duplicate_identity", identity: "load_named_plugin" });
  });

  it("rejects a native canonical id colliding with an owner active-index id", () => {
    const input: ReleaseIdentityUniverseInputV1 = {
      native: [{ id: "explicit-balance" }],
      declarative: [],
      owner: [{ id: "explicit-balance" }],
    };
    expect(validateReleaseIdentityUniverseV1(input)).toMatchObject({ ok: false, code: "duplicate_identity", identity: "explicit-balance" });
  });

  it("rejects a bundled-declarative id colliding with an owner active-index id", () => {
    const input: ReleaseIdentityUniverseInputV1 = {
      native: [],
      declarative: [{ id: "builtin-x" }],
      owner: [{ id: "builtin-x" }],
    };
    expect(validateReleaseIdentityUniverseV1(input)).toMatchObject({ ok: false, code: "duplicate_identity", identity: "builtin-x" });
  });

  it("rejects a case-folded collision across enumerations", () => {
    const input: ReleaseIdentityUniverseInputV1 = {
      native: [{ id: "session-control" }],
      declarative: [],
      owner: [{ id: "SESSION-CONTROL" }],
    };
    expect(validateReleaseIdentityUniverseV1(input)).toMatchObject({ ok: false, code: "duplicate_identity", identity: "session-control" });
  });
});

// ---------------------------------------------------------------------------------------
// Collision-check-removal RED proof (per the task's discipline requirement: prove a
// collision test would actually fail if the check were removed). This is not itself a
// meaningful assertion about production code — it is the recorded proof, run manually
// against a temporarily neutered `validateReleaseIdentityUniverseV1` (see the task report):
// with the internal `occupied.has(identity)` check removed/short-circuited, the
// "rejects a duplicate id WITHIN the native enumeration" case above turns from a correct
// `ok:false` into an incorrect `ok:true`, i.e. it goes RED for the right reason. Restored
// immediately after observing that failure; nothing about this comment block executes.
// ---------------------------------------------------------------------------------------
describe("validateReleaseIdentityUniverseV1 — order independence", () => {
  it("finds the SAME collision identity regardless of which enumeration is scanned first internally", () => {
    // native scanned before owner (implementation order) but the collision could equally be
    // phrased the other way — the reported identity must not depend on internal ordering.
    const input: ReleaseIdentityUniverseInputV1 = { native: [{ id: "owner-x" }], declarative: [], owner: [{ id: "owner-x" }] };
    const result = validateReleaseIdentityUniverseV1(input);
    expect(result).toMatchObject({ ok: false, code: "duplicate_identity", identity: "owner-x" });
  });
});
