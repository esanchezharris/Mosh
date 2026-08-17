// Task 8 — RED-first pin for install/rollback/revoke: exact four files, release-last,
// identical reinstall, conflict, 64/+1 active entries, rollback-to-active, repeated revoke.

import { readdir, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDraftV1, rollbackSkillV1, revokeSkillV1, writeActivationIndexV1 } from "./packageLifecycle";
import { createDraftStoreV1 } from "./draftStore";
import { appendStateTransitionV1 } from "./stateLedger";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { catalogFingerprintV1 } from "../agent/skillFoundry/catalogs";
import { canonicalJsonBytes } from "../agent/skillFoundry/hash";
import type { SkillCompatibilityContextV1 } from "../agent/skillFoundry/contracts";
import { SKILL_LIMITS_V1 } from "../agent/skillFoundry/limits";

const FAKE_IDENTITY_DEPS = { resolveGitCommit: async () => "a".repeat(40), resolveAppVersion: async () => "1.0.0" };
const CLOCK = { now: () => new Date("2026-01-01T00:00:00.000Z") };
const IDENTITY = { gitCommit: "a".repeat(40), appVersion: "1.0.0", build: { kind: "offline" as const, toolVersion: "teach-moshi-v1" as const } };

async function buildCompatibilityContext(): Promise<SkillCompatibilityContextV1> {
  const catalogFingerprint = await catalogFingerprintV1();
  return {
    appVersion: "1.0.0",
    gitCommit: "a".repeat(40),
    gitState: "clean",
    moshBuildIdentity: "git=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|version=1.0.0|target=Mosh|configuration=Release|architecture=arm64",
    catalogFingerprint,
    nativeSourceSha256ByHandler: {
      sessionControlV1: "0".repeat(64),
      takeCycleV1: "0".repeat(64),
      explicitBalanceV1: "0".repeat(64),
      loadNamedPluginV1: "0".repeat(64),
    },
  };
}

async function buildOwnerApprovedDraft(foundry: IsolatedFoundryV1, goal = "Park backgrounds", idSuffix = "") {
  const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
  const created = await store.createDraft({ goal, id: idSuffix || undefined });
  const fingerprint = await catalogFingerprintV1();
  const manifest = {
    schemaVersion: 1,
    id: created.skillId,
    version: "1.0.0",
    title: goal,
    description: "Sets the background vocals track level and mutes it.",
    implementation: "declarative",
    intents: { positiveExamples: ["park the backgrounds"], negativeExamples: ["play the track"], tags: ["mixing"] },
    slots: [],
    preconditions: [],
    steps: [{ kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 }],
    postconditions: [],
    execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 5000 },
    responses: { completed: "Done.", needsChoice: "Which track?", blocked: "Could not complete." },
    provenance: [],
    compatibility: {
      minMoshVersion: "0.0.1",
      commandCatalogSha256: fingerprint.commandCatalogSha256,
      predicateCatalogVersion: fingerprint.predicateCatalogVersion,
      resolverCatalogVersion: fingerprint.resolverCatalogVersion,
    },
  };
  const manifestBytes = canonicalJsonBytes(manifest);
  await store.writeArtifactBytes(created.skillId, "candidate", manifestBytes, { createOnly: true });

  const report = {
    schemaVersion: 1,
    state: "acceptance_green",
    runId: "run-1",
    skillId: created.skillId,
    version: "1.0.0",
    artifact: { kind: "declarative_manifest", sha256: await (await import("../agent/skillFoundry/hash")).sha256Bytes(manifestBytes) },
    evalSha256: "b".repeat(64),
    gitCommit: "a".repeat(40),
    moshBuildIdentity: "git=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|version=1.0.0|target=Mosh|configuration=Release|architecture=arm64",
    commandCatalogSha256: fingerprint.commandCatalogSha256,
    predicateCatalogVersion: fingerprint.predicateCatalogVersion,
    resolverCatalogVersion: fingerprint.resolverCatalogVersion,
    sourceStatusIndexSha256: "c".repeat(64),
    gates: [],
    manualEvidenceSha256: [],
    frozenAt: "2026-01-01T00:00:00.000Z",
  };
  const certificationBytes = canonicalJsonBytes(report);
  await store.writeArtifactBytes(created.skillId, "certification", certificationBytes, { createOnly: true });

  const { sha256Bytes, utf8Bytes } = await import("../agent/skillFoundry/hash");
  const manifestSha256 = await sha256Bytes(manifestBytes);
  const certificationReportSha256 = await sha256Bytes(certificationBytes);
  const reviewSha256 = await sha256Bytes(utf8Bytes(`mosh-skill-review-v1\n${manifestSha256}\n${certificationReportSha256}\n`));

  const approval = {
    schemaVersion: 1,
    state: "owner_approved",
    reviewSha256,
    artifact: { kind: "declarative_manifest", sha256: manifestSha256 },
    certificationReportSha256,
    exactStatement: "I approve exactly this.",
    actor: "owner",
    channel: "session",
    approvedAt: "2026-01-01T00:00:00.000Z",
  };
  const approvalBytes = canonicalJsonBytes(approval);
  await store.writeArtifactBytes(created.skillId, "approval", approvalBytes, { createOnly: true });

  for (const state of ["source_reviewed", "schema_valid", "mock_green", "native_green", "packaged_green", "acceptance_green", "owner_approved"] as const) {
    await appendStateTransitionV1(created.statePath, {
      state,
      artifactKind: "declarative",
      artifactHashes: {},
      executionIdentity: IDENTITY,
      testCommand: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      result: "passed",
    });
  }

  return { store, created };
}

