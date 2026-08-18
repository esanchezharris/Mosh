// Task 9 — Assemble Active-Only Startup Loading and Quarantine.
//
// RED-first pin for `loadCertifiedOwnerSkillsV1`/`loadBundledNativeSkillsV1`
// (loadCertifiedSkills.ts) — the startup assembly point that wires Task 4's native reads,
// Task 3's hash-chain validators, and Task 5's adapters/collision checks together, selecting
// ONLY what the active index names and quarantining everything else without ever throwing.
//
// Every "valid" fixture is built by actually computing exact SHA-256 digests over actually-
// serialized JSON (never a hand-typed placeholder hash) — mirrors packageValidation.test.ts/
// adapters.test.ts's own fixture-building convention, kept local per that same convention.

import { describe, expect, it } from "vitest";
import { catalogFingerprintV1 } from "./catalogs";
import type {
  CatalogFingerprintV1,
  CertifiedNativeSkillLoadV1,
  CertifiedSkillFileV1,
  CertifiedSkillLoadV1,
  CertifiedSkillPackageBytesV1,
  NativeSkillPayloadV1,
  SkillCompatibilityContextV1,
} from "./contracts";
import { canonicalMoshBuildIdentityV1 } from "./nativeIdentity";
import { sha256Bytes, utf8Bytes } from "./hash";
import { loadBundledNativeSkillsV1, loadCertifiedOwnerSkillsV1 } from "./loadCertifiedSkills";

// ---------------------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------------------

async function toFile(name: string, value: unknown): Promise<CertifiedSkillFileV1> {
  const utf8 = JSON.stringify(value);
  const bytes = utf8Bytes(utf8);
  const sha256 = await sha256Bytes(bytes);
  return { name, bytes: bytes.length, sha256, utf8 };
}

function mutateUtf8(file: CertifiedSkillFileV1): CertifiedSkillFileV1 {
  return { ...file, utf8: file.utf8.slice(0, -1) + (file.utf8.endsWith("}") ? " }" : "!") };
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

function manifestObj(
  id: string,
  catalogFingerprint: CatalogFingerprintV1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1, id, version: "1.0.0", title: "Set track volume",
    description: "Sets the selected track's volume from a spoken dB value.", implementation: "declarative",
    intents: { positiveExamples: ["turn the drums up"], negativeExamples: ["mute the drums"], tags: ["mixer"] },
    slots: [{ name: "db", type: "number", required: true, source: "utterance", minimum: -60, maximum: 6, description: "target volume in dB" }],
    preconditions: [{ name: "not_recording", args: {} }],
    steps: [
      { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
      { kind: "mutate", command: "set_track_volume", args: { trackId: { binding: "track" }, db: { slot: "db" } } },
    ],
    postconditions: [{ name: "track_volume_equals", args: { trackId: { binding: "track" }, db: { slot: "db" } } }],
    execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 5000 },
    responses: { completed: "Done.", needsChoice: "Which track?", blocked: "Could not change the volume." },
    provenance: [],
    compatibility: {
      minMoshVersion: "1.0.0",
      commandCatalogSha256: catalogFingerprint.commandCatalogSha256,
      predicateCatalogVersion: catalogFingerprint.predicateCatalogVersion,
      resolverCatalogVersion: catalogFingerprint.resolverCatalogVersion,
    },
    ...overrides,
  };
}

async function buildOwnerPackage(
  context: SkillCompatibilityContextV1,
  id: string,
  manifestOverrides: Record<string, unknown> = {},
): Promise<{ manifest: Record<string, unknown>; input: CertifiedSkillPackageBytesV1; activeEntry: { version: string; manifestSha256: string; releaseSha256: string } }> {
  const manifest = manifestObj(id, context.catalogFingerprint, manifestOverrides);
  const skillFile = await toFile("skill.json", manifest);

  const report = {
    schemaVersion: 1, state: "acceptance_green",
    artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 },
    commandCatalogSha256: context.catalogFingerprint.commandCatalogSha256,
    predicateCatalogVersion: context.catalogFingerprint.predicateCatalogVersion,
    resolverCatalogVersion: context.catalogFingerprint.resolverCatalogVersion,
  };
  const certificationFile = await toFile("certification.json", report);

  const reviewSha256 = await sha256Bytes(utf8Bytes(`mosh-skill-review-v1\n${skillFile.sha256}\n${certificationFile.sha256}\n`));
  const approval = {
    schemaVersion: 1, state: "owner_approved",
    artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 },
    certificationReportSha256: certificationFile.sha256, reviewSha256,
  };
  const approvalFile = await toFile("approval.json", approval);

  const release = {
    schemaVersion: 1, state: "certified", skillId: manifest.id as string, version: manifest.version as string,
    manifestSha256: skillFile.sha256, certificationReportSha256: certificationFile.sha256, approvalSha256: approvalFile.sha256,
  };
  const releaseFile = await toFile("release.json", release);

  return {
    manifest,
    input: {
      directoryName: `${manifest.id}@${manifest.version}`,
      skillIdFromDirectory: manifest.id as string,
      versionFromDirectory: manifest.version as string,
      files: { skill: skillFile, certification: certificationFile, approval: approvalFile, release: releaseFile },
    },
    activeEntry: { version: manifest.version as string, manifestSha256: skillFile.sha256, releaseSha256: releaseFile.sha256 },
  };
}

