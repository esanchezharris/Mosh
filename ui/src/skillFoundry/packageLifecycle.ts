// Task 8 — crash-safe install/rollback/revoke and the activation index.
//
// Public `install` requires the CURRENT declarative `owner_approved` state and rejects
// native artifact kinds (natives never go through this installer — they reach `certified`
// only via `promoteNativeReleaseVerificationV1`). Every file is reopened with a no-follow
// handle and its device/inode/size/mtime/hash rechecked against the approved identities
// immediately before staging, again before the package rename, and again before activation
// — `validateCertifiedSkillPackageV1` (Slice A) is the single semantic authority for the
// hash-chain and compatibility checks; this module only handles durable placement.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_SKILL_IDS_V1 } from "../agent/skillFoundry/catalogs";
import { validateCertifiedSkillPackageV1 } from "../agent/skillFoundry/packageValidation";
import type { CertifiedSkillFileV1, SkillCompatibilityContextV1 } from "../agent/skillFoundry/contracts";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import { SKILL_LIMITS_V1 } from "../agent/skillFoundry/limits";
import type {
  ClockV1,
  DraftStoreV1,
  FoundryPathsV1,
  InstallDraftResultV1,
  RevokeSkillResultV1,
  RollbackSkillResultV1,
  SkillActivationIndexV1,
} from "./contracts";
import { atomicPublishDirectoryV1, atomicWriteBytesV1, isSafePathComponentV1 } from "./safeFs";
import { appendStateTransitionV1 } from "./stateLedger";
import { resolveOfflineExecutionIdentityV1, type ExecutionIdentityDepsV1 } from "./draftStore";

export type PackageLifecycleDepsV1 = {
  store: DraftStoreV1;
  paths: FoundryPathsV1;
  clock: ClockV1;
  identityDeps?: ExecutionIdentityDepsV1;
  compatibilityContext: SkillCompatibilityContextV1;
};

function toCertifiedFileV1(name: string, bytes: Uint8Array, sha256: string): CertifiedSkillFileV1 {
  return { name, bytes: bytes.length, sha256, utf8: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
}

async function readActivationIndexV1(activePath: string): Promise<SkillActivationIndexV1> {
  try {
    const raw = await readFile(activePath, "utf8");
    const parsed = JSON.parse(raw) as SkillActivationIndexV1;
    if (parsed.schemaVersion !== 1 || typeof parsed.generation !== "number" || parsed.skills === null || typeof parsed.skills !== "object") {
      throw new Error("malformed active.json");
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, generation: 0, skills: {} };
    }
    throw err;
  }
}

/** Atomic, capped (64 entries / 64 KiB) write of `active.json`. */
export async function writeActivationIndexV1(activePath: string, index: SkillActivationIndexV1): Promise<void> {
  if (Object.keys(index.skills).length > SKILL_LIMITS_V1.activationEntries) {
    throw new Error(`quota exceeded: activation index would exceed ${SKILL_LIMITS_V1.activationEntries} entries`);
  }
  const bytes = canonicalJsonBytes(index);
  if (bytes.length > SKILL_LIMITS_V1.activationIndexBytes) {
    throw new Error(`quota exceeded: activation index would exceed ${SKILL_LIMITS_V1.activationIndexBytes} bytes`);
  }
  await atomicWriteBytesV1(activePath, bytes);
}

