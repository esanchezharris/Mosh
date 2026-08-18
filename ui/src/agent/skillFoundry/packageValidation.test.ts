// Task 3 — Validate Source and Release Hash Chains.
//
// RED-first pin for the exact hash-chain, state, directory-identity, compatibility, and
// source-status validation Slice A's `packageValidation.ts` owns. Three functions under
// test:
//
// - `validateCertifiedSkillPackageV1` — the declarative chain: manifest -> certification
//   report -> approval -> release -> (implicitly) the active-index entry a caller would
//   publish from the returned `ValidatedDeclarativeSkillV1`.
// - `validateNativeArtifactGraphV1` — the native chain: payload -> report/approval ->
//   bundle entry -> (optional) external release verification, plus the build-identity/
//   git-state/catalog/native-source registration policy.
// - `validateSourceStatusForInvocationV1` — a frozen skill's provenance against a freshly
//   read source-status index.
//
// Every "valid" fixture below is built by actually computing exact SHA-256 digests over
// actually-serialized JSON via `hash.ts` (never a hand-typed placeholder hash), so a broken
// chain check would have nothing to hide behind: mutating exactly one field is guaranteed to
// break exactly one real hash relationship.

import { describe, expect, it } from "vitest";
import { catalogFingerprintV1 } from "./catalogs";
import type { CatalogFingerprintV1, CertifiedSkillFileV1, SkillCompatibilityContextV1 } from "./contracts";
import { canonicalMoshBuildIdentityV1 } from "./nativeIdentity";
import { sha256Bytes, utf8Bytes } from "./hash";
import {
  validateCertifiedSkillPackageV1,
  validateNativeArtifactGraphV1,
  validateSourceStatusForInvocationV1,
} from "./packageValidation";

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
  // Corrupt the stored bytes WITHOUT recomputing bytes/sha256 — this is what "tampered on
  // disk" looks like: the claimed hash/length no longer matches the actual content.
  return { ...file, utf8: file.utf8.slice(0, -1) + (file.utf8.endsWith("}") ? " }" : "!") };
}

const GIT_COMMIT = "b".repeat(40);
const APP_VERSION = "1.0.0";