async function buildActiveIndex(
  entries: Readonly<Record<string, { version: string; manifestSha256: string; releaseSha256: string }>>,
  generation = 1,
): Promise<CertifiedSkillFileV1> {
  return toFile("active.json", { schemaVersion: 1, generation, skills: entries });
}

function baseLoad(overrides: Partial<CertifiedSkillLoadV1> = {}): CertifiedSkillLoadV1 {
  return {
    schemaVersion: 1, ok: true, activeIndex: null, sourceStatusIndex: null, packages: [], diagnostics: [], totalBytes: 0,
    ...overrides,
  };
}

async function buildValidNativePackage(
  context: SkillCompatibilityContextV1,
  id: NativeSkillPayloadV1["id"],
  handlerKey: NativeSkillPayloadV1["handlerKey"],
  legacyAliases: readonly string[] = [],
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

  return {
    directoryName: `${id}@1.0.0`,
    skillIdFromDirectory: id,
    versionFromDirectory: "1.0.0",
    files: { payload: payloadFile, certification: certificationFile, approval: approvalFile, bundleEntry: bundleEntryFile },
  };
}

function baseNativeLoad(overrides: Partial<CertifiedNativeSkillLoadV1> = {}): CertifiedNativeSkillLoadV1 {
  return {
    schemaVersion: 1, ok: true,
    build: { appVersion: APP_VERSION, gitCommit: GIT_COMMIT, gitState: "clean", moshBuildIdentity: `git=${GIT_COMMIT}|version=${APP_VERSION}|target=Mosh|configuration=Release|architecture=arm64` },
    resourceIndex: null, packages: [], diagnostics: [], totalBytes: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// loadCertifiedOwnerSkillsV1
// ---------------------------------------------------------------------------------------

describe("loadCertifiedOwnerSkillsV1 — root/index absence", () => {
  it("returns nothing for an empty/missing root (ok:true, activeIndex:null)", async () => {
    const context = await buildContext();
    const result = await loadCertifiedOwnerSkillsV1({ readPackages: async () => baseLoad(), compatibility: context });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toEqual([]);
  });

  it("returns nothing for an invalid root (ok:false) and forwards native diagnostics", async () => {
    const context = await buildContext();
    const diag = [{ path: "$root", code: "unowned_root", message: "root is not owned by the current uid" }];
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ ok: false, diagnostics: diag }),
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.diagnostics).toEqual(diag);
  });

  it("never throws when readPackages itself rejects", async () => {
    const context = await buildContext();
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => { throw new Error("native bridge exploded"); },
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toEqual([]);
  });
});

describe("loadCertifiedOwnerSkillsV1 — active-only routing", () => {
  it("loads only the id named in the active index, ignoring an unreferenced but valid sibling id", async () => {
    const context = await buildContext();
    const a = await buildOwnerPackage(context, "owner-a");
    const b = await buildOwnerPackage(context, "owner-b");
    const activeIndex = await buildActiveIndex({ "owner-a": a.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [a.input, b.input] }),
      compatibility: context,
    });
    expect(result.accepted.map((x) => x.id)).toEqual(["owner-a"]);
    expect(result.quarantined).toEqual([]);
  });

  it("excludes an inactive OLDER version on disk when a newer version is active", async () => {
    const context = await buildContext();
    const older = await buildOwnerPackage(context, "owner-a", { version: "1.0.0" });
    const newer = await buildOwnerPackage(context, "owner-a", { version: "2.0.0" });
    const activeIndex = await buildActiveIndex({ "owner-a": newer.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [older.input, newer.input] }),
      compatibility: context,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].id).toBe("owner-a");
    expect((result.accepted[0].manifest as { version: string }).version).toBe("2.0.0");
  });

  it("quarantines an active version with NO on-disk match and never falls back to an older sibling", async () => {
    const context = await buildContext();
    const older = await buildOwnerPackage(context, "owner-a", { version: "1.0.0" });
    const activeIndex = await buildActiveIndex({ "owner-a": { version: "2.0.0", manifestSha256: "a".repeat(64), releaseSha256: "b".repeat(64) } });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [older.input] }),
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "owner-a", version: "2.0.0", code: "missing_package" }));
  });
});

