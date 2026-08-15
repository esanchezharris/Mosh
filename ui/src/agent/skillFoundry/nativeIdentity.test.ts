// Task 3 — Validate Source and Release Hash Chains.
//
// RED-first pin for the two pure native-identity primitives: the canonical repo-source
// byte-set digest (`nativeSourceByteSetSha256V1`) and the canonical build-identity string
// formatter (`canonicalMoshBuildIdentityV1`). Neither function applies REGISTRATION POLICY
// (clean-git-only, Release-only, arm64-only) — that gating lives in
// `packageValidation.ts`'s `validateNativeArtifactGraphV1`, tested separately. These two
// functions only prove: the source digest is order-independent and byte-sensitive, path
// inputs are defensively rejected, and the build-identity string is an exact, validated
// format — never a hidden second canonicalization path (`hash.ts` owns the one and only
// `canonicalJsonBytes`/`sha256Bytes`, reused here).

import { describe, expect, it } from "vitest";
import { canonicalMoshBuildIdentityV1, nativeSourceByteSetSha256V1 } from "./nativeIdentity";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const FILE_A = { path: "src/agent/CertifiedSkillLoader.h", bytes: bytesOf("header contents\n") };
const FILE_B = { path: "src/agent/CertifiedSkillLoader.cpp", bytes: bytesOf("source contents\n") };

describe("nativeSourceByteSetSha256V1", () => {
  it("produces a stable digest for a sorted, two-file source set", async () => {
    const digest = await nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [FILE_A, FILE_B] });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to input order", async () => {
    const forward = await nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [FILE_A, FILE_B] });
    const reversed = await nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [FILE_B, FILE_A] });
    expect(reversed).toBe(forward);
  });

  it("is sensitive to a one-byte change in a source file", async () => {
    const before = await nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [FILE_A, FILE_B] });
    const mutatedB = { path: FILE_B.path, bytes: bytesOf("source contentZ\n") };
    const after = await nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [FILE_A, mutatedB] });
    expect(after).not.toBe(before);
  });

  it("does not mutate the caller's backing byte arrays", async () => {
    const original = bytesOf("immutable\n");
    const copyBefore = Array.from(original);
    await nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [{ path: "a", bytes: original }] });
    // Compared as plain arrays: vitest's `toEqual` on two Uint8Array instances can report a
    // spurious diff ("no visual difference") depending on their underlying ArrayBuffer
    // allocation, even when every byte value is identical (verified manually). Comparing
    // `Array.from(...)` output sidesteps that Uint8Array-equality quirk entirely.
    expect(Array.from(original)).toEqual(copyBefore);
  });

  it("rejects a duplicate path", async () => {
    await expect(
      nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [FILE_A, FILE_A] }),
    ).rejects.toThrow();
  });

  it("rejects an absolute path", async () => {
    await expect(
      nativeSourceByteSetSha256V1({
        schemaVersion: 1,
        files: [{ path: "/etc/passwd", bytes: bytesOf("x") }],
      }),
    ).rejects.toThrow();
  });

  it("rejects a path that escapes the repo root", async () => {
    await expect(
      nativeSourceByteSetSha256V1({
        schemaVersion: 1,
        files: [{ path: "../../etc/passwd", bytes: bytesOf("x") }],
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty path", async () => {
    await expect(
      nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [{ path: "", bytes: bytesOf("x") }] }),
    ).rejects.toThrow();
  });

  it("rejects a missing (empty) file list", async () => {
    await expect(nativeSourceByteSetSha256V1({ schemaVersion: 1, files: [] })).rejects.toThrow();
  });
});

describe("canonicalMoshBuildIdentityV1", () => {
  const CLEAN_INPUT = {
    gitCommit: "a".repeat(40),
    appVersion: "1.0.0",
    gitState: "clean" as const,
    target: "Mosh",
    configuration: "Release",
    architecture: "arm64",
  };

  it("formats the exact canonical tuple for a clean Release arm64 build", () => {
    const result = canonicalMoshBuildIdentityV1(CLEAN_INPUT);
    expect(result).toEqual({
      ok: true,
      value: `git=${"a".repeat(40)}|version=1.0.0|target=Mosh|configuration=Release|architecture=arm64`,
    });
  });

  it("is a pure shape formatter: dirty gitState still canonicalizes (registration policy lives elsewhere)", () => {
    const result = canonicalMoshBuildIdentityV1({ ...CLEAN_INPUT, gitState: "dirty" });
    expect(result.ok).toBe(true);
  });

  it("is a pure shape formatter: unknown gitState still canonicalizes", () => {
    const result = canonicalMoshBuildIdentityV1({ ...CLEAN_INPUT, gitState: "unknown" });
    expect(result.ok).toBe(true);
  });

  it("is a pure shape formatter: non-Release configuration still canonicalizes", () => {
    const result = canonicalMoshBuildIdentityV1({ ...CLEAN_INPUT, configuration: "Debug" });
    expect(result).toEqual({
      ok: true,
      value: `git=${"a".repeat(40)}|version=1.0.0|target=Mosh|configuration=Debug|architecture=arm64`,
    });
  });

  it("rejects a non-40-hex commit (too short)", () => {
    const result = canonicalMoshBuildIdentityV1({ ...CLEAN_INPUT, gitCommit: "a".repeat(39) });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-40-hex commit (uppercase)", () => {
    const result = canonicalMoshBuildIdentityV1({ ...CLEAN_INPUT, gitCommit: "A".repeat(40) });
    expect(result.ok).toBe(false);
  });

  it("rejects a version with build metadata", () => {
    const result = canonicalMoshBuildIdentityV1({ ...CLEAN_INPUT, appVersion: "1.0.0+build.5" });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty target", () => {
    const result = canonicalMoshBuildIdentityV1({ ...CLEAN_INPUT, target: "" });
    expect(result.ok).toBe(false);
  });

  it("accumulates every failing field as a separate issue", () => {
    const result = canonicalMoshBuildIdentityV1({
      ...CLEAN_INPUT,
      gitCommit: "not-hex",
      appVersion: "not-semver",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});