async function buildContext(overrides: Partial<SkillCompatibilityContextV1> = {}): Promise<SkillCompatibilityContextV1> {
  const catalogFingerprint: CatalogFingerprintV1 = await catalogFingerprintV1();
  const identity = canonicalMoshBuildIdentityV1({
    gitCommit: GIT_COMMIT,
    appVersion: APP_VERSION,
    gitState: "clean",
    target: "Mosh",
    configuration: "Release",
    architecture: "arm64",
  });
  if (!identity.ok) throw new Error("test fixture: expected a valid build identity");
  return {
    appVersion: APP_VERSION,
    gitCommit: GIT_COMMIT,
    gitState: "clean",
    moshBuildIdentity: identity.value,
    catalogFingerprint,
    nativeSourceSha256ByHandler: {
      sessionControlV1: "c".repeat(64),
      takeCycleV1: "d".repeat(64),
      explicitBalanceV1: "e".repeat(64),
      loadNamedPluginV1: "f".repeat(64),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// validateCertifiedSkillPackageV1 fixture
// ---------------------------------------------------------------------------------------

function manifestObj(catalogFingerprint: CatalogFingerprintV1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "owner-set-volume",
    version: "1.0.0",
    title: "Set track volume",
    description: "Sets the selected track's volume from a spoken dB value.",
    implementation: "declarative",
    intents: { positiveExamples: ["turn the drums up"], negativeExamples: ["mute the drums"], tags: ["mixer"] },
    slots: [
      { name: "db", type: "number", required: true, source: "utterance", minimum: -60, maximum: 6, description: "target volume in dB" },
    ],
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

async function buildValidPackage(context: SkillCompatibilityContextV1) {
  const manifest = manifestObj(context.catalogFingerprint);
  const skillFile = await toFile("skill.json", manifest);

  const report = {
    schemaVersion: 1,
    state: "acceptance_green",
    artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 },
    commandCatalogSha256: context.catalogFingerprint.commandCatalogSha256,
    predicateCatalogVersion: context.catalogFingerprint.predicateCatalogVersion,
    resolverCatalogVersion: context.catalogFingerprint.resolverCatalogVersion,
  };
  const certificationFile = await toFile("certification.json", report);

  const reviewSha256 = await sha256Bytes(
    utf8Bytes(`mosh-skill-review-v1\n${skillFile.sha256}\n${certificationFile.sha256}\n`),
  );
  const approval = {
    schemaVersion: 1,
    state: "owner_approved",
    artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 },
    certificationReportSha256: certificationFile.sha256,
    reviewSha256,
  };
  const approvalFile = await toFile("approval.json", approval);

  const release = {
    schemaVersion: 1,
    state: "certified",
    skillId: manifest.id,
    version: manifest.version,
    manifestSha256: skillFile.sha256,
    certificationReportSha256: certificationFile.sha256,
    approvalSha256: approvalFile.sha256,
  };
  const releaseFile = await toFile("release.json", release);

  return {
    manifest,
    report,
    approval,
    release,
    skillFile,
    certificationFile,
    approvalFile,
    releaseFile,
    input: {
      directoryName: `${manifest.id}@${manifest.version}`,
      skillIdFromDirectory: manifest.id as string,
      versionFromDirectory: manifest.version as string,
      files: { skill: skillFile, certification: certificationFile, approval: approvalFile, release: releaseFile },
    },
  };
}

// ---------------------------------------------------------------------------------------
// validateCertifiedSkillPackageV1
// ---------------------------------------------------------------------------------------

describe("validateCertifiedSkillPackageV1 — valid chain", () => {
  it("accepts a fully chained, compatible package", async () => {
    const context = await buildContext();
    const { input, manifest } = await buildValidPackage(context);
    const result = await validateCertifiedSkillPackageV1(input, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(manifest.id);
      expect(result.value.version).toBe(manifest.version);
      expect(result.value.manifestSha256).toBe(input.files.skill.sha256);
      expect(result.value.releaseSha256).toBe(input.files.release.sha256);
    }
  });
});

describe("validateCertifiedSkillPackageV1 — tampered file bytes", () => {
  it("rejects a tampered manifest with hash_mismatch", async () => {
    const context = await buildContext();
    const { input } = await buildValidPackage(context);
    const tampered = { ...input, files: { ...input.files, skill: mutateUtf8(input.files.skill) } };
    const result = await validateCertifiedSkillPackageV1(tampered, context);
    expect(result).toMatchObject({ ok: false, code: "hash_mismatch" });
  });

  it("rejects a tampered certification report with hash_mismatch", async () => {
    const context = await buildContext();
    const { input } = await buildValidPackage(context);
    const tampered = { ...input, files: { ...input.files, certification: mutateUtf8(input.files.certification) } };
    const result = await validateCertifiedSkillPackageV1(tampered, context);
    expect(result).toMatchObject({ ok: false, code: "hash_mismatch" });
  });

  it("rejects a tampered approval with hash_mismatch", async () => {
    const context = await buildContext();
    const { input } = await buildValidPackage(context);
    const tampered = { ...input, files: { ...input.files, approval: mutateUtf8(input.files.approval) } };
    const result = await validateCertifiedSkillPackageV1(tampered, context);
    expect(result).toMatchObject({ ok: false, code: "hash_mismatch" });
  });

  it("rejects a tampered release with hash_mismatch", async () => {
    const context = await buildContext();
    const { input } = await buildValidPackage(context);
    const tampered = { ...input, files: { ...input.files, release: mutateUtf8(input.files.release) } };
    const result = await validateCertifiedSkillPackageV1(tampered, context);
    expect(result).toMatchObject({ ok: false, code: "hash_mismatch" });
  });
});

describe("validateCertifiedSkillPackageV1 — confirmation change breaks the chain", () => {
  it("changing execution.confirmation changes the manifest hash and invalidates the prior chain", async () => {
    const context = await buildContext();
    const { input, manifest, skillFile } = await buildValidPackage(context);

    const rebuiltManifest = { ...manifest, execution: { ...(manifest.execution as Record<string, unknown>), confirmation: "always" } };
    const rebuiltSkillFile = await toFile("skill.json", rebuiltManifest);

    // The artifact/review hash genuinely changes — this is the load-bearing assertion.
    expect(rebuiltSkillFile.sha256).not.toBe(skillFile.sha256);

    // The prior report/approval/release are now bound to a manifest hash that no longer
    // exists in this package: the chain is broken.
    const brokenInput = { ...input, files: { ...input.files, skill: rebuiltSkillFile } };
    const result = await validateCertifiedSkillPackageV1(brokenInput, context);
    expect(result).toMatchObject({ ok: false, code: "chain_mismatch" });
  });
});

describe("validateCertifiedSkillPackageV1 — wrong state", () => {
  it("rejects a certification report that is not acceptance_green", async () => {
    const context = await buildContext();
    const { manifest, report } = await buildValidPackage(context);
    const skillFile = await toFile("skill.json", manifest);
    const badReport = { ...report, artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 }, state: "mock_green" };
    const badReportFile = await toFile("certification.json", badReport);
    const reviewSha256 = await sha256Bytes(utf8Bytes(`mosh-skill-review-v1\n${skillFile.sha256}\n${badReportFile.sha256}\n`));
    const approval = {
      schemaVersion: 1, state: "owner_approved",
      artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 },
      certificationReportSha256: badReportFile.sha256, reviewSha256,
    };
    const approvalFile = await toFile("approval.json", approval);
    const release = {
      schemaVersion: 1, state: "certified", skillId: manifest.id, version: manifest.version,
      manifestSha256: skillFile.sha256, certificationReportSha256: badReportFile.sha256, approvalSha256: approvalFile.sha256,
    };
    const releaseFile = await toFile("release.json", release);
    const input = {
      directoryName: `${manifest.id}@${manifest.version}`,
      skillIdFromDirectory: manifest.id as string, versionFromDirectory: manifest.version as string,
      files: { skill: skillFile, certification: badReportFile, approval: approvalFile, release: releaseFile },
    };
    const result = await validateCertifiedSkillPackageV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "wrong_state" });
  });

  it("rejects an approval that is not owner_approved", async () => {
    const context = await buildContext();
    const { input, approval, skillFile, certificationFile, release: releaseTemplate } = await buildValidPackage(context);
    const badApproval = { ...approval, state: "draft" };
    const badApprovalFile = await toFile("approval.json", badApproval);
    const release = { ...releaseTemplate, approvalSha256: badApprovalFile.sha256 };
    const releaseFile = await toFile("release.json", release);
    const badInput = {
      ...input,
      files: { skill: skillFile, certification: certificationFile, approval: badApprovalFile, release: releaseFile },
    };
    const result = await validateCertifiedSkillPackageV1(badInput, context);
    expect(result).toMatchObject({ ok: false, code: "wrong_state" });
  });

  it("rejects a release that is not certified", async () => {
    const context = await buildContext();
    const { input, release } = await buildValidPackage(context);
    const badRelease = { ...release, state: "draft" };
    const badReleaseFile = await toFile("release.json", badRelease);
    const badInput = { ...input, files: { ...input.files, release: badReleaseFile } };
    const result = await validateCertifiedSkillPackageV1(badInput, context);
    expect(result).toMatchObject({ ok: false, code: "wrong_state" });
  });
});