describe("loadCertifiedOwnerSkillsV1 — quarantine independence", () => {
  it("quarantines one tampered sibling while its safe sibling still loads", async () => {
    const context = await buildContext();
    const safe = await buildOwnerPackage(context, "owner-safe");
    const tampered = await buildOwnerPackage(context, "owner-tampered");
    const tamperedInput: CertifiedSkillPackageBytesV1 = {
      ...tampered.input,
      files: { ...tampered.input.files, skill: mutateUtf8(tampered.input.files.skill) },
    };
    const activeIndex = await buildActiveIndex({ "owner-safe": safe.activeEntry, "owner-tampered": tampered.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [safe.input, tamperedInput] }),
      compatibility: context,
    });
    expect(result.accepted.map((x) => x.id)).toEqual(["owner-safe"]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "owner-tampered", code: "hash_mismatch" }));
  });

  it("quarantines a non-owner-prefixed active id", async () => {
    const context = await buildContext();
    const activeIndex = await buildActiveIndex({ "not-owner-x": { version: "1.0.0", manifestSha256: "a".repeat(64), releaseSha256: "b".repeat(64) } });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex }),
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "not-owner-x", code: "invalid_owner_prefix" }));
  });

  it("quarantines a package whose active-index hashes do not match its real (self-consistent, valid) bytes", async () => {
    const context = await buildContext();
    const pkg = await buildOwnerPackage(context, "owner-a");
    const activeIndex = await buildActiveIndex({ "owner-a": { ...pkg.activeEntry, manifestSha256: "9".repeat(64) } });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [pkg.input] }),
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "owner-a", code: "active_index_hash_mismatch" }));
  });

  it("quarantines a duplicated package identity (two on-disk packages claim the same active id@version)", async () => {
    const context = await buildContext();
    const pkg = await buildOwnerPackage(context, "owner-a");
    const activeIndex = await buildActiveIndex({ "owner-a": pkg.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [pkg.input, pkg.input] }),
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "owner-a", code: "duplicate_package" }));
  });

  it("quarantines a package whose source provenance is stale", async () => {
    const context = await buildContext();
    const pkg = await buildOwnerPackage(context, "owner-a", {
      provenance: [{ sourceCardId: "sc-1", claimIds: [], sourceSnapshotSha256: "a".repeat(64) }],
    });
    const activeIndex = await buildActiveIndex({ "owner-a": pkg.activeEntry });
    const sourceStatusIndex = await toFile("source-status.json", {
      schemaVersion: 1, generation: 3, updatedAt: "2026-08-14T00:00:00.000Z",
      entries: [{ sourceCardId: "sc-1", sourceSnapshotSha256: "a".repeat(64), state: "stale", checkedAt: "2026-08-01T00:00:00.000Z", reviewAfter: "2099-01-01T00:00:00.000Z" }],
    });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [pkg.input], sourceStatusIndex }),
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "owner-a", code: "stale" }));
    expect(result.sourceStatusGeneration).toBe(3);
  });
});

describe("loadCertifiedOwnerSkillsV1 — bounded entry count and byte budget", () => {
  it("processes exactly the 64-entry cap (proves the cap did not trip)", async () => {
    const context = await buildContext();
    const entries: Record<string, { version: string; manifestSha256: string; releaseSha256: string }> = {};
    for (let i = 0; i < 64; i++) entries[`owner-e${i}`] = { version: "1.0.0", manifestSha256: "a".repeat(64), releaseSha256: "b".repeat(64) };
    const activeIndex = await buildActiveIndex(entries);
    const result = await loadCertifiedOwnerSkillsV1({ readPackages: async () => baseLoad({ activeIndex }), compatibility: context });
    expect(result.quarantined).toHaveLength(64);
    expect(result.quarantined.every((q) => q.code === "missing_package")).toBe(true);
  });

  it("rejects the whole load at 65 entries — no per-entry processing occurs", async () => {
    const context = await buildContext();
    const entries: Record<string, { version: string; manifestSha256: string; releaseSha256: string }> = {};
    for (let i = 0; i < 65; i++) entries[`owner-e${i}`] = { version: "1.0.0", manifestSha256: "a".repeat(64), releaseSha256: "b".repeat(64) };
    const activeIndex = await buildActiveIndex(entries);
    const result = await loadCertifiedOwnerSkillsV1({ readPackages: async () => baseLoad({ activeIndex }), compatibility: context });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "too_many_entries" }));
  });

  it("rejects the whole load when totalBytes exceeds the startup byte budget", async () => {
    const context = await buildContext();
    const pkg = await buildOwnerPackage(context, "owner-a");
    const activeIndex = await buildActiveIndex({ "owner-a": pkg.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [pkg.input], totalBytes: 8388608 + 1 }),
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "oversized_load" }));
  });
});

