// Task 3 — canonical native source-byte-set and build-identity primitives.
//
// SCOPE: these two functions are pure identity computations, not registration policy.
// `nativeSourceByteSetSha256V1` hashes the exact set of native source files a handler was
// built from (order-independent, byte-sensitive); `canonicalMoshBuildIdentityV1` formats a
// validated tuple into the one canonical string shape. Neither function decides whether a
// build is ACCEPTABLE for registering a native skill (clean git, Release configuration,
// arm64 architecture) — that acceptance policy lives in `packageValidation.ts`'s
// `validateNativeArtifactGraphV1`, which is the sole place that gates on those values. This
// split is deliberate: the same formatter is reusable by a Debug-configuration identity/
// collision gate (Task 5's `verifySkillIdentityUniverse.mts`) that does not require a clean
// tree, while only the Release runtime registration path enforces the strict policy.
//
// Both functions route every hash through `hash.ts`'s `canonicalJsonBytes`/`sha256Bytes` —
// no second canonicalization path is introduced here.

import { canonicalJsonBytes, sha256Bytes } from "./hash";
import type { MoshBuildIdentityInputV1, NativeSourceByteSetV1, ParseIssueV1, ParseResult } from "./contracts";

const COMMIT_HEX_REGEX = /^[0-9a-f]{40}$/;

/** SemVer core + optional prerelease, deliberately excluding build metadata — the same
 *  format `validate.ts`'s `checkVersion` enforces for manifest/native-payload versions. */
const SEMVER_NO_BUILD_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `target`/`configuration`/`architecture` are short bounded identifiers (e.g. "Mosh",
 *  "Release", "arm64") — not free text. */
const IDENTITY_FIELD_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Canonical digest of the exact native source-byte-set a handler was compiled from.
 *
 * Copies each input byte array before hashing (a caller's later mutation of a shared backing
 * buffer must never change what was hashed), sorts by normalized repo-relative path so input
 * order never affects the digest, and hashes
 * `canonicalJsonBytes({schemaVersion:1, files:[{path, bytes, sha256}]})` — where `bytes` is
 * the byte COUNT (not the bytes themselves; `canonicalJsonBytes` cannot carry binary data)
 * and `sha256` is the per-file digest of the exact stored bytes.
 *
 * This is a TRUSTED-input computation over data the native loader (Task 4) already read
 * safely from a fixed, ownership-checked root — not a boundary validator for untrusted bytes.
 * Defensive checks below (duplicate/absolute/escaping/empty paths, empty file list) guard
 * against a programming error in the caller and reject by throwing (a rejected promise),
 * which is appropriate for a precondition violation on already-trusted input, as opposed to
 * the discriminated `ParseResult`/`*ValidationResultV1` shapes this slice uses at the actual
 * untrusted-artifact boundary (`packageValidation.ts`).
 */
export async function nativeSourceByteSetSha256V1(input: NativeSourceByteSetV1): Promise<string> {
  if (input.schemaVersion !== 1) {
    throw new Error("nativeSourceByteSetSha256V1: schemaVersion must be 1");
  }
  if (input.files.length === 0) {
    throw new Error("nativeSourceByteSetSha256V1: files must not be empty");
  }

  const seenPaths = new Set<string>();
  const entries: { path: string; bytes: number; sha256: string }[] = [];

  for (const file of input.files) {
    const path = file.path;
    if (path.length === 0) {
      throw new Error("nativeSourceByteSetSha256V1: path must not be empty");
    }
    if (path.startsWith("/")) {
      throw new Error(`nativeSourceByteSetSha256V1: absolute path not permitted: ${path}`);
    }
    if (path.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error(`nativeSourceByteSetSha256V1: path escapes the repo root: ${path}`);
    }
    if (seenPaths.has(path)) {
      throw new Error(`nativeSourceByteSetSha256V1: duplicate path: ${path}`);
    }
    seenPaths.add(path);

    const copy = new Uint8Array(file.bytes.length);
    copy.set(file.bytes);
    const sha256 = await sha256Bytes(copy);
    entries.push({ path, bytes: copy.length, sha256 });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Bytes(canonicalJsonBytes({ schemaVersion: 1, files: entries }));
}

/**
 * Format a validated `MoshBuildIdentityInputV1` tuple into the one canonical build-identity
 * string: `git=<commit>|version=<version>|target=<target>|configuration=<configuration>|
 * architecture=<architecture>`.
 *
 * DESIGN DECISION: `gitState` is validated as a real three-valued enum (never trusted purely
 * by TypeScript's type — see contracts.ts's note that these identity inputs "accept
 * noncanonical strings so they can return typed failures rather than hiding them behind
 * TypeScript") but is deliberately NOT embedded in the output string and does not gate
 * success here. A clean/dirty/unknown tree can all be canonically NAMED by this function;
 * only `validateNativeArtifactGraphV1` (packageValidation.ts) decides whether a `dirty`/
 * `unknown` state, a non-Release configuration, or a non-arm64 architecture may actually
 * register a native skill. Keeping that policy out of this pure formatter is what lets a
 * Debug-configuration identity/collision gate reuse it without requiring a clean tree.
 */
export function canonicalMoshBuildIdentityV1(input: MoshBuildIdentityInputV1): ParseResult<string> {
  const issues: ParseIssueV1[] = [];

  if (!COMMIT_HEX_REGEX.test(input.gitCommit)) {
    issues.push({ code: "invalid_commit", path: "gitCommit", message: "gitCommit must be 40 lowercase hex characters" });
  }
  if (!SEMVER_NO_BUILD_REGEX.test(input.appVersion)) {
    issues.push({ code: "invalid_version", path: "appVersion", message: "appVersion must be SemVer without build metadata" });
  }
  if (input.gitState !== "clean" && input.gitState !== "dirty" && input.gitState !== "unknown") {
    issues.push({ code: "invalid_git_state", path: "gitState", message: "gitState must be one of clean|dirty|unknown" });
  }
  if (!IDENTITY_FIELD_REGEX.test(input.target)) {
    issues.push({ code: "invalid_target", path: "target", message: "target must be a bounded identifier" });
  }
  if (!IDENTITY_FIELD_REGEX.test(input.configuration)) {
    issues.push({ code: "invalid_configuration", path: "configuration", message: "configuration must be a bounded identifier" });
  }
  if (!IDENTITY_FIELD_REGEX.test(input.architecture)) {
    issues.push({ code: "invalid_architecture", path: "architecture", message: "architecture must be a bounded identifier" });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: `git=${input.gitCommit}|version=${input.appVersion}|target=${input.target}|configuration=${input.configuration}|architecture=${input.architecture}`,
  };
}