describe("validateCertifiedSkillPackageV1 — wrong review SHA", () => {
  it("rejects an approval whose reviewSha256 does not match the deterministic fingerprint", async () => {
    const context = await buildContext();
    const { input, approval, skillFile, certificationFile, release } = await buildValidPackage(context);
    const badApproval = { ...approval, reviewSha256: "0".repeat(64) };
    const badApprovalFile = await toFile("approval.json", badApproval);
    const rebuiltRelease = { ...release, approvalSha256: badApprovalFile.sha256 };
    const rebuiltReleaseFile = await toFile("release.json", rebuiltRelease);
    const badInput = {
      ...input,
      files: { skill: skillFile, certification: certificationFile, approval: badApprovalFile, release: rebuiltReleaseFile },
    };
    const result = await validateCertifiedSkillPackageV1(badInput, context);
    expect(result).toMatchObject({ ok: false, code: "review_sha_mismatch" });
  });
});

describe("validateCertifiedSkillPackageV1 — directory ID/version mismatch", () => {
  it("rejects a directory whose skill ID does not match the manifest", async () => {
    const context = await buildContext();
    const { input } = await buildValidPackage(context);
    const badInput = { ...input, skillIdFromDirectory: "owner-different" };
    const result = await validateCertifiedSkillPackageV1(badInput, context);
    expect(result).toMatchObject({ ok: false, code: "directory_mismatch" });
  });

  it("rejects a directory whose version does not match the manifest", async () => {
    const context = await buildContext();
    const { input } = await buildValidPackage(context);
    const badInput = { ...input, versionFromDirectory: "9.9.9" };
    const result = await validateCertifiedSkillPackageV1(badInput, context);
    expect(result).toMatchObject({ ok: false, code: "directory_mismatch" });
  });
});

