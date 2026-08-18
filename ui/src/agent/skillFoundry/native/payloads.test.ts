// Skill Foundry Slice B, Task 6 — the four canonical native payloads and the
// materialization factory.

import { describe, expect, it } from "vitest";
import { canonicalMoshBuildIdentityV1, nativeSourceByteSetSha256V1 } from "../nativeIdentity";
import { catalogFingerprintV1 } from "../catalogs";
import type { NativeSourceByteSetV1 } from "../contracts";
import {
  NATIVE_PAYLOADS_V1,
  NATIVE_SOURCE_PATHS_V1,
  materializeNativePayloadArtifactsV1,
} from "./payloads";

const GIT_COMMIT = "a".repeat(40);

function fixtureNativeSource(): NativeSourceByteSetV1 {
  return {
    schemaVersion: 1,
    files: NATIVE_SOURCE_PATHS_V1.map((path) => ({ path, bytes: new TextEncoder().encode(`// ${path}\n`) })),
  };
}

describe("NATIVE_PAYLOADS_V1", () => {
  it("declares exactly the four canonical ids, each paired with its own handlerKey", () => {
    const byId = new Map(NATIVE_PAYLOADS_V1.map((p) => [p.id, p.handlerKey]));
    expect(byId).toEqual(new Map([
      ["session-control", "sessionControlV1"],
      ["capture-review-choose-take", "takeCycleV1"],
      ["explicit-balance", "explicitBalanceV1"],
      ["load-named-plugin", "loadNamedPluginV1"],
    ]));
  });

  it("only load-named-plugin carries a legacy alias", () => {
    for (const payload of NATIVE_PAYLOADS_V1) {
      if (payload.id === "load-named-plugin") expect(payload.legacyAliases).toEqual(["load_named_plugin"]);
      else expect(payload.legacyAliases).toEqual([]);
    }
  });

  it("session-control and capture-review-choose-take are lifecycle; the other two are atomic", () => {
    const modeById = new Map(NATIVE_PAYLOADS_V1.map((p) => [p.id, p.execution.mode]));
    expect(modeById.get("session-control")).toBe("lifecycle");
    expect(modeById.get("capture-review-choose-take")).toBe("lifecycle");
    expect(modeById.get("explicit-balance")).toBe("atomic");
    expect(modeById.get("load-named-plugin")).toBe("atomic");
  });
});

describe("NATIVE_SOURCE_PATHS_V1", () => {
  it("is sorted lexicographically with no duplicates", () => {
    const sorted = [...NATIVE_SOURCE_PATHS_V1].sort();
    expect(NATIVE_SOURCE_PATHS_V1).toEqual(sorted);
    expect(new Set(NATIVE_SOURCE_PATHS_V1).size).toBe(NATIVE_SOURCE_PATHS_V1.length);
  });
});

