// Task 3 — Validate Source and Release Hash Chains.
//
// SCOPE: this module owns exact-byte re-verification of the four/five files that make up
// one certified skill package (declarative: manifest/certification/approval/release; native:
// payload/certification/approval/bundle-entry[/external release verification]), the hash
// chain that binds them to each other, the deterministic review-fingerprint formula (spec
// 5.3), directory-identity agreement, compatibility-context agreement, and — for native
// artifacts only — the strict build-identity/git-state registration policy. It does NOT:
// perform native filesystem admission (Task 4's `CertifiedSkillLoader`), construct the
// runtime registry (Task 5's `registry.ts`), or select which package is "active" at startup
// (Task 9's `loadCertifiedSkills.ts` — this module validates ONE already-selected package;
// active-index selection is Task 9's job, using the `manifestSha256`/`releaseSha256`/
// `version` triple this module returns on success in `ValidatedDeclarativeSkillV1`).
//
// Every artifact byte re-verification goes through `hash.ts`'s `sha256Bytes`/`utf8Bytes` —
// artifact bytes are hashed EXACTLY, never canonicalized (see hash.ts's own header comment).
// `parseSkillManifestV1`/`parseNativeSkillPayloadV1`/`parseNativeSkillBundleEntryV1`/
// `parseNativeReleaseVerificationV1` (validate.ts, Task 2) are the sole grammar validators
// for those four schemas; this module does not redefine them. `CertificationReportV1`/
// `SkillApprovalV1`/`SkillReleaseV1` have no Task-2 grammar parser (out of that task's
// scope), so this module validates only the fields the hash chain, state machine, and
// compatibility checks actually consume — see the `*ShapeV1` helpers below.

import { sha256Bytes, utf8Bytes } from "./hash";
import { SKILL_LIMITS_V1 } from "./limits";
import {
  parseNativeReleaseVerificationV1,
  parseNativeSkillBundleEntryV1,
  parseNativeSkillPayloadV1,
  parseSkillManifestV1,
} from "./validate";
import type {
  CertifiedSkillFileV1,
  CertifiedSkillPackageBytesV1,
  NativeSkillPayloadV1,
  SkillCompatibilityContextV1,
  SkillManifestV1,
  SourceRefV1,
} from "./contracts";

// ---------------------------------------------------------------------------------------
// Shared result/failure shape
// ---------------------------------------------------------------------------------------

export type PackageValidationFailureCodeV1 =
  | "oversized"
  | "hash_mismatch"
  | "invalid_json"
  | "invalid_manifest"
  | "invalid_certification_report"
  | "invalid_approval"
  | "invalid_release"
  | "wrong_state"
  | "chain_mismatch"
  | "review_sha_mismatch"
  | "directory_mismatch"
  | "compatibility_mismatch"
  | "git_state_not_clean"
  | "invalid_commit"
  | "app_version_mismatch"
  | "build_identity_mismatch"
  | "native_source_mismatch"
  | "catalog_fingerprint_mismatch";

type FailureV1 = { readonly ok: false; readonly code: PackageValidationFailureCodeV1; readonly path: string; readonly message: string };

function failure(code: PackageValidationFailureCodeV1, path: string, message: string): FailureV1 {
  return { ok: false, code, path, message };
}

// DESIGN DECISION: `ValidatedDeclarativeSkillV1` is named in the plan's Cross-Slice APIs
// ("Produces: ... ValidatedDeclarativeSkillV1") but never given an exact shape. Modeled to
// carry exactly what Task 5's registry construction and Task 9's active-index selection need
// downstream: the parsed manifest plus the four exact-byte hashes that ARE the declarative
// chain (manifest/report/approval/release) — the same triple (id/version/manifestSha256/
// releaseSha256) an `active.json` entry binds, so a caller can construct that entry directly
// from this value without a second hash pass.
export type ValidatedDeclarativeSkillV1 = {
  readonly id: string;
  readonly version: string;
  readonly manifest: SkillManifestV1;
  readonly manifestSha256: string;
  readonly certificationReportSha256: string;
  readonly approvalSha256: string;
  readonly releaseSha256: string;
};

export type PackageValidationResultV1 = { readonly ok: true; readonly value: ValidatedDeclarativeSkillV1 } | FailureV1;

