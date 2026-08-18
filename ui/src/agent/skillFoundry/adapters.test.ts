// Task 5 — Construct a Collision-Free Registry and Adapters.
//
// RED-first pin for `adaptNativeSkillV1` (nativeAdapter.ts) and `adaptDeclarativeSkillV1`
// (declarativeAdapter.ts). The native adapter cases exercise REAL Task 3
// (`validateNativeArtifactGraphV1`) failures — built the same way packageValidation.test.ts
// builds them (actual SHA-256 digests over actually-serialized JSON, never a hand-typed
// placeholder hash) — to prove the adapter forwards them UNCHANGED rather than re-deriving a
// different error ("it does not implement a second graph checker").

import { describe, expect, it } from "vitest";
import { catalogFingerprintV1 } from "./catalogs";
import type { CatalogFingerprintV1, NativeSkillPayloadV1, SkillCompatibilityContextV1, SkillManifestV1 } from "./contracts";
import { canonicalMoshBuildIdentityV1 } from "./nativeIdentity";
import { sha256Bytes, utf8Bytes } from "./hash";
import { validateNativeArtifactGraphV1, type ValidatedDeclarativeSkillV1 } from "./packageValidation";
import { adaptNativeSkillV1, adaptCodeBoundNativeSkillV1 } from "./nativeAdapter";
import { adaptDeclarativeSkillV1 } from "./declarativeAdapter";
import { NATIVE_PAYLOADS_V1 } from "./native/index";

// ---------------------------------------------------------------------------------------
// Shared fixture helpers (mirrors packageValidation.test.ts's own helpers — kept local
// rather than imported so this file's RED does not depend on that file's internals).
// ---------------------------------------------------------------------------------------

async function toFile(name: string, value: unknown) {
  const utf8 = JSON.stringify(value);
  const bytes = utf8Bytes(utf8);
  const sha256 = await sha256Bytes(bytes);
  return { name, bytes: bytes.length, sha256, utf8 };
}

const GIT_COMMIT = "b".repeat(40);
const APP_VERSION = "1.0.0";

async function buildContext(overrides: Partial<SkillCompatibilityContextV1> = {}): Promise<SkillCompatibilityContextV1> {
  const catalogFingerprint: CatalogFingerprintV1 = await catalogFingerprintV1();
  const identity = canonicalMoshBuildIdentityV1({
    gitCommit: GIT_COMMIT, appVersion: APP_VERSION, gitState: "clean",
    target: "Mosh", configuration: "Release", architecture: "arm64",
  });
  if (!identity.ok) throw new Error("test fixture: expected a valid build identity");
  return {
    appVersion: APP_VERSION, gitCommit: GIT_COMMIT, gitState: "clean", moshBuildIdentity: identity.value,
    catalogFingerprint,
    nativeSourceSha256ByHandler: {
      sessionControlV1: "c".repeat(64), takeCycleV1: "d".repeat(64),
      explicitBalanceV1: "e".repeat(64), loadNamedPluginV1: "f".repeat(64),
    },
    ...overrides,
  };
}

async function buildValidNativeGraphInput(
  context: SkillCompatibilityContextV1,
  id: NativeSkillPayloadV1["id"],
  handlerKey: NativeSkillPayloadV1["handlerKey"],
  legacyAliases: readonly string[],
) {
  const payload = {
    schemaVersion: 1, id, version: "1.0.0", implementation: "native", handlerKey,
    title: id, description: "test native skill",
    intents: { positiveExamples: [], negativeExamples: [], tags: [] },
    slots: [],
    execution: { mode: "atomic", confirmation: "never" },
    responses: { completed: "done", needsChoice: "which one?", blocked: "couldn't do that" },
    provenance: [],
    legacyAliases,
    compatibility: {
      minMoshVersion: "1.0.0",
      commandCatalogSha256: context.catalogFingerprint.commandCatalogSha256,
      predicateCatalogVersion: context.catalogFingerprint.predicateCatalogVersion,
      resolverCatalogVersion: context.catalogFingerprint.resolverCatalogVersion,
      nativeSourceSha256: context.nativeSourceSha256ByHandler[handlerKey],
    },
  };
  const payloadFile = await toFile("payload.json", payload);

  const report = {
    schemaVersion: 1, state: "acceptance_green",
    artifact: { kind: "native_payload", sha256: payloadFile.sha256 },
    commandCatalogSha256: context.catalogFingerprint.commandCatalogSha256,
    predicateCatalogVersion: context.catalogFingerprint.predicateCatalogVersion,
    resolverCatalogVersion: context.catalogFingerprint.resolverCatalogVersion,
  };
  const certificationFile = await toFile("certification.json", report);

  const reviewSha256 = await sha256Bytes(utf8Bytes(`mosh-skill-review-v1\n${payloadFile.sha256}\n${certificationFile.sha256}\n`));
  const approval = {
    schemaVersion: 1, state: "owner_approved",
    artifact: { kind: "native_payload", sha256: payloadFile.sha256 },
    certificationReportSha256: certificationFile.sha256, reviewSha256,
  };
  const approvalFile = await toFile("approval.json", approval);

  const bundleEntry = {
    schemaVersion: 1, state: "owner_approved", skillId: payload.id, version: payload.version,
    nativePayloadSha256: payloadFile.sha256, certificationReportSha256: certificationFile.sha256,
    approvalSha256: approvalFile.sha256, moshBuildIdentity: context.moshBuildIdentity,
    bundledAt: "2026-08-14T00:00:00.000Z",
  };
  const bundleEntryFile = await toFile("bundleEntry.json", bundleEntry);

  return { payload: payloadFile, certification: certificationFile, approval: approvalFile, bundleEntry: bundleEntryFile };
}