describe("validateCertifiedSkillPackageV1 — compatibility mismatches", () => {
  it("rejects a manifest whose predicateCatalogVersion does not match the running build", async () => {
    const context = await buildContext();
    const catalogFingerprint = await catalogFingerprintV1();
    const manifest = manifestObj(catalogFingerprint, {
      compatibility: {
        minMoshVersion: "1.0.0",
        commandCatalogSha256: catalogFingerprint.commandCatalogSha256,
        predicateCatalogVersion: catalogFingerprint.predicateCatalogVersion + 1,
        resolverCatalogVersion: catalogFingerprint.resolverCatalogVersion,
      },
    });
    const skillFile = await toFile("skill.json", manifest);
    const report = {
      schemaVersion: 1, state: "acceptance_green",
      artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 },
      commandCatalogSha256: catalogFingerprint.commandCatalogSha256,
      predicateCatalogVersion: catalogFingerprint.predicateCatalogVersion,
      resolverCatalogVersion: catalogFingerprint.resolverCatalogVersion,
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
      schemaVersion: 1, state: "certified", skillId: manifest.id, version: manifest.version,
      manifestSha256: skillFile.sha256, certificationReportSha256: certificationFile.sha256, approvalSha256: approvalFile.sha256,
    };
    const releaseFile = await toFile("release.json", release);
    const input = {
      directoryName: `${manifest.id}@${manifest.version}`,
      skillIdFromDirectory: manifest.id as string, versionFromDirectory: manifest.version as string,
      files: { skill: skillFile, certification: certificationFile, approval: approvalFile, release: releaseFile },
    };
    const result = await validateCertifiedSkillPackageV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "compatibility_mismatch" });
  });

  it("rejects a manifest requiring a newer Mosh version than the running build", async () => {
    const context = await buildContext({ appVersion: "1.0.0" });
    const catalogFingerprint = context.catalogFingerprint;
    const manifest = manifestObj(catalogFingerprint, {
      compatibility: {
        minMoshVersion: "2.0.0",
        commandCatalogSha256: catalogFingerprint.commandCatalogSha256,
        predicateCatalogVersion: catalogFingerprint.predicateCatalogVersion,
        resolverCatalogVersion: catalogFingerprint.resolverCatalogVersion,
      },
    });
    const skillFile = await toFile("skill.json", manifest);
    const report = {
      schemaVersion: 1, state: "acceptance_green",
      artifact: { kind: "declarative_manifest", sha256: skillFile.sha256 },
      commandCatalogSha256: catalogFingerprint.commandCatalogSha256,
      predicateCatalogVersion: catalogFingerprint.predicateCatalogVersion,
      resolverCatalogVersion: catalogFingerprint.resolverCatalogVersion,
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
      schemaVersion: 1, state: "certified", skillId: manifest.id, version: manifest.version,
      manifestSha256: skillFile.sha256, certificationReportSha256: certificationFile.sha256, approvalSha256: approvalFile.sha256,
    };
    const releaseFile = await toFile("release.json", release);
    const input = {
      directoryName: `${manifest.id}@${manifest.version}`,
      skillIdFromDirectory: manifest.id as string, versionFromDirectory: manifest.version as string,
      files: { skill: skillFile, certification: certificationFile, approval: approvalFile, release: releaseFile },
    };
    const result = await validateCertifiedSkillPackageV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "compatibility_mismatch" });
  });
});