describe("loadCertifiedOwnerSkillsV1 — identity-universe collisions publish zero replacement entries", () => {
  it("rejects the whole load when the active id collides with a native canonical id", async () => {
    const context = await buildContext();
    const pkg = await buildOwnerPackage(context, "owner-collide");
    const activeIndex = await buildActiveIndex({ "owner-collide": pkg.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [pkg.input] }),
      compatibility: context,
      nativeIdentityUniverse: [{ id: "owner-collide" }],
    });
    expect(result.accepted).toEqual([]);
  });

  it("rejects the whole load when the active id collides with a native legacy alias", async () => {
    const context = await buildContext();
    const pkg = await buildOwnerPackage(context, "owner-collide");
    const activeIndex = await buildActiveIndex({ "owner-collide": pkg.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [pkg.input] }),
      compatibility: context,
      nativeIdentityUniverse: [{ id: "load-named-plugin", aliases: ["owner-collide"] }],
    });
    expect(result.accepted).toEqual([]);
  });

  it("rejects the whole load when the active id collides with a bundled-declarative id", async () => {
    const context = await buildContext();
    const pkg = await buildOwnerPackage(context, "owner-collide");
    const activeIndex = await buildActiveIndex({ "owner-collide": pkg.activeEntry });
    const result = await loadCertifiedOwnerSkillsV1({
      readPackages: async () => baseLoad({ activeIndex, packages: [pkg.input] }),
      compatibility: context,
      declarativeIdentityUniverse: [{ id: "owner-collide" }],
    });
    expect(result.accepted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// loadBundledNativeSkillsV1
// ---------------------------------------------------------------------------------------

describe("loadBundledNativeSkillsV1", () => {
  it("registers zero skills when the resource index is absent", async () => {
    const context = await buildContext();
    const result = await loadBundledNativeSkillsV1({ readBundledNative: async () => baseNativeLoad(), compatibility: context });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toEqual([]);
  });

  it("registers zero skills when the resource index is present but malformed (unsorted)", async () => {
    const context = await buildContext();
    const resourceIndex = await toFile("index.json", {
      schemaVersion: 1,
      skills: [{ id: "session-control", version: "1.0.0" }, { id: "explicit-balance", version: "1.0.0" }],
    });
    const result = await loadBundledNativeSkillsV1({ readBundledNative: async () => baseNativeLoad({ resourceIndex }), compatibility: context });
    expect(result.accepted).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_resource_index" }));
  });

  it("accepts a valid sorted index with an exact four-file package that fully validates", async () => {
    const context = await buildContext();
    const pkg = await buildValidNativePackage(context, "session-control", "sessionControlV1");
    const resourceIndex = await toFile("index.json", { schemaVersion: 1, skills: [{ id: "session-control", version: "1.0.0" }] });
    const result = await loadBundledNativeSkillsV1({
      readBundledNative: async () => baseNativeLoad({ resourceIndex, packages: [pkg] }),
      compatibility: context,
    });
    expect(result.accepted.map((x) => x.id)).toEqual(["session-control"]);
    expect(result.quarantined).toEqual([]);
  });

  it("quarantines a package whose native-source hash does not match the running build", async () => {
    const context = await buildContext();
    const pkg = await buildValidNativePackage(context, "session-control", "sessionControlV1");
    const resourceIndex = await toFile("index.json", { schemaVersion: 1, skills: [{ id: "session-control", version: "1.0.0" }] });
    const driftedContext: SkillCompatibilityContextV1 = {
      ...context,
      nativeSourceSha256ByHandler: { ...context.nativeSourceSha256ByHandler, sessionControlV1: "9".repeat(64) },
    };
    const result = await loadBundledNativeSkillsV1({
      readBundledNative: async () => baseNativeLoad({ resourceIndex, packages: [pkg] }),
      compatibility: driftedContext,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "session-control", code: "native_source_mismatch" }));
  });

  it("quarantines a missing package named by the index (no fallback)", async () => {
    const context = await buildContext();
    const resourceIndex = await toFile("index.json", { schemaVersion: 1, skills: [{ id: "session-control", version: "1.0.0" }] });
    const result = await loadBundledNativeSkillsV1({ readBundledNative: async () => baseNativeLoad({ resourceIndex }), compatibility: context });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toContainEqual(expect.objectContaining({ id: "session-control", code: "missing_package" }));
  });

  it("never throws when readBundledNative itself rejects", async () => {
    const context = await buildContext();
    const result = await loadBundledNativeSkillsV1({
      readBundledNative: async () => { throw new Error("native bridge exploded"); },
      compatibility: context,
    });
    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toEqual([]);
  });
});