// ---------------------------------------------------------------------------------------
// adaptNativeSkillV1 — success + alias pinning
// ---------------------------------------------------------------------------------------

describe("adaptNativeSkillV1 — success", () => {
  it("adapts a valid graph with no legacy aliases", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "session-control", "sessionControlV1", []);
    const graph = await validateNativeArtifactGraphV1(input, context);
    expect(graph.ok).toBe(true);
    const result = adaptNativeSkillV1(graph);
    expect(result).toMatchObject({ ok: true, value: { id: "session-control", origin: "native", aliases: [] } });
  });

  it("pins load_named_plugin -> load-named-plugin", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "load-named-plugin", "loadNamedPluginV1", ["load_named_plugin"]);
    const graph = await validateNativeArtifactGraphV1(input, context);
    expect(graph.ok).toBe(true);
    const result = adaptNativeSkillV1(graph);
    expect(result).toMatchObject({ ok: true, value: { id: "load-named-plugin", origin: "native", aliases: ["load_named_plugin"] } });
  });

  it("forwards the native payload as the candidate manifest", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "explicit-balance", "explicitBalanceV1", []);
    const graph = await validateNativeArtifactGraphV1(input, context);
    const result = adaptNativeSkillV1(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest).toMatchObject({ id: "explicit-balance", handlerKey: "explicitBalanceV1" });
  });
});

describe("adaptNativeSkillV1 — alias pinning rejects an unpinned or mis-owned alias", () => {
  it("rejects an alias not in the closed NATIVE_SKILL_LEGACY_ALIASES_V1 table", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "load-named-plugin", "loadNamedPluginV1", ["not_a_real_alias"]);
    const graph = await validateNativeArtifactGraphV1(input, context);
    expect(graph.ok).toBe(true); // Task 3 only checks FORMAT, not the pinned table.
    const result = adaptNativeSkillV1(graph);
    expect(result).toMatchObject({ ok: false, code: "unpinned_native_alias" });
  });

  it("rejects a DIFFERENT id claiming an alias pinned to another id", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "session-control", "sessionControlV1", ["load_named_plugin"]);
    const graph = await validateNativeArtifactGraphV1(input, context);
    expect(graph.ok).toBe(true);
    const result = adaptNativeSkillV1(graph);
    expect(result).toMatchObject({ ok: false, code: "unpinned_native_alias" });
  });
});