describe("validateCertifiedSkillPackageV1 — oversized files", () => {
  it("rejects a manifest file over the manifestBytes cap", async () => {
    const context = await buildContext();
    const { input } = await buildValidPackage(context);
    const oversizedUtf8 = JSON.stringify({ padding: "x".repeat(70000) });
    const oversized = { name: "skill.json", bytes: utf8Bytes(oversizedUtf8).length, sha256: await sha256Bytes(utf8Bytes(oversizedUtf8)), utf8: oversizedUtf8 };
    const badInput = { ...input, files: { ...input.files, skill: oversized } };
    const result = await validateCertifiedSkillPackageV1(badInput, context);
    expect(result).toMatchObject({ ok: false, code: "oversized" });
  });
});

// ---------------------------------------------------------------------------------------
// validateNativeArtifactGraphV1 fixture
// ---------------------------------------------------------------------------------------

async function buildValidNativePackage(context: SkillCompatibilityContextV1) {
  const payload = {
    schemaVersion: 1,
    id: "session-control",
    version: "1.0.0",
    implementation: "native",
    handlerKey: "sessionControlV1",
    title: "Session control",
    description: "Play, stop, save, undo, and redo.",
    intents: { positiveExamples: ["play the track"], negativeExamples: ["mute the drums"], tags: ["transport"] },
    slots: [],
    execution: { mode: "atomic", confirmation: "never" },
    responses: { completed: "Done.", needsChoice: "Which one?", blocked: "Could not do that." },
    provenance: [],
    legacyAliases: [],
    compatibility: {
      minMoshVersion: "1.0.0",
      commandCatalogSha256: context.catalogFingerprint.commandCatalogSha256,
      predicateCatalogVersion: context.catalogFingerprint.predicateCatalogVersion,
      resolverCatalogVersion: context.catalogFingerprint.resolverCatalogVersion,
      nativeSourceSha256: context.nativeSourceSha256ByHandler.sessionControlV1,
    },
  };
  const payloadFile = await toFile("payload.json", payload);

  const report = {
    schemaVersion: 1,
    state: "acceptance_green",
    artifact: { kind: "native_payload", sha256: payloadFile.sha256 },
    commandCatalogSha256: context.catalogFingerprint.commandCatalogSha256,
    predicateCatalogVersion: context.catalogFingerprint.predicateCatalogVersion,
    resolverCatalogVersion: context.catalogFingerprint.resolverCatalogVersion,
  };
  const certificationFile = await toFile("certification.json", report);

  const nativeReviewSha256 = await sha256Bytes(
    utf8Bytes(`mosh-skill-review-v1\n${payloadFile.sha256}\n${certificationFile.sha256}\n`),
  );
  const approval = {
    schemaVersion: 1,
    state: "owner_approved",
    artifact: { kind: "native_payload", sha256: payloadFile.sha256 },
    certificationReportSha256: certificationFile.sha256,
    reviewSha256: nativeReviewSha256,
  };
  const approvalFile = await toFile("approval.json", approval);

  const bundleEntry = {
    schemaVersion: 1,
    state: "owner_approved",
    skillId: payload.id,
    version: payload.version,
    nativePayloadSha256: payloadFile.sha256,
    certificationReportSha256: certificationFile.sha256,
    approvalSha256: approvalFile.sha256,
    moshBuildIdentity: context.moshBuildIdentity,
    bundledAt: "2026-08-14T00:00:00.000Z",
  };
  const bundleEntryFile = await toFile("bundleEntry.json", bundleEntry);

  const releaseVerification = {
    schemaVersion: 1,
    state: "release_packaged_green",
    nativePayloadSha256: payloadFile.sha256,
    certificationReportSha256: certificationFile.sha256,
    approvalSha256: approvalFile.sha256,
    bundleEntrySha256: bundleEntryFile.sha256,
    moshBuildIdentity: context.moshBuildIdentity,
    bundleSha256: "1".repeat(64),
    codeSignatureCDHash: "deadbeef",
    checks: [{ name: "native_selftest", status: "passed", artifactHashes: ["2".repeat(64)] }],
    verifiedAt: "2026-08-14T00:00:00.000Z",
  };
  const releaseVerificationFile = await toFile("releaseVerification.json", releaseVerification);

  return {
    payload,
    report,
    approval,
    bundleEntry,
    releaseVerification,
    payloadFile,
    certificationFile,
    approvalFile,
    bundleEntryFile,
    releaseVerificationFile,
    input: { payload: payloadFile, certification: certificationFile, approval: approvalFile, bundleEntry: bundleEntryFile },
  };
}

