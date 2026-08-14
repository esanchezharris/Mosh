// Task 1 — Freeze Contracts, Limits, and Hash Semantics.
//
// This is the RED-first pin for the Skill Foundry's exact quotas and exact-byte hashing.
// The SHA-256 literal below is the VERIFIED digest of "a\n" (reproduced with
// `printf 'a\n' | shasum -a 256`). If `sha256Bytes` ever disagrees with it, the
// IMPLEMENTATION is wrong — never edit this literal to make the suite pass. It is the one
// thing pinning exact-byte hashing, and the whole slice's integrity chain rests on it.

import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256Bytes, utf8Bytes } from "./hash";
import { SKILL_LIMITS_V1 } from "./limits";

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