// DESIGN DECISION: `ValidatedNativeSkillV1` — the native analogue of `ValidatedDeclarativeSkillV1`,
// not given an exact shape either. Carries the parsed native payload plus the four exact-byte
// hashes that make up its chain (payload/report/approval/bundle-entry); Task 5's native
// adapter and Task 9's bundled-native loader consume this directly.
export type ValidatedNativeSkillV1 = {
  readonly id: NativeSkillPayloadV1["id"];
  readonly version: string;
  readonly payload: NativeSkillPayloadV1;
  readonly nativePayloadSha256: string;
  readonly certificationReportSha256: string;
  readonly approvalSha256: string;
  readonly bundleEntrySha256: string;
};

export type NativeArtifactGraphInputV1 = {
  readonly payload: CertifiedSkillFileV1;
  readonly certification: CertifiedSkillFileV1;
  readonly approval: CertifiedSkillFileV1;
  readonly bundleEntry: CertifiedSkillFileV1;
  readonly releaseVerification?: CertifiedSkillFileV1;
};

export type NativeArtifactGraphValidationResultV1 = { readonly ok: true; readonly value: ValidatedNativeSkillV1 } | FailureV1;

// ---------------------------------------------------------------------------------------
// Exact-byte file re-verification (shared by both chains)
// ---------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX64_REGEX = /^[0-9a-f]{64}$/;

type VerifiedFileV1 = { readonly ok: true; readonly parsed: unknown } | FailureV1;

/**
 * Re-encode `file.utf8`, enforce the byte cap BEFORE parsing, verify the claimed byte count
 * and SHA-256 against the freshly recomputed exact bytes (never canonicalized), then
 * `JSON.parse`. Order matches the plan's Task 3 Step 3 instruction exactly: cap, then hash,
 * then parse.
 */