// ---------------------------------------------------------------------------------------
// validateNativeArtifactGraphV1
// ---------------------------------------------------------------------------------------

describe("validateNativeArtifactGraphV1 — valid chain", () => {
  it("accepts a fully chained payload/report/approval/bundle entry", async () => {
    const context = await buildContext();
    const { input, payload } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(payload.id);
      expect(result.value.version).toBe(payload.version);
    }
  });

  it("accepts a valid chain with a bound external release verification", async () => {
    const context = await buildContext();
    const { input, releaseVerificationFile } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1({ ...input, releaseVerification: releaseVerificationFile }, context);
    expect(result.ok).toBe(true);
  });
});

describe("validateNativeArtifactGraphV1 — downstream hash rejection", () => {
  it("rejects a bundle entry with a swapped approval/report hash reference", async () => {
    const context = await buildContext();
    const { input, bundleEntry } = await buildValidNativePackage(context);
    const swapped = { ...bundleEntry, certificationReportSha256: bundleEntry.approvalSha256, approvalSha256: bundleEntry.certificationReportSha256 };
    const swappedFile = await toFile("bundleEntry.json", swapped);
    const result = await validateNativeArtifactGraphV1({ ...input, bundleEntry: swappedFile }, context);
    expect(result).toMatchObject({ ok: false, code: "chain_mismatch" });
  });

  it("rejects a release verification bound to the wrong bundle entry hash", async () => {
    const context = await buildContext();
    const { input, releaseVerification } = await buildValidNativePackage(context);
    const badReleaseVerification = { ...releaseVerification, bundleEntrySha256: "0".repeat(64) };
    const badFile = await toFile("releaseVerification.json", badReleaseVerification);
    const result = await validateNativeArtifactGraphV1({ ...input, releaseVerification: badFile }, context);
    expect(result).toMatchObject({ ok: false, code: "chain_mismatch" });
  });

  it("rejects a release verification that is not release_packaged_green", async () => {
    // `parseNativeReleaseVerificationV1` (Task 2) already enforces the literal state at the
    // schema level, so this surfaces as a schema failure rather than a separate state check.
    const context = await buildContext();
    const { input, releaseVerification } = await buildValidNativePackage(context);
    const badReleaseVerification = { ...releaseVerification, state: "draft" };
    const badFile = await toFile("releaseVerification.json", badReleaseVerification);
    const result = await validateNativeArtifactGraphV1({ ...input, releaseVerification: badFile }, context);
    expect(result).toMatchObject({ ok: false, code: "invalid_release" });
  });
});