describe("adaptNativeSkillV1 — forwards Task 3 graph failures verbatim (no second graph checker)", () => {
  it("forwards a chain hash mismatch (payload tampered on disk)", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "session-control", "sessionControlV1", []);
    const tampered = { ...input, payload: { ...input.payload, utf8: input.payload.utf8.slice(0, -1) + (input.payload.utf8.endsWith("}") ? " }" : "!") } };
    const graph = await validateNativeArtifactGraphV1(tampered, context);
    expect(graph).toMatchObject({ ok: false, code: "hash_mismatch" });
    const result = adaptNativeSkillV1(graph);
    expect(result).toEqual(graph);
  });

  it("forwards a native-source-hash mismatch", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "session-control", "sessionControlV1", []);
    const driftedContext: SkillCompatibilityContextV1 = {
      ...context,
      nativeSourceSha256ByHandler: { ...context.nativeSourceSha256ByHandler, sessionControlV1: "9".repeat(64) },
    };
    const graph = await validateNativeArtifactGraphV1(input, driftedContext);
    expect(graph).toMatchObject({ ok: false, code: "native_source_mismatch" });
    const result = adaptNativeSkillV1(graph);
    expect(result).toEqual(graph);
  });

  it("forwards a catalog fingerprint mismatch", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "session-control", "sessionControlV1", []);
    // Validate the SAME self-consistent graph against a context whose OWN catalog
    // fingerprint has drifted — isolates the fingerprint check from the hash chain (which
    // stays entirely self-consistent: nothing about `input`'s bytes changes).
    const driftedContext: SkillCompatibilityContextV1 = {
      ...context,
      catalogFingerprint: { ...context.catalogFingerprint, predicateCatalogVersion: 999 },
    };
    const graph = await validateNativeArtifactGraphV1(input, driftedContext);
    expect(graph).toMatchObject({ ok: false, code: "catalog_fingerprint_mismatch" });
    const result = adaptNativeSkillV1(graph);
    expect(result).toEqual(graph);
  });

  it("forwards a bundle-entry chain mismatch (payload/report/approval/bundle mismatch)", async () => {
    const context = await buildContext();
    const input = await buildValidNativeGraphInput(context, "session-control", "sessionControlV1", []);
    const otherInput = await buildValidNativeGraphInput(context, "explicit-balance", "explicitBalanceV1", []);
    const badInput = { ...input, bundleEntry: otherInput.bundleEntry };
    const graph = await validateNativeArtifactGraphV1(badInput, context);
    expect(graph).toMatchObject({ ok: false, code: "chain_mismatch" });
    const result = adaptNativeSkillV1(graph);
    expect(result).toEqual(graph);
  });
});

// ---------------------------------------------------------------------------------------
// adaptCodeBoundNativeSkillV1 — owner decision, CODE-BOUND SEEDING. Unlike
// `adaptNativeSkillV1` above, this adapter's whole INPUT is the compiled-in
// `NATIVE_PAYLOADS_V1` constant (native/payloads.ts) — there is no Task 3 artifact graph to
// forward, because there is no external byte source to check. What it DOES still enforce is
// schema-level shape (`parseNativeSkillPayloadV1`) and the same legacy-alias pin
// `adaptNativeSkillV1` enforces — see nativeAdapter.ts's own header for the full trust-root
// reasoning. These tests corrupt PAYLOAD CLONES (never `NATIVE_PAYLOADS_V1` itself, which
// stays real/compiled-in throughout) to prove each check is load-bearing.
// ---------------------------------------------------------------------------------------