async function verifyFileBytes(file: CertifiedSkillFileV1, capBytes: number, path: string): Promise<VerifiedFileV1> {
  const bytes = utf8Bytes(file.utf8);
  if (bytes.length > capBytes) {
    return failure("oversized", path, `${path} exceeds the ${capBytes}-byte cap`);
  }
  if (bytes.length !== file.bytes) {
    return failure("hash_mismatch", path, `${path} claimed byte count does not match its exact stored bytes`);
  }
  const sha256 = await sha256Bytes(bytes);
  if (sha256 !== file.sha256) {
    return failure("hash_mismatch", path, `${path} claimed sha256 does not match its exact stored bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.utf8);
  } catch {
    return failure("invalid_json", path, `${path} is not valid JSON`);
  }
  return { ok: true, parsed };
}

// ---------------------------------------------------------------------------------------
// SemVer precedence (used only for the minMoshVersion <= running-appVersion compatibility
// check — never a second hashing/canonicalization path)
// ---------------------------------------------------------------------------------------

function parseSemverCore(version: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return { major: 0, minor: 0, patch: 0, prerelease: [] };
  const [, major, minor, patch, prerelease] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease: prerelease ? prerelease.split(".") : [] };
}

/** Standard SemVer 2.0 precedence comparison: negative if `a` < `b`, positive if `a` > `b`. */
function compareSemverPrecedence(a: string, b: string): number {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  const length = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < length; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
      continue;
    }
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------
// Minimal shape checks for CertificationReportV1 / SkillApprovalV1 / SkillReleaseV1
//
// No Task-2 grammar parser exists for these three schemas (out of that task's scope — see
// this file's header comment). These helpers validate only the fields the chain/state/
// compatibility checks below actually read; they do not enforce unknown-field rejection or
// the full spec 8.1 shape (that belongs to whichever later slice needs it).
// ---------------------------------------------------------------------------------------

type ArtifactRefShapeV1 = { readonly kind: string; readonly sha256: string };

type CertificationReportShapeV1 = {
  readonly state: string;
  readonly artifact: ArtifactRefShapeV1;
  readonly commandCatalogSha256: string;
  readonly predicateCatalogVersion: number;
  readonly resolverCatalogVersion: number;
};

function parseCertificationReportShape(parsed: unknown, path: string): { ok: true; value: CertificationReportShapeV1 } | FailureV1 {
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    return failure("invalid_certification_report", path, `${path} must be a schemaVersion:1 JSON object`);
  }
  if (typeof parsed.state !== "string") {
    return failure("invalid_certification_report", path, `${path}.state must be a string`);
  }
  const artifact = parsed.artifact;
  if (!isRecord(artifact) || typeof artifact.kind !== "string" || typeof artifact.sha256 !== "string" || !HEX64_REGEX.test(artifact.sha256)) {
    return failure("invalid_certification_report", `${path}.artifact`, `${path}.artifact must be a typed hash reference`);
  }
  if (typeof parsed.commandCatalogSha256 !== "string" || !HEX64_REGEX.test(parsed.commandCatalogSha256)) {
    return failure("invalid_certification_report", `${path}.commandCatalogSha256`, `${path}.commandCatalogSha256 must be a 64-hex SHA-256`);
  }
  if (typeof parsed.predicateCatalogVersion !== "number" || !Number.isInteger(parsed.predicateCatalogVersion)) {
    return failure("invalid_certification_report", `${path}.predicateCatalogVersion`, `${path}.predicateCatalogVersion must be an integer`);
  }
  if (typeof parsed.resolverCatalogVersion !== "number" || !Number.isInteger(parsed.resolverCatalogVersion)) {
    return failure("invalid_certification_report", `${path}.resolverCatalogVersion`, `${path}.resolverCatalogVersion must be an integer`);
  }
  return {
    ok: true,
    value: {
      state: parsed.state,
      artifact: { kind: artifact.kind, sha256: artifact.sha256 },
      commandCatalogSha256: parsed.commandCatalogSha256,
      predicateCatalogVersion: parsed.predicateCatalogVersion,
      resolverCatalogVersion: parsed.resolverCatalogVersion,
    },
  };
}

type ApprovalShapeV1 = {
  readonly state: string;
  readonly artifact: ArtifactRefShapeV1;
  readonly certificationReportSha256: string;
  readonly reviewSha256: string;
};

function parseApprovalShape(parsed: unknown, path: string): { ok: true; value: ApprovalShapeV1 } | FailureV1 {
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    return failure("invalid_approval", path, `${path} must be a schemaVersion:1 JSON object`);
  }
  if (typeof parsed.state !== "string") {
    return failure("invalid_approval", path, `${path}.state must be a string`);
  }
  const artifact = parsed.artifact;
  if (!isRecord(artifact) || typeof artifact.kind !== "string" || typeof artifact.sha256 !== "string" || !HEX64_REGEX.test(artifact.sha256)) {
    return failure("invalid_approval", `${path}.artifact`, `${path}.artifact must be a typed hash reference`);
  }
  if (typeof parsed.certificationReportSha256 !== "string" || !HEX64_REGEX.test(parsed.certificationReportSha256)) {
    return failure("invalid_approval", `${path}.certificationReportSha256`, `${path}.certificationReportSha256 must be a 64-hex SHA-256`);
  }
  if (typeof parsed.reviewSha256 !== "string" || !HEX64_REGEX.test(parsed.reviewSha256)) {
    return failure("invalid_approval", `${path}.reviewSha256`, `${path}.reviewSha256 must be a 64-hex SHA-256`);
  }
  return {
    ok: true,
    value: {
      state: parsed.state,
      artifact: { kind: artifact.kind, sha256: artifact.sha256 },
      certificationReportSha256: parsed.certificationReportSha256,
      reviewSha256: parsed.reviewSha256,
    },
  };
}

type ReleaseShapeV1 = {
  readonly state: string;
  readonly skillId: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly certificationReportSha256: string;
  readonly approvalSha256: string;
};

function parseReleaseShape(parsed: unknown, path: string): { ok: true; value: ReleaseShapeV1 } | FailureV1 {
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    return failure("invalid_release", path, `${path} must be a schemaVersion:1 JSON object`);
  }
  if (typeof parsed.state !== "string") return failure("invalid_release", `${path}.state`, `${path}.state must be a string`);
  if (typeof parsed.skillId !== "string") return failure("invalid_release", `${path}.skillId`, `${path}.skillId must be a string`);
  if (typeof parsed.version !== "string") return failure("invalid_release", `${path}.version`, `${path}.version must be a string`);
  if (typeof parsed.manifestSha256 !== "string" || !HEX64_REGEX.test(parsed.manifestSha256)) {
    return failure("invalid_release", `${path}.manifestSha256`, `${path}.manifestSha256 must be a 64-hex SHA-256`);
  }
  if (typeof parsed.certificationReportSha256 !== "string" || !HEX64_REGEX.test(parsed.certificationReportSha256)) {
    return failure("invalid_release", `${path}.certificationReportSha256`, `${path}.certificationReportSha256 must be a 64-hex SHA-256`);
  }
  if (typeof parsed.approvalSha256 !== "string" || !HEX64_REGEX.test(parsed.approvalSha256)) {
    return failure("invalid_release", `${path}.approvalSha256`, `${path}.approvalSha256 must be a 64-hex SHA-256`);
  }
  return {
    ok: true,
    value: {
      state: parsed.state,
      skillId: parsed.skillId,
      version: parsed.version,
      manifestSha256: parsed.manifestSha256,
      certificationReportSha256: parsed.certificationReportSha256,
      approvalSha256: parsed.approvalSha256,
    },
  };
}

// ---------------------------------------------------------------------------------------
// validateCertifiedSkillPackageV1 — the declarative chain
// ---------------------------------------------------------------------------------------

export async function validateCertifiedSkillPackageV1(
  input: CertifiedSkillPackageBytesV1,
  context: SkillCompatibilityContextV1,
): Promise<PackageValidationResultV1> {
  const manifestFile = await verifyFileBytes(input.files.skill, SKILL_LIMITS_V1.manifestBytes, "files.skill");
  if (!manifestFile.ok) return manifestFile;
  const reportFile = await verifyFileBytes(input.files.certification, SKILL_LIMITS_V1.certificationBytes, "files.certification");
  if (!reportFile.ok) return reportFile;
  const approvalFile = await verifyFileBytes(input.files.approval, SKILL_LIMITS_V1.approvalBytes, "files.approval");
  if (!approvalFile.ok) return approvalFile;
  const releaseFile = await verifyFileBytes(input.files.release, SKILL_LIMITS_V1.releaseBytes, "files.release");
  if (!releaseFile.ok) return releaseFile;

  const manifestParsed = parseSkillManifestV1(manifestFile.parsed);
  if (!manifestParsed.ok) return failure("invalid_manifest", "files.skill", "manifest failed schema validation");
  const manifest = manifestParsed.value;

  const reportShape = parseCertificationReportShape(reportFile.parsed, "files.certification");
  if (!reportShape.ok) return reportShape;
  const report = reportShape.value;

  const approvalShape = parseApprovalShape(approvalFile.parsed, "files.approval");
  if (!approvalShape.ok) return approvalShape;
  const approval = approvalShape.value;

  const releaseShape = parseReleaseShape(releaseFile.parsed, "files.release");
  if (!releaseShape.ok) return releaseShape;
  const release = releaseShape.value;

  if (report.state !== "acceptance_green") {
    return failure("wrong_state", "files.certification.state", "certification report must be acceptance_green");
  }
  if (approval.state !== "owner_approved") {
    return failure("wrong_state", "files.approval.state", "approval must be owner_approved");
  }
  if (release.state !== "certified") {
    return failure("wrong_state", "files.release.state", "release must be certified");
  }

  if (report.artifact.kind !== "declarative_manifest" || report.artifact.sha256 !== input.files.skill.sha256) {
    return failure("chain_mismatch", "files.certification.artifact", "certification report does not bind the manifest bytes");
  }
  if (approval.artifact.kind !== "declarative_manifest" || approval.artifact.sha256 !== input.files.skill.sha256) {
    return failure("chain_mismatch", "files.approval.artifact", "approval does not bind the manifest bytes");
  }
  if (approval.certificationReportSha256 !== input.files.certification.sha256) {
    return failure("chain_mismatch", "files.approval.certificationReportSha256", "approval does not bind the certification report");
  }
  if (release.manifestSha256 !== input.files.skill.sha256) {
    return failure("chain_mismatch", "files.release.manifestSha256", "release does not bind the manifest");
  }
  if (release.certificationReportSha256 !== input.files.certification.sha256) {
    return failure("chain_mismatch", "files.release.certificationReportSha256", "release does not bind the certification report");
  }
  if (release.approvalSha256 !== input.files.approval.sha256) {
    return failure("chain_mismatch", "files.release.approvalSha256", "release does not bind the approval");
  }

  const expectedReviewSha256 = await sha256Bytes(
    utf8Bytes(`mosh-skill-review-v1\n${input.files.skill.sha256}\n${input.files.certification.sha256}\n`),
  );
  if (approval.reviewSha256 !== expectedReviewSha256) {
    return failure("review_sha_mismatch", "files.approval.reviewSha256", "reviewSha256 does not match the deterministic review fingerprint");
  }

  if (input.skillIdFromDirectory !== manifest.id || input.skillIdFromDirectory !== release.skillId) {
    return failure("directory_mismatch", "directoryName", "directory skill ID does not match the manifest/release");
  }
  if (input.versionFromDirectory !== manifest.version || input.versionFromDirectory !== release.version) {
    return failure("directory_mismatch", "directoryName", "directory version does not match the manifest/release");
  }

  if (
    manifest.compatibility.commandCatalogSha256 !== context.catalogFingerprint.commandCatalogSha256 ||
    manifest.compatibility.predicateCatalogVersion !== context.catalogFingerprint.predicateCatalogVersion ||
    manifest.compatibility.resolverCatalogVersion !== context.catalogFingerprint.resolverCatalogVersion
  ) {
    return failure("compatibility_mismatch", "files.skill.compatibility", "manifest catalog fingerprint does not match the running build");
  }
  if (
    report.commandCatalogSha256 !== context.catalogFingerprint.commandCatalogSha256 ||
    report.predicateCatalogVersion !== context.catalogFingerprint.predicateCatalogVersion ||
    report.resolverCatalogVersion !== context.catalogFingerprint.resolverCatalogVersion
  ) {
    return failure("compatibility_mismatch", "files.certification", "certification report catalog fingerprint does not match the running build");
  }
  if (compareSemverPrecedence(manifest.compatibility.minMoshVersion, context.appVersion) > 0) {
    return failure("compatibility_mismatch", "files.skill.compatibility.minMoshVersion", "manifest requires a newer Mosh version than the running build");
  }

  return {
    ok: true,
    value: {
      id: manifest.id,
      version: manifest.version,
      manifest,
      manifestSha256: input.files.skill.sha256,
      certificationReportSha256: input.files.certification.sha256,
      approvalSha256: input.files.approval.sha256,
      releaseSha256: input.files.release.sha256,
    },
  };
}

// ---------------------------------------------------------------------------------------
// validateNativeArtifactGraphV1 — the native chain: payload -> report/approval -> bundle
// entry -> (optional) external release verification, plus registration policy.
// ---------------------------------------------------------------------------------------

/** The one accepted native build-identity shape: a clean, known commit; any SemVer app
 *  version; and literally `target=Mosh|configuration=Release|architecture=arm64` — this
 *  codebase's only shipped native target (spec 8.1 / Task 3 Step 1). `gitState` is checked
 *  separately on `context.gitState` (it is deliberately not embedded in the identity string
 *  — see nativeIdentity.ts). */
const ACCEPTED_NATIVE_BUILD_IDENTITY_REGEX =
  /^git=([0-9a-f]{40})\|version=(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\|target=Mosh\|configuration=Release\|architecture=arm64$/;

const COMMIT_HEX_REGEX = /^[0-9a-f]{40}$/;

export async function validateNativeArtifactGraphV1(
  input: NativeArtifactGraphInputV1,
  context: SkillCompatibilityContextV1,
): Promise<NativeArtifactGraphValidationResultV1> {
  const payloadFile = await verifyFileBytes(input.payload, SKILL_LIMITS_V1.manifestBytes, "payload");
  if (!payloadFile.ok) return payloadFile;
  const reportFile = await verifyFileBytes(input.certification, SKILL_LIMITS_V1.certificationBytes, "certification");
  if (!reportFile.ok) return reportFile;
  const approvalFile = await verifyFileBytes(input.approval, SKILL_LIMITS_V1.approvalBytes, "approval");
  if (!approvalFile.ok) return approvalFile;
  const bundleEntryFile = await verifyFileBytes(input.bundleEntry, SKILL_LIMITS_V1.releaseBytes, "bundleEntry");
  if (!bundleEntryFile.ok) return bundleEntryFile;

  const payloadParsed = parseNativeSkillPayloadV1(payloadFile.parsed);
  if (!payloadParsed.ok) return failure("invalid_manifest", "payload", "native payload failed schema validation");
  const payload = payloadParsed.value;

  const reportShape = parseCertificationReportShape(reportFile.parsed, "certification");
  if (!reportShape.ok) return reportShape;
  const report = reportShape.value;

  const approvalShape = parseApprovalShape(approvalFile.parsed, "approval");
  if (!approvalShape.ok) return approvalShape;
  const approval = approvalShape.value;

  const bundleEntryParsed = parseNativeSkillBundleEntryV1(bundleEntryFile.parsed);
  if (!bundleEntryParsed.ok) return failure("invalid_release", "bundleEntry", "bundle entry failed schema validation");
  const bundleEntry = bundleEntryParsed.value;

  if (report.state !== "acceptance_green") {
    return failure("wrong_state", "certification.state", "certification report must be acceptance_green");
  }
  if (approval.state !== "owner_approved") {
    return failure("wrong_state", "approval.state", "approval must be owner_approved");
  }
  // `bundleEntry.state` is not re-checked here: `parseNativeSkillBundleEntryV1` (Task 2,
  // validate.ts) already enforces the literal `"owner_approved"` at the schema level, so a
  // wrong state surfaces as `invalid_release` above, before this point is ever reached.

  if (report.artifact.kind !== "native_payload" || report.artifact.sha256 !== input.payload.sha256) {
    return failure("chain_mismatch", "certification.artifact", "certification report does not bind the native payload");
  }
  if (approval.artifact.kind !== "native_payload" || approval.artifact.sha256 !== input.payload.sha256) {
    return failure("chain_mismatch", "approval.artifact", "approval does not bind the native payload");
  }
  if (approval.certificationReportSha256 !== input.certification.sha256) {
    return failure("chain_mismatch", "approval.certificationReportSha256", "approval does not bind the certification report");
  }
  const expectedNativeReviewSha256 = await sha256Bytes(
    utf8Bytes(`mosh-skill-review-v1\n${input.payload.sha256}\n${input.certification.sha256}\n`),
  );
  if (approval.reviewSha256 !== expectedNativeReviewSha256) {
    return failure("review_sha_mismatch", "approval.reviewSha256", "reviewSha256 does not match the deterministic review fingerprint");
  }
  if (bundleEntry.nativePayloadSha256 !== input.payload.sha256) {
    return failure("chain_mismatch", "bundleEntry.nativePayloadSha256", "bundle entry does not bind the native payload");
  }
  if (bundleEntry.certificationReportSha256 !== input.certification.sha256) {
    return failure("chain_mismatch", "bundleEntry.certificationReportSha256", "bundle entry does not bind the certification report");
  }
  if (bundleEntry.approvalSha256 !== input.approval.sha256) {
    return failure("chain_mismatch", "bundleEntry.approvalSha256", "bundle entry does not bind the approval");
  }
  if (bundleEntry.skillId !== payload.id) {
    return failure("chain_mismatch", "bundleEntry.skillId", "bundle entry skill ID does not match the native payload");
  }
  if (bundleEntry.version !== payload.version) {
    return failure("chain_mismatch", "bundleEntry.version", "bundle entry version does not match the native payload");
  }

  if (context.gitState !== "clean") {
    return failure("git_state_not_clean", "context.gitState", "native artifacts require a clean git state to register");
  }
  if (!COMMIT_HEX_REGEX.test(context.gitCommit)) {
    return failure("invalid_commit", "context.gitCommit", "context.gitCommit must be 40 lowercase hex characters");
  }
  const identityMatch = ACCEPTED_NATIVE_BUILD_IDENTITY_REGEX.exec(context.moshBuildIdentity);
  if (!identityMatch) {
    return failure(
      "build_identity_mismatch",
      "context.moshBuildIdentity",
      "moshBuildIdentity must be a clean Release arm64 Mosh build identity",
    );
  }
  const [, embeddedCommit, embeddedVersion] = identityMatch;
  if (embeddedCommit !== context.gitCommit) {
    return failure("build_identity_mismatch", "context.moshBuildIdentity", "moshBuildIdentity commit does not match context.gitCommit");
  }
  if (embeddedVersion !== context.appVersion) {
    return failure("app_version_mismatch", "context.moshBuildIdentity", "moshBuildIdentity version does not match context.appVersion");
  }
  if (bundleEntry.moshBuildIdentity !== context.moshBuildIdentity) {
    return failure("build_identity_mismatch", "bundleEntry.moshBuildIdentity", "bundle entry build identity does not match the running build");
  }

  if (
    payload.compatibility.commandCatalogSha256 !== context.catalogFingerprint.commandCatalogSha256 ||
    payload.compatibility.predicateCatalogVersion !== context.catalogFingerprint.predicateCatalogVersion ||
    payload.compatibility.resolverCatalogVersion !== context.catalogFingerprint.resolverCatalogVersion
  ) {
    return failure("catalog_fingerprint_mismatch", "payload.compatibility", "native payload catalog fingerprint does not match the running build");
  }
  if (
    report.commandCatalogSha256 !== context.catalogFingerprint.commandCatalogSha256 ||
    report.predicateCatalogVersion !== context.catalogFingerprint.predicateCatalogVersion ||
    report.resolverCatalogVersion !== context.catalogFingerprint.resolverCatalogVersion
  ) {
    return failure("catalog_fingerprint_mismatch", "certification", "certification report catalog fingerprint does not match the running build");
  }
  const expectedNativeSourceSha256 = context.nativeSourceSha256ByHandler[payload.handlerKey];
  if (payload.compatibility.nativeSourceSha256 !== expectedNativeSourceSha256) {
    return failure(
      "native_source_mismatch",
      "payload.compatibility.nativeSourceSha256",
      "native payload source-byte-set hash does not match the running build",
    );
  }
  if (compareSemverPrecedence(payload.compatibility.minMoshVersion, context.appVersion) > 0) {
    return failure("compatibility_mismatch", "payload.compatibility.minMoshVersion", "native payload requires a newer Mosh version than the running build");
  }

  if (input.releaseVerification) {
    const releaseVerificationFile = await verifyFileBytes(
      input.releaseVerification,
      SKILL_LIMITS_V1.nativeReleaseVerificationBytes,
      "releaseVerification",
    );
    if (!releaseVerificationFile.ok) return releaseVerificationFile;
    const releaseVerificationParsed = parseNativeReleaseVerificationV1(releaseVerificationFile.parsed);
    if (!releaseVerificationParsed.ok) {
      return failure("invalid_release", "releaseVerification", "release verification failed schema validation");
    }
    const releaseVerification = releaseVerificationParsed.value;
    // `releaseVerification.state` is not re-checked here for the same reason as
    // `bundleEntry.state` above: `parseNativeReleaseVerificationV1` already enforces the
    // literal `"release_packaged_green"`, so a wrong state is `invalid_release` above.
    if (releaseVerification.nativePayloadSha256 !== input.payload.sha256) {
      return failure("chain_mismatch", "releaseVerification.nativePayloadSha256", "release verification does not bind the native payload");
    }
    if (releaseVerification.certificationReportSha256 !== input.certification.sha256) {
      return failure("chain_mismatch", "releaseVerification.certificationReportSha256", "release verification does not bind the certification report");
    }
    if (releaseVerification.approvalSha256 !== input.approval.sha256) {
      return failure("chain_mismatch", "releaseVerification.approvalSha256", "release verification does not bind the approval");
    }
    if (releaseVerification.bundleEntrySha256 !== input.bundleEntry.sha256) {
      return failure("chain_mismatch", "releaseVerification.bundleEntrySha256", "release verification does not bind the bundle entry");
    }
    if (releaseVerification.moshBuildIdentity !== context.moshBuildIdentity) {
      return failure("build_identity_mismatch", "releaseVerification.moshBuildIdentity", "release verification build identity does not match the running build");
    }
  }

  return {
    ok: true,
    value: {
      id: payload.id,
      version: payload.version,
      payload,
      nativePayloadSha256: input.payload.sha256,
      certificationReportSha256: input.certification.sha256,
      approvalSha256: input.approval.sha256,
      bundleEntrySha256: input.bundleEntry.sha256,
    },
  };
}

// ---------------------------------------------------------------------------------------
// validateSourceStatusForInvocationV1 — frozen provenance vs. a freshly read source-status
// index, checked before every owner-local skill invocation (spec 6.2).
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: not given an exact shape. `freshIndex` is deliberately typed `unknown`
// rather than `SourceStatusV1` — this function is the runtime's fast, SYNCHRONOUS
// pre-invocation gate (spec 6.2: "checks its generation and bounds before every owner-local
// skill invocation"), so it must not assume its caller already ran this module's own async
// exact-byte verification on the index; it re-validates the parsed value's shape itself.
// `null`/`undefined` model "no index available" (native read failed, or none has been read
// yet this session) as a first-class input rather than forcing the caller to fabricate a
// placeholder `SourceStatusV1`.
export type SourceStatusCheckInputV1 = {
  readonly provenance: readonly SourceRefV1[];
  readonly freshIndex: unknown;
  readonly nowMs: number;
};

export type SourceStatusCheckFailureCodeV1 =
  | "missing_index"
  | "malformed_index"
  | "missing_entry"
  | "digest_mismatch"
  | "stale"
  | "superseded"
  | "revoked"
  | "expired";

export type SourceStatusCheckResultV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SourceStatusCheckFailureCodeV1; readonly sourceCardId: string | null; readonly message: string };

export function validateSourceStatusForInvocationV1(input: SourceStatusCheckInputV1): SourceStatusCheckResultV1 {
  if (input.provenance.length === 0) return { ok: true };

  const index = input.freshIndex;
  if (index === null || index === undefined) {
    return { ok: false, code: "missing_index", sourceCardId: null, message: "no source-status index is available" };
  }
  if (
    !isRecord(index) ||
    index.schemaVersion !== 1 ||
    !Array.isArray(index.entries) ||
    index.entries.length > SKILL_LIMITS_V1.sourceStatusEntries
  ) {
    return { ok: false, code: "malformed_index", sourceCardId: null, message: "source-status index failed structural validation" };
  }

  const bySourceCardId = new Map<string, { sourceSnapshotSha256: unknown; state: unknown; reviewAfter: unknown }>();
  for (const entry of index.entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.sourceCardId !== "string") continue;
    bySourceCardId.set(entry.sourceCardId, entry as { sourceSnapshotSha256: unknown; state: unknown; reviewAfter: unknown });
  }

  for (const ref of input.provenance) {
    const entry = bySourceCardId.get(ref.sourceCardId);
    if (!entry) {
      return { ok: false, code: "missing_entry", sourceCardId: ref.sourceCardId, message: `no source-status entry for ${ref.sourceCardId}` };
    }
    if (entry.sourceSnapshotSha256 !== ref.sourceSnapshotSha256) {
      return { ok: false, code: "digest_mismatch", sourceCardId: ref.sourceCardId, message: `source-status digest does not match provenance for ${ref.sourceCardId}` };
    }
    if (entry.state === "stale") {
      return { ok: false, code: "stale", sourceCardId: ref.sourceCardId, message: `source ${ref.sourceCardId} is stale` };
    }
    if (entry.state === "superseded") {
      return { ok: false, code: "superseded", sourceCardId: ref.sourceCardId, message: `source ${ref.sourceCardId} is superseded` };
    }
    if (entry.state === "revoked") {
      return { ok: false, code: "revoked", sourceCardId: ref.sourceCardId, message: `source ${ref.sourceCardId} is revoked` };
    }
    if (entry.state !== "current") {
      return { ok: false, code: "malformed_index", sourceCardId: ref.sourceCardId, message: `source ${ref.sourceCardId} has an unknown state` };
    }
    const reviewAfterMs = typeof entry.reviewAfter === "string" ? Date.parse(entry.reviewAfter) : Number.NaN;
    if (Number.isNaN(reviewAfterMs) || reviewAfterMs <= input.nowMs) {
      return { ok: false, code: "expired", sourceCardId: ref.sourceCardId, message: `source ${ref.sourceCardId} is expired` };
    }
  }

  return { ok: true };
}