describe("validateNativeArtifactGraphV1 — catalog and native-source drift", () => {
  it("rejects a catalog-fingerprint mismatch", async () => {
    const context = await buildContext();
    const { input } = await buildValidNativePackage(context);
    const driftedContext = { ...context, catalogFingerprint: { ...context.catalogFingerprint, predicateCatalogVersion: context.catalogFingerprint.predicateCatalogVersion + 1 } };
    const result = await validateNativeArtifactGraphV1(input, driftedContext);
    expect(result).toMatchObject({ ok: false, code: "catalog_fingerprint_mismatch" });
  });

  it("rejects a native-source-byte-set mismatch for the payload's handler", async () => {
    const context = await buildContext();
    const { input } = await buildValidNativePackage(context);
    const driftedContext = {
      ...context,
      nativeSourceSha256ByHandler: { ...context.nativeSourceSha256ByHandler, sessionControlV1: "9".repeat(64) },
    };
    const result = await validateNativeArtifactGraphV1(input, driftedContext);
    expect(result).toMatchObject({ ok: false, code: "native_source_mismatch" });
  });
});

describe("validateNativeArtifactGraphV1 — build identity and git-state gating", () => {
  it("rejects a dirty git state", async () => {
    const context = await buildContext({ gitState: "dirty" });
    const { input } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "git_state_not_clean" });
  });

  it("rejects an unknown git state", async () => {
    const context = await buildContext({ gitState: "unknown" });
    const { input } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "git_state_not_clean" });
  });

  it("rejects a non-40-hex commit", async () => {
    const context = await buildContext({ gitCommit: "not-a-real-commit" });
    const { input } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "invalid_commit" });
  });

  it("rejects a Debug configuration build identity", async () => {
    const debugIdentity = canonicalMoshBuildIdentityV1({
      gitCommit: GIT_COMMIT, appVersion: APP_VERSION, gitState: "clean",
      target: "Mosh", configuration: "Debug", architecture: "arm64",
    });
    if (!debugIdentity.ok) throw new Error("expected a valid debug identity");
    const context = await buildContext({ moshBuildIdentity: debugIdentity.value });
    const { input } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "build_identity_mismatch" });
  });

  it("rejects a non-arm64 architecture build identity", async () => {
    const x64Identity = canonicalMoshBuildIdentityV1({
      gitCommit: GIT_COMMIT, appVersion: APP_VERSION, gitState: "clean",
      target: "Mosh", configuration: "Release", architecture: "x86_64",
    });
    if (!x64Identity.ok) throw new Error("expected a valid x86_64 identity");
    const context = await buildContext({ moshBuildIdentity: x64Identity.value });
    const { input } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "build_identity_mismatch" });
  });

  it("rejects a moshBuildIdentity whose embedded commit disagrees with context.gitCommit", async () => {
    const otherCommitIdentity = canonicalMoshBuildIdentityV1({
      gitCommit: "c".repeat(40), appVersion: APP_VERSION, gitState: "clean",
      target: "Mosh", configuration: "Release", architecture: "arm64",
    });
    if (!otherCommitIdentity.ok) throw new Error("expected a valid identity");
    const context = await buildContext({ gitCommit: GIT_COMMIT, moshBuildIdentity: otherCommitIdentity.value });
    const { input } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "build_identity_mismatch" });
  });

  it("rejects a moshBuildIdentity whose embedded version disagrees with context.appVersion", async () => {
    const otherVersionIdentity = canonicalMoshBuildIdentityV1({
      gitCommit: GIT_COMMIT, appVersion: "9.9.9", gitState: "clean",
      target: "Mosh", configuration: "Release", architecture: "arm64",
    });
    if (!otherVersionIdentity.ok) throw new Error("expected a valid identity");
    const context = await buildContext({ appVersion: APP_VERSION, moshBuildIdentity: otherVersionIdentity.value });
    const { input } = await buildValidNativePackage(context);
    const result = await validateNativeArtifactGraphV1(input, context);
    expect(result).toMatchObject({ ok: false, code: "app_version_mismatch" });
  });

  it("rejects a bundle entry whose moshBuildIdentity does not match the running build", async () => {
    const context = await buildContext();
    const { input, bundleEntry } = await buildValidNativePackage(context);
    const badBundleEntry = { ...bundleEntry, moshBuildIdentity: `git=${"9".repeat(40)}|version=9.9.9|target=Mosh|configuration=Release|architecture=arm64` };
    const badFile = await toFile("bundleEntry.json", badBundleEntry);
    const result = await validateNativeArtifactGraphV1({ ...input, bundleEntry: badFile }, context);
    expect(result).toMatchObject({ ok: false, code: "build_identity_mismatch" });
  });
});