describe("adaptCodeBoundNativeSkillV1 — the compiled-in, code-bound seeding path", () => {
  it("accepts every real compiled-in payload (NATIVE_PAYLOADS_V1) unmodified", () => {
    for (const payload of NATIVE_PAYLOADS_V1) {
      const result = adaptCodeBoundNativeSkillV1(payload);
      expect(result).toMatchObject({ ok: true, value: { id: payload.id, origin: "native" } });
    }
  });

  it("pins load_named_plugin -> load-named-plugin for the real compiled-in payload", () => {
    const payload = NATIVE_PAYLOADS_V1.find((p) => p.id === "load-named-plugin");
    if (!payload) throw new Error("test fixture: load-named-plugin payload missing from NATIVE_PAYLOADS_V1");
    const result = adaptCodeBoundNativeSkillV1(payload);
    expect(result).toMatchObject({ ok: true, value: { id: "load-named-plugin", origin: "native", aliases: ["load_named_plugin"] } });
  });

  it("forwards the validated payload as the candidate manifest", () => {
    const payload = NATIVE_PAYLOADS_V1.find((p) => p.id === "explicit-balance");
    if (!payload) throw new Error("test fixture: explicit-balance payload missing from NATIVE_PAYLOADS_V1");
    const result = adaptCodeBoundNativeSkillV1(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest).toMatchObject({ id: "explicit-balance", handlerKey: "explicitBalanceV1" });
  });

  // GUARD-REMOVAL PROOF (a) — alias pinning. Temporarily deleting the alias-pin loop in
  // `adaptCodeBoundNativeSkillV1` (nativeAdapter.ts) makes this test fail; see the session
  // report for the observed RED output. Restored before landing.
  it("GUARD-REMOVAL PROOF (a): rejects a payload clone whose alias is pinned to a DIFFERENT id", () => {
    const base = NATIVE_PAYLOADS_V1.find((p) => p.id === "session-control");
    if (!base) throw new Error("test fixture: session-control payload missing from NATIVE_PAYLOADS_V1");
    const corrupted: NativeSkillPayloadV1 = { ...base, legacyAliases: ["load_named_plugin"] };
    const result = adaptCodeBoundNativeSkillV1(corrupted);
    expect(result).toMatchObject({ ok: false, code: "unpinned_native_alias" });
  });

  it("rejects a payload clone whose alias is not in the closed NATIVE_SKILL_LEGACY_ALIASES_V1 table at all", () => {
    const base = NATIVE_PAYLOADS_V1.find((p) => p.id === "load-named-plugin");
    if (!base) throw new Error("test fixture: load-named-plugin payload missing from NATIVE_PAYLOADS_V1");
    const corrupted: NativeSkillPayloadV1 = { ...base, legacyAliases: ["not_a_real_alias"] };
    const result = adaptCodeBoundNativeSkillV1(corrupted);
    expect(result).toMatchObject({ ok: false, code: "unpinned_native_alias" });
  });

  // GUARD-REMOVAL PROOF (b) — schema-level validation. Temporarily making
  // `adaptCodeBoundNativeSkillV1` skip its `parseNativeSkillPayloadV1` call (e.g. treating
  // the raw payload as already-validated) makes this test fail; see the session report for
  // the observed RED output. Restored before landing.
  it("GUARD-REMOVAL PROOF (b): rejects a payload clone with a corrupted/invalid schemaVersion", () => {
    const base = NATIVE_PAYLOADS_V1.find((p) => p.id === "load-named-plugin");
    if (!base) throw new Error("test fixture: load-named-plugin payload missing from NATIVE_PAYLOADS_V1");
    const corrupted = { ...base, schemaVersion: 2 } as unknown as NativeSkillPayloadV1;
    const result = adaptCodeBoundNativeSkillV1(corrupted);
    expect(result).toMatchObject({ ok: false, code: "invalid_code_bound_payload_schema" });
  });

  it("rejects a payload clone with an id outside the closed NATIVE_SKILL_IDS_V1 universe", () => {
    const base = NATIVE_PAYLOADS_V1.find((p) => p.id === "session-control");
    if (!base) throw new Error("test fixture: session-control payload missing from NATIVE_PAYLOADS_V1");
    const corrupted = { ...base, id: "not-a-real-native-id" } as unknown as NativeSkillPayloadV1;
    const result = adaptCodeBoundNativeSkillV1(corrupted);
    // Caught at the schema gate (parseNativeSkillPayloadV1 also checks NATIVE_SKILL_IDS_V1
    // membership) before this adapter's own defense-in-depth id check ever runs — either way
    // the candidate is rejected, never silently admitted with an out-of-universe id.
    expect(result.ok).toBe(false);
  });

  it("rejects a payload clone whose handlerKey is not one of the four closed literal values", () => {
    const base = NATIVE_PAYLOADS_V1.find((p) => p.id === "session-control");
    if (!base) throw new Error("test fixture: session-control payload missing from NATIVE_PAYLOADS_V1");
    const corrupted = { ...base, handlerKey: "notARealHandlerV1" } as unknown as NativeSkillPayloadV1;
    const result = adaptCodeBoundNativeSkillV1(corrupted);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// adaptDeclarativeSkillV1 — pure mapping
// ---------------------------------------------------------------------------------------

function declarativeManifest(overrides: Partial<SkillManifestV1> = {}): SkillManifestV1 {
  return {
    schemaVersion: 1, id: "owner-set-volume", version: "1.0.0", title: "Set Volume",
    description: "Set the selected track's volume.", implementation: "declarative",
    intents: { positiveExamples: [], negativeExamples: [], tags: [] },
    slots: [],
    preconditions: [],
    steps: [{ kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 }],
    postconditions: [],
    execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 5000 },
    responses: { completed: "done", needsChoice: "which one?", blocked: "couldn't do that" },
    provenance: [],
    compatibility: { minMoshVersion: "0.0.0", commandCatalogSha256: "a".repeat(64), predicateCatalogVersion: 1, resolverCatalogVersion: 1 },
    ...overrides,
  };
}

function validatedDeclarative(m: SkillManifestV1): ValidatedDeclarativeSkillV1 {
  const h = "a".repeat(64);
  return { id: m.id, version: m.version, manifest: m, manifestSha256: h, certificationReportSha256: h, approvalSha256: h, releaseSha256: h };
}

describe("adaptDeclarativeSkillV1", () => {
  it("maps id/manifest and always emits origin owner with empty aliases", () => {
    const m = declarativeManifest();
    const result = adaptDeclarativeSkillV1(validatedDeclarative(m));
    expect(result).toEqual({ id: "owner-set-volume", origin: "owner", aliases: [], manifest: m });
  });

  it("closes over the exact validated manifest object (referential identity)", () => {
    const m = declarativeManifest({ id: "owner-other" });
    const validated = validatedDeclarative(m);
    const result = adaptDeclarativeSkillV1(validated);
    expect(result.manifest).toBe(validated.manifest);
  });
});