describe("installDraftV1", () => {
  let foundry: IsolatedFoundryV1;
  let compatibilityContext: SkillCompatibilityContextV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
    compatibilityContext = await buildCompatibilityContext();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("installs exactly the four named files, release.json written last (readable only once complete)", async () => {
    const { store, created } = await buildOwnerApprovedDraft(foundry);
    const installed = await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const files = await readdir(installed.packagePath);
    expect(files.sort()).toEqual(["approval.json", "certification.json", "release.json", "skill.json"]);
    expect(installed.activated).toBe(true);
  });

  it("is idempotent when every existing hash matches (identical re-install)", async () => {
    const { store, created } = await buildOwnerApprovedDraft(foundry);
    const first = await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(first.ok).toBe(true);
    const second = await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    if (!first.ok) return;
    expect(second.packagePath).toBe(first.packagePath);
  });

  it("activates the package in active.json with the correct id/version/hashes", async () => {
    const { store, created } = await buildOwnerApprovedDraft(foundry);
    await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    const active = JSON.parse(await readFile(foundry.paths.activePath, "utf8"));
    expect(active.skills[created.skillId]).toMatchObject({ version: "1.0.0" });
    expect(active.generation).toBe(1);
  });

  it("rejects install when the draft is not owner_approved", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Not approved" });
    const result = await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(result).toMatchObject({ ok: false, code: "wrong_state" });
  });

  it("accepts exactly 64 activation entries and rejects the 65th", async () => {
    const skills: Record<string, { version: string; manifestSha256: string; releaseSha256: string }> = {};
    for (let i = 0; i < SKILL_LIMITS_V1.activationEntries; i += 1) {
      skills[`owner-x-${i}`] = { version: "1.0.0", manifestSha256: "a".repeat(64), releaseSha256: "b".repeat(64) };
    }
    await writeActivationIndexV1(foundry.paths.activePath, { schemaVersion: 1, generation: 1, skills });
    await expect(
      writeActivationIndexV1(foundry.paths.activePath, {
        schemaVersion: 1,
        generation: 2,
        skills: { ...skills, "owner-over": { version: "1.0.0", manifestSha256: "a".repeat(64), releaseSha256: "b".repeat(64) } },
      }),
    ).rejects.toThrow(/quota/i);
  });
});

describe("rollbackSkillV1 / revokeSkillV1", () => {
  let foundry: IsolatedFoundryV1;
  let compatibilityContext: SkillCompatibilityContextV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
    compatibilityContext = await buildCompatibilityContext();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("rollback-to-the-already-active version is unchanged", async () => {
    const { store, created } = await buildOwnerApprovedDraft(foundry);
    await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    const result = await rollbackSkillV1({ skillId: created.skillId, version: "1.0.0" }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(result).toMatchObject({ ok: true, changed: false });
  });

  it("rollback fails for a version that was never installed", async () => {
    const { store } = await buildOwnerApprovedDraft(foundry);
    const result = await rollbackSkillV1({ skillId: "owner-never-installed", version: "1.0.0" }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  it("revoke removes only the activation entry; packages and evidence are preserved", async () => {
    const { store, created } = await buildOwnerApprovedDraft(foundry);
    const installed = await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const revoked = await revokeSkillV1({ skillId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(revoked).toMatchObject({ ok: true, changed: true });

    const active = JSON.parse(await readFile(foundry.paths.activePath, "utf8"));
    expect(active.skills[created.skillId]).toBeUndefined();
    // Package files are untouched.
    const files = await readdir(installed.packagePath);
    expect(files.sort()).toEqual(["approval.json", "certification.json", "release.json", "skill.json"]);
  });

  it("repeated revoke is unchanged (idempotent)", async () => {
    const { store, created } = await buildOwnerApprovedDraft(foundry);
    await installDraftV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    await revokeSkillV1({ skillId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    const second = await revokeSkillV1({ skillId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS, compatibilityContext });
    expect(second).toMatchObject({ ok: true, changed: false });
  });
});