// ---------------------------------------------------------------------------------------
// validateSourceStatusForInvocationV1
// ---------------------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-08-14T00:00:00.000Z");

function sourceRef(overrides: Record<string, unknown> = {}) {
  return { sourceCardId: "card-1", claimIds: ["claim-1"], sourceSnapshotSha256: "a".repeat(64), ...overrides };
}

function freshIndex(entryOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generation: 1,
    updatedAt: "2026-08-01T00:00:00.000Z",
    entries: [
      {
        sourceCardId: "card-1",
        sourceSnapshotSha256: "a".repeat(64),
        state: "current",
        checkedAt: "2026-08-01T00:00:00.000Z",
        reviewAfter: "2026-09-01T00:00:00.000Z",
        ...entryOverrides,
      },
    ],
  };
}

describe("validateSourceStatusForInvocationV1", () => {
  it("accepts empty provenance regardless of the index", () => {
    const result = validateSourceStatusForInvocationV1({ provenance: [], freshIndex: null, nowMs: NOW_MS });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a current, unexpired, digest-matching source", () => {
    const result = validateSourceStatusForInvocationV1({ provenance: [sourceRef()], freshIndex: freshIndex(), nowMs: NOW_MS });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a missing index", () => {
    const result = validateSourceStatusForInvocationV1({ provenance: [sourceRef()], freshIndex: null, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, code: "missing_index" });
  });

  it("rejects a malformed index (not an object)", () => {
    const result = validateSourceStatusForInvocationV1({ provenance: [sourceRef()], freshIndex: "not an index", nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, code: "malformed_index" });
  });

  it("rejects a malformed index (entries not an array)", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [sourceRef()],
      freshIndex: { schemaVersion: 1, generation: 1, updatedAt: "x", entries: "nope" },
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: "malformed_index" });
  });

  it("rejects a missing entry for the referenced source card", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [sourceRef({ sourceCardId: "card-missing" })],
      freshIndex: freshIndex(),
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: "missing_entry", sourceCardId: "card-missing" });
  });

  it("rejects a digest mismatch", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [sourceRef({ sourceSnapshotSha256: "b".repeat(64) })],
      freshIndex: freshIndex(),
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: "digest_mismatch" });
  });

  it("rejects a stale source", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [sourceRef()],
      freshIndex: freshIndex({ state: "stale" }),
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: "stale" });
  });

  it("rejects a superseded source", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [sourceRef()],
      freshIndex: freshIndex({ state: "superseded" }),
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: "superseded" });
  });

  it("rejects a revoked source", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [sourceRef()],
      freshIndex: freshIndex({ state: "revoked" }),
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: "revoked" });
  });

  it("rejects an expired source", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [sourceRef()],
      freshIndex: freshIndex({ reviewAfter: "2026-01-01T00:00:00.000Z" }),
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: "expired" });
  });
});
