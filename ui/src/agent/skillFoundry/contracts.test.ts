// Task 1 — Freeze Contracts, Limits, and Hash Semantics.
//
// This is the RED-first pin for the Skill Foundry's exact quotas and exact-byte hashing.
// The SHA-256 literal below is the VERIFIED digest of "a\n" (reproduced with
// `printf 'a\n' | shasum -a 256`). If `sha256Bytes` ever disagrees with it, the
// IMPLEMENTATION is wrong — never edit this literal to make the suite pass. It is the one
// thing pinning exact-byte hashing, and the whole slice's integrity chain rests on it.

import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256Bytes, utf8Bytes } from "./hash";
import { FOUNDRY_LIMITS_V1, SKILL_LIMITS_V1 } from "./limits";

describe("SKILL_LIMITS_V1", () => {
  it("matches the frozen v1 quotas", () => {
    expect(SKILL_LIMITS_V1).toMatchObject({
      maxLoadedLocalSkills: 64,
      manifestBytes: 65536,
      certificationBytes: 262144,
      approvalBytes: 16384,
      releaseBytes: 4096,
      startupPackageBytes: 8388608,
      activationEntries: 64,
      sourceStatusEntries: 256,
      choices: 5,
      continuations: 16,
      continuationTtlMs: 600000,
      continuationInvalidAttempts: 3,
    });
  });
});

// The manifest-content quotas need the SAME literal pin, and for a reason that is easy to
// miss: every boundary test in validate.test.ts is written RELATIVE to this object
// (`withSlotCount(FOUNDRY_LIMITS_V1.slots)` / `... + 1`). Those tests correctly prove the
// validator enforces whatever the constant says — but they follow the constant wherever it
// goes. Loosening `slots: 16` to `9999` keeps the entire suite green, which was verified by
// mutation before this test existed. Without the pin below, any future repair loop can widen
// a quota to make something pass and nothing goes red: the "test that cannot fail" shape
// CLAUDE.md calls this repo's recurring failure mode.
//
// Values are the design spec's quota table (`docs/superpowers/specs/
// 2026-08-14-moshi-skill-foundry-design.md` §8.1), checked row by row. `toEqual`, not
// `toMatchObject`, so a silently ADDED quota also reds — a new bound is a deliberate
// contract change and should have to be stated here.
describe("FOUNDRY_LIMITS_V1", () => {
  it("matches the frozen v1 manifest-content quotas", () => {
    expect(FOUNDRY_LIMITS_V1).toEqual({
      skillIdChars: 64,
      titleChars: 80,
      descriptionChars: 512,
      positiveExamples: 32,
      negativeExamples: 32,
      exampleChars: 256,
      tags: 16,
      enumValues: 32,
      slots: 16,
      preconditions: 16,
      declaredStepNodes: 32,
      expandedPreflightCalls: 32,
      expandedMutationCommands: 32,
      postconditions: 16,
      argumentsPerCall: 16,
      provenanceReferences: 32,
      claimIdsPerReference: 16,
      maxChoices: 5,
      stringSlotChars: 1024,
      listSlotItems: 16,
      maxMutationsMin: 1,
      maxMutationsMax: 32,
      timeoutMsMin: 100,
      timeoutMsMax: 120000,
    });
  });
});

describe("sha256Bytes", () => {
  it("matches the verified digest of 'a\\n'", async () => {
    expect(await sha256Bytes(utf8Bytes("a\n"))).toBe(
      "87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7",
    );
  });
});

describe("canonicalJsonBytes", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(new TextDecoder().decode(canonicalJsonBytes({ z: 1, a: [true, "é"] }))).toBe(
      '{"a":[true,"é"],"z":1}',
    );
  });

  it("rejects undefined", () => {
    expect(() => canonicalJsonBytes({ a: undefined })).toThrow();
  });

  it("rejects functions", () => {
    expect(() => canonicalJsonBytes({ a: () => 1 })).toThrow();
  });

  it("rejects symbols", () => {
    expect(() => canonicalJsonBytes({ a: Symbol("x") })).toThrow();
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJsonBytes({ a: Number.NaN })).toThrow();
    expect(() => canonicalJsonBytes({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("rejects cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonBytes(cyclic)).toThrow();
  });
});