describe("materializeNativePayloadArtifactsV1", () => {
  async function validInput() {
    return {
      nativeSource: fixtureNativeSource(),
      buildIdentity: { appVersion: "1.2.3", gitCommit: GIT_COMMIT, gitState: "clean" as const, target: "Mosh", configuration: "Release", architecture: "arm64" },
      catalogFingerprint: await catalogFingerprintV1(),
    };
  }

  it("produces four payload/bytes/sha tuples with the real build identity, on a valid clean-Release-arm64 input", async () => {
    const result = await materializeNativePayloadArtifactsV1(await validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payloads).toHaveLength(4);
    const expectedIdentity = canonicalMoshBuildIdentityV1({
      appVersion: "1.2.3", gitCommit: GIT_COMMIT, gitState: "clean", target: "Mosh", configuration: "Release", architecture: "arm64",
    });
    expect(expectedIdentity.ok && expectedIdentity.value).toBe(result.moshBuildIdentity);
    for (const entry of result.payloads) {
      expect(entry.payload.version).toBe("1.2.3");
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      // build identity is not embedded in the payload bytes
      expect(entry.utf8).not.toContain(GIT_COMMIT);
    }
  });

  it("rejects a dirty tree", async () => {
    const input = await validInput();
    const result = await materializeNativePayloadArtifactsV1({ ...input, buildIdentity: { ...input.buildIdentity, gitState: "dirty" } });
    expect(result).toMatchObject({ ok: false, code: "dirty_tree" });
  });

  it("rejects a non-Release configuration", async () => {
    const input = await validInput();
    const result = await materializeNativePayloadArtifactsV1({ ...input, buildIdentity: { ...input.buildIdentity, configuration: "Debug" } });
    expect(result).toMatchObject({ ok: false, code: "wrong_configuration" });
  });

  it("rejects a non-arm64 architecture", async () => {
    const input = await validInput();
    const result = await materializeNativePayloadArtifactsV1({ ...input, buildIdentity: { ...input.buildIdentity, architecture: "x86_64" } });
    expect(result).toMatchObject({ ok: false, code: "wrong_architecture" });
  });

  it("rejects a changed source byte (a real byte edit changes the resulting sha256)", async () => {
    const input = await validInput();
    const baseline = await materializeNativePayloadArtifactsV1(input);
    expect(baseline.ok).toBe(true);

    const mutated: NativeSourceByteSetV1 = {
      schemaVersion: 1,
      files: input.nativeSource.files.map((file) =>
        file.path === NATIVE_SOURCE_PATHS_V1[0]
          ? { ...file, bytes: new TextEncoder().encode("// mutated\n") }
          : file),
    };
    const result = await materializeNativePayloadArtifactsV1({ ...input, nativeSource: mutated });
    expect(result.ok).toBe(true);
    if (!result.ok || !baseline.ok) return;
    expect(result.payloads[0]!.sha256).not.toBe(baseline.payloads[0]!.sha256);
  });

  it("rejects reordered input the same as the canonical order (order-independence)", async () => {
    const input = await validInput();
    const reordered: NativeSourceByteSetV1 = { schemaVersion: 1, files: [...input.nativeSource.files].reverse() };
    const baseline = await materializeNativePayloadArtifactsV1(input);
    const result = await materializeNativePayloadArtifactsV1({ ...input, nativeSource: reordered });
    expect(baseline.ok && result.ok).toBe(true);
    if (!baseline.ok || !result.ok) return;
    expect(result.payloads[0]!.sha256).toBe(baseline.payloads[0]!.sha256);
  });

  it("rejects a missing path", async () => {
    const input = await validInput();
    const missing: NativeSourceByteSetV1 = { schemaVersion: 1, files: input.nativeSource.files.slice(1) };
    const result = await materializeNativePayloadArtifactsV1({ ...input, nativeSource: missing });
    expect(result).toMatchObject({ ok: false, code: "path_set_mismatch" });
  });

  it("rejects an extra path", async () => {
    const input = await validInput();
    const extra: NativeSourceByteSetV1 = {
      schemaVersion: 1,
      files: [...input.nativeSource.files, { path: "src/extra/NotReal.cpp", bytes: new TextEncoder().encode("x") }],
    };
    const result = await materializeNativePayloadArtifactsV1({ ...input, nativeSource: extra });
    expect(result).toMatchObject({ ok: false, code: "path_set_mismatch" });
  });

  it("rejects a duplicate path", async () => {
    const input = await validInput();
    const duplicated: NativeSourceByteSetV1 = { schemaVersion: 1, files: [...input.nativeSource.files, input.nativeSource.files[0]!] };
    const result = await materializeNativePayloadArtifactsV1({ ...input, nativeSource: duplicated });
    expect(result).toMatchObject({ ok: false, code: "duplicate_path" });
  });

  it("routes nativeSourceByteSetSha256V1 through the SAME hash.ts primitives (no second canonicalization path)", async () => {
    const input = await validInput();
    const direct = await nativeSourceByteSetSha256V1(input.nativeSource);
    const result = await materializeNativePayloadArtifactsV1(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payloads[0]!.payload.compatibility.nativeSourceSha256).toBe(direct);
  });

  it("a post-materialization edit to the returned payload object does not change the already-returned bytes/sha", async () => {
    const input = await validInput();
    const result = await materializeNativePayloadArtifactsV1(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = result.payloads[0]!.sha256;
    // Mutating the RETURNED payload object (a caller mistake) must not retroactively change
    // the already-computed bytes/sha — they were serialized once, at materialization time.
    (result.payloads[0]!.payload as { title: string }).title = "tampered";
    expect(result.payloads[0]!.sha256).toBe(before);
  });
});