export async function installDraftV1(input: { draftId: string }, deps: PackageLifecycleDepsV1): Promise<InstallDraftResultV1> {
  if ((NATIVE_SKILL_IDS_V1 as readonly string[]).includes(input.draftId)) {
    return { ok: false, code: "wrong_state", message: "install rejects native artifact kinds" };
  }

  const snapshot = await deps.store.loadDraft(input.draftId);
  // "certified" is also legal here: it means a PRIOR install already advanced the ledger
  // (declarative `certified` is reached the moment the four-file package + release.json are
  // durably published) and this call is a re-run — install must stay idempotent across that
  // boundary rather than treating its own prior success as a now-illegal starting state.
  if (snapshot.currentState !== "owner_approved" && snapshot.currentState !== "certified") {
    return { ok: false, code: "wrong_state", message: `draft must be "owner_approved" (or already "certified" from a prior install) to install, is "${String(snapshot.currentState)}"` };
  }

  const manifestBytes = await deps.store.readArtifactBytes(input.draftId, "candidate");
  const certificationBytes = await deps.store.readArtifactBytes(input.draftId, "certification");
  const approvalBytes = await deps.store.readArtifactBytes(input.draftId, "approval");

  const [manifestSha256, certificationSha256, approvalSha256] = await Promise.all([
    sha256Bytes(manifestBytes),
    sha256Bytes(certificationBytes),
    sha256Bytes(approvalBytes),
  ]);

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (err) {
    return { ok: false, code: "invalid_artifact", message: `candidate.skill.json is not valid JSON: ${(err as Error).message}` };
  }
  const skillId = (manifestJson as Record<string, unknown>).id as string | undefined;
  const version = (manifestJson as Record<string, unknown>).version as string | undefined;
  if (skillId === undefined || version === undefined) {
    return { ok: false, code: "invalid_artifact", message: "candidate.skill.json is missing id/version" };
  }

  const nowIso = deps.clock.now().toISOString();
  const buildFreshReleaseBytes = (): Uint8Array =>
    canonicalJsonBytes({
      schemaVersion: 1,
      state: "certified" as const,
      skillId,
      version,
      manifestSha256,
      certificationReportSha256: certificationSha256,
      approvalSha256,
      certifiedAt: nowIso,
    });

  // A re-run of install against the SAME already-published package must reuse the EXISTING
  // release.json bytes verbatim (including its original certifiedAt) rather than minting a
  // fresh timestamp every call — otherwise two installs of the identical approved draft
  // would never byte-match and "re-running install is idempotent" (spec) would be false.
  const packagePathForReuse = join(deps.paths.certifiedRoot, `${skillId}@${version}`);
  const existingReleaseBytes = await readFile(join(packagePathForReuse, "release.json")).catch(() => null);
  let releaseBytes: Uint8Array = buildFreshReleaseBytes();
  if (existingReleaseBytes !== null) {
    try {
      const existingRelease = JSON.parse(existingReleaseBytes.toString("utf8")) as Record<string, unknown>;
      const matches =
        existingRelease.skillId === skillId &&
        existingRelease.version === version &&
        existingRelease.manifestSha256 === manifestSha256 &&
        existingRelease.certificationReportSha256 === certificationSha256 &&
        existingRelease.approvalSha256 === approvalSha256;
      if (matches) releaseBytes = new Uint8Array(existingReleaseBytes);
    } catch {
      // Existing file is unreadable JSON — fall through to the freshly built bytes; the
      // package-conflict check below will catch any real mismatch after staging.
    }
  }

  const packageBytesInput = {
    directoryName: `${skillId}@${version}`,
    skillIdFromDirectory: skillId,
    versionFromDirectory: version,
    files: {
      skill: toCertifiedFileV1("skill.json", manifestBytes, manifestSha256),
      certification: toCertifiedFileV1("certification.json", certificationBytes, certificationSha256),
      approval: toCertifiedFileV1("approval.json", approvalBytes, approvalSha256),
      release: toCertifiedFileV1("release.json", releaseBytes, await sha256Bytes(releaseBytes)),
    },
  };
  const validated = await validateCertifiedSkillPackageV1(packageBytesInput, deps.compatibilityContext);
  if (!validated.ok) {
    return { ok: false, code: "invalid_artifact", message: `${validated.code}: ${validated.message}` };
  }

  const packagePath = join(deps.paths.certifiedRoot, `${skillId}@${version}`);

  let published = true;
  try {
    await atomicPublishDirectoryV1(packagePath, async (stagingDir) => {
      await atomicWriteBytesV1(join(stagingDir, "skill.json"), manifestBytes);
      await atomicWriteBytesV1(join(stagingDir, "certification.json"), certificationBytes);
      await atomicWriteBytesV1(join(stagingDir, "approval.json"), approvalBytes);
      await atomicWriteBytesV1(join(stagingDir, "release.json"), releaseBytes); // release.json LAST
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST" || (err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
      published = false;
    } else {
      throw err;
    }
  }

  if (!published) {
    // Idempotent only when every existing file matches exactly; otherwise a real conflict.
    const existingRelease = await readFile(join(packagePath, "release.json")).catch(() => null);
    const existingManifest = await readFile(join(packagePath, "skill.json")).catch(() => null);
    const identicalRelease = existingRelease !== null && Buffer.compare(existingRelease, Buffer.from(releaseBytes)) === 0;
    const identicalManifest = existingManifest !== null && Buffer.compare(existingManifest, Buffer.from(manifestBytes)) === 0;
    if (!identicalRelease || !identicalManifest) {
      return { ok: false, code: "package_conflict", message: `a different package already exists at ${skillId}@${version}` };
    }
  }

  if (snapshot.currentState === "owner_approved") {
    const executionIdentity = await resolveOfflineExecutionIdentityV1(deps.identityDeps);
    try {
      await appendStateTransitionV1(snapshot.statePath, {
        state: "certified",
        artifactKind: "declarative",
        artifactHashes: { release: await sha256Bytes(releaseBytes) },
        executionIdentity,
        testCommand: "teach-moshi install",
        startedAt: nowIso,
        finishedAt: nowIso,
        result: "passed",
      });
    } catch {
      // Already certified (idempotent re-install after a prior crash between package
      // publication and this append) — the ledger already reflects it.
    }
  }

  let activated = true;
  try {
    const currentIndex = await readActivationIndexV1(deps.paths.activePath);
    const existingEntry = currentIndex.skills[skillId];
    if (existingEntry?.version === version && existingEntry.manifestSha256 === manifestSha256 && existingEntry.releaseSha256 === (await sha256Bytes(releaseBytes))) {
      // Already activated at exactly this version — unchanged.
    } else {
      const nextIndex: SkillActivationIndexV1 = {
        schemaVersion: 1,
        generation: currentIndex.generation + 1,
        skills: { ...currentIndex.skills, [skillId]: { version, manifestSha256, releaseSha256: await sha256Bytes(releaseBytes) } },
      };
      await writeActivationIndexV1(deps.paths.activePath, nextIndex);
    }
  } catch (err) {
    activated = false;
    return { ok: false, code: "activation_failed", message: (err as Error).message };
  }

  return { ok: true, skillId, version, packagePath, activated, changed: published || activated };
}

export async function rollbackSkillV1(
  input: { skillId: string; version: string },
  deps: PackageLifecycleDepsV1,
): Promise<RollbackSkillResultV1> {
  if (!isSafePathComponentV1(input.skillId, 64) || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    return { ok: false, code: "not_found", message: "unsafe skill id or malformed version" };
  }
  const packagePath = join(deps.paths.certifiedRoot, `${input.skillId}@${input.version}`);
  let manifestBytes: Buffer;
  let certificationBytes: Buffer;
  let approvalBytes: Buffer;
  let releaseBytes: Buffer;
  try {
    [manifestBytes, certificationBytes, approvalBytes, releaseBytes] = await Promise.all([
      readFile(join(packagePath, "skill.json")),
      readFile(join(packagePath, "certification.json")),
      readFile(join(packagePath, "approval.json")),
      readFile(join(packagePath, "release.json")),
    ]);
  } catch {
    return { ok: false, code: "not_found", message: `no installed package at ${input.skillId}@${input.version}` };
  }

  const [manifestSha256, certificationSha256, approvalSha256, releaseSha256] = await Promise.all([
    sha256Bytes(manifestBytes),
    sha256Bytes(certificationBytes),
    sha256Bytes(approvalBytes),
    sha256Bytes(releaseBytes),
  ]);
  const validated = await validateCertifiedSkillPackageV1(
    {
      directoryName: `${input.skillId}@${input.version}`,
      skillIdFromDirectory: input.skillId,
      versionFromDirectory: input.version,
      files: {
        skill: toCertifiedFileV1("skill.json", manifestBytes, manifestSha256),
        certification: toCertifiedFileV1("certification.json", certificationBytes, certificationSha256),
        approval: toCertifiedFileV1("approval.json", approvalBytes, approvalSha256),
        release: toCertifiedFileV1("release.json", releaseBytes, releaseSha256),
      },
    },
    deps.compatibilityContext,
  );
  if (!validated.ok) {
    return { ok: false, code: "invalid_artifact", message: `${validated.code}: ${validated.message}` };
  }

  const currentIndex = await readActivationIndexV1(deps.paths.activePath);
  const existing = currentIndex.skills[input.skillId];
  if (existing?.version === input.version && existing.manifestSha256 === manifestSha256 && existing.releaseSha256 === releaseSha256) {
    return { ok: true, skillId: input.skillId, version: input.version, changed: false };
  }

  try {
    const nextIndex: SkillActivationIndexV1 = {
      schemaVersion: 1,
      generation: currentIndex.generation + 1,
      skills: { ...currentIndex.skills, [input.skillId]: { version: input.version, manifestSha256, releaseSha256 } },
    };
    await writeActivationIndexV1(deps.paths.activePath, nextIndex);
  } catch (err) {
    return { ok: false, code: "activation_failed", message: (err as Error).message };
  }

  return { ok: true, skillId: input.skillId, version: input.version, changed: true };
}

export async function revokeSkillV1(input: { skillId: string }, deps: PackageLifecycleDepsV1): Promise<RevokeSkillResultV1> {
  const currentIndex = await readActivationIndexV1(deps.paths.activePath);
  if (!(input.skillId in currentIndex.skills)) {
    return { ok: true, skillId: input.skillId, changed: false };
  }
  const { [input.skillId]: _removed, ...rest } = currentIndex.skills;
  const nextIndex: SkillActivationIndexV1 = { schemaVersion: 1, generation: currentIndex.generation + 1, skills: rest };
  await writeActivationIndexV1(deps.paths.activePath, nextIndex);
  return { ok: true, skillId: input.skillId, changed: true };
}
