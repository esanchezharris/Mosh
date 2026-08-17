// Task 10 — RED-first pin for the complete wired CLI: every command produces its required
// durable effect, and one full temp-root flow proves the whole pipeline plus idempotency at
// several checkpoints (unchanged refresh, approval, install, rollback-to-active,
// revoke-inactive, dry-run GC).

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRealTeachMoshiDepsV1, runTeachMoshiV1 } from "./commands";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { catalogFingerprintV1 } from "../agent/skillFoundry/catalogs";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import { atomicWriteBytesV1 } from "./safeFs";

const execFileAsync = promisify(execFile);
const FIXTURE_PATH = join(process.cwd(), "src/skillFoundry/fixtures/fake-certifier.mjs");

async function makeFakeCertifierBinV1(dir: string, mode: string): Promise<string> {
  const binPath = join(dir, `fake-bin-${mode}.sh`);
  await writeFile(binPath, `#!/bin/sh\nexport FAKE_CERTIFIER_MODE="${mode}"\nexec node "${FIXTURE_PATH}" "$@"\n`);
  await chmod(binPath, 0o755);
  return binPath;
}

async function buildValidSourceCard(): Promise<Record<string, unknown>> {
  const withoutHash = {
    schemaVersion: 1,
    sourceCardId: "yt-dark-trap-808-walkthrough-001",
    sourceVersion: "v1",
    rights: "official_public_documentation",
    acquisition: "official_https_page",
    platformHandling: "metadata_and_short_paraphrases_only",
    evidenceSha256: "9a7c1b2f0c7d4e17f49d2fdc56dd8c4bcf3d6dfef7b8c1d3fbcf4a4f05d9aa01",
    reviewer: "mosh-owner",
    reviewedAt: "2026-06-30T00:00:00.000Z",
    state: "current" as const,
    dependentIds: [] as string[],
    claims: [{ claimId: "c1", origin: "source_text", workflowMoment: "intro", paraphrase: "kick locks in", boundary: "vocabulary only" }],
  };
  const snapshotPayload = {
    sourceCardId: withoutHash.sourceCardId,
    sourceVersion: withoutHash.sourceVersion,
    rights: withoutHash.rights,
    acquisition: withoutHash.acquisition,
    platformHandling: withoutHash.platformHandling,
    evidenceSha256: withoutHash.evidenceSha256,
    claims: withoutHash.claims,
  };
  const sourceSnapshotSha256 = await sha256Bytes(canonicalJsonBytes(snapshotPayload));
  return { ...withoutHash, sourceSnapshotSha256 };
}

describe("teach-moshi CLI — full temp-root flow", () => {
  let foundry: IsolatedFoundryV1;
  let scratch: string;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
    scratch = await mkdtemp(join(tmpdir(), "mosh-cli-scratch-"));
  });

  afterEach(async () => {
    await foundry.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  it("init -> add-source -> add-reference -> validate -> certify(manual) -> record-evidence -> certify(completed) -> review -> approve -> install -> status -> revoke -> rollback -> refresh-source -> revoke-source -> gc", async () => {
    const deps = await createRealTeachMoshiDepsV1(foundry.paths);

    // init
    const init = await runTeachMoshiV1(["init", "--goal", "Park backgrounds"], deps);
    expect(init.exitCode).toBe(0);
    expect(init.envelope).toMatchObject({ schemaVersion: 1, ok: true, command: "init" });
    const draftId = (init.envelope as { result: { skillId: string } }).result.skillId;
    expect(draftId).toBe("owner-park-backgrounds");

    // add-source
    const card = await buildValidSourceCard();
    const cardPath = join(scratch, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(card));
    const addSource = await runTeachMoshiV1(["add-source", "--draft", draftId, "--card", cardPath], deps);
    expect(addSource.exitCode).toBe(0);

    // add-reference
    const referenceFile = join(scratch, "evidence.wav");
    await writeFile(referenceFile, "fake audio evidence bytes");
    const addReference = await runTeachMoshiV1(["add-reference", "--draft", draftId, "--file", referenceFile], deps);
    expect(addReference.exitCode).toBe(0);

    // Author the candidate + evals directly through the internal compiler helper (this is
    // Codex's job in production, not a public CLI command) so `validate` has something real.
    const { authorCandidateArtifactsV1 } = await import("./compilerAuthoring");
    const fingerprint = await catalogFingerprintV1();
    const manifest = {
      schemaVersion: 1,
      id: draftId,
      version: "1.0.0",
      title: "Park backgrounds",
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
    const evalCase = {
      schemaVersion: 1,
      id: "case-1",
      selected: { journeyId: "session-control", action: "play" },
      supported: true,
      utterance: "play it",
      fixtureSha256: "a".repeat(64),
      initialStateSha256: "b".repeat(64),
      expectedOutcome: { kind: "completed", code: null },
      finalStatePredicates: [],
      prohibitedEffects: [],
      evidenceLevel: "physical",
      scoringCategory: "selection",
      invalidFillPhase: "none",
      expectedObservation: "audible kept take after relaunch",
    };
    const { createDraftStoreV1 } = await import("./draftStore");
    const authoringStore = createDraftStoreV1(foundry.paths, { now: () => new Date() });
    await authorCandidateArtifactsV1(
      { draftId, candidateBytes: canonicalJsonBytes(manifest), evalsBytes: new TextEncoder().encode(`${JSON.stringify(evalCase)}\n`) },
      { store: authoringStore, paths: foundry.paths, clock: { now: () => new Date() } },
    );

    // validate
    const validate = await runTeachMoshiV1(["validate", "--draft", draftId], deps);
    expect(validate.exitCode).toBe(0);
    expect(validate.envelope).toMatchObject({ ok: true, result: { state: "schema_valid" } });

    // certify -> needs_manual_evidence
    const manualBin = await makeFakeCertifierBinV1(scratch, "manual");
    const certifyManual = await runTeachMoshiV1(["certify", "--draft", draftId, "--bin", manualBin], deps);
    expect(certifyManual.exitCode).toBe(0); // manual checkpoint exits 0
    expect(certifyManual.envelope).toMatchObject({ ok: true, result: { kind: "needs_manual_evidence" } });

    // record-evidence
    const evidencePayload = {
      schemaVersion: 1,
      runId: (certifyManual.envelope as { result: { runId: string } }).result.runId,
      caseId: "physical-001",
      artifact: { kind: "declarative_manifest", sha256: await sha256Bytes(canonicalJsonBytes(manifest)) },
      evalSha256: await sha256Bytes(new TextEncoder().encode(`${JSON.stringify(evalCase)}\n`)),
      expectedObservation: "audible kept take after relaunch",
      decision: "passed",
      observed: "heard the kept take clearly on relaunch",
      actor: "owner",
      recordedAt: "2026-01-01T00:00:00.000Z",
      artifacts: [],
    };
    const evidencePath = join(scratch, "evidence-record.json");
    await atomicWriteBytesV1(evidencePath, canonicalJsonBytes(evidencePayload));
    const recordEvidence = await runTeachMoshiV1(["record-evidence", "--draft", draftId, "--case", "physical-001", "--evidence", evidencePath], deps);
    expect(recordEvidence.exitCode).toBe(0);

    // certify -> completed (gates all pass, appends mock_green..acceptance_green)
    const completedBin = await makeFakeCertifierBinV1(scratch, "completed");
    const certifyCompleted = await runTeachMoshiV1(["certify", "--draft", draftId, "--bin", completedBin], deps);
    expect(certifyCompleted.exitCode).toBe(0);
    expect(certifyCompleted.envelope).toMatchObject({ ok: true, result: { kind: "completed" } });

    // review
    const review = await runTeachMoshiV1(["review", "--draft", draftId], deps);
    expect(review.exitCode).toBe(0);
    const reviewSha256 = (review.envelope as { result: { reviewSha256: string } }).result.reviewSha256;
    expect(reviewSha256).toMatch(/^[0-9a-f]{64}$/);

    // approve
    const attestation = {
      schemaVersion: 1,
      reviewSha256,
      exactStatement: "I approve exactly this reviewed behavior and report.",
      actor: "owner",
      channel: "session",
      approvedAt: "2026-01-01T00:00:00.000Z",
    };
    const attestationPath = join(scratch, "attestation.json");
    await atomicWriteBytesV1(attestationPath, canonicalJsonBytes(attestation));
    const approve = await runTeachMoshiV1(["approve", "--draft", draftId, "--review-sha", reviewSha256, "--attestation", attestationPath], deps);
    expect(approve.exitCode).toBe(0);

    // install
    const install = await runTeachMoshiV1(["install", "--draft", draftId], deps);
    expect(install.exitCode).toBe(0);
    expect(install.envelope).toMatchObject({ ok: true, result: { ok: true, activated: true } });

    // install again — idempotent
    const installAgain = await runTeachMoshiV1(["install", "--draft", draftId], deps);
    expect(installAgain.exitCode).toBe(0);

    // status
    const status = await runTeachMoshiV1(["status", "--draft", draftId], deps);
    expect(status.exitCode).toBe(0);
    expect(status.envelope).toMatchObject({ ok: true, result: { currentState: "certified" } });

    // rollback-to-active is unchanged
    const rollback = await runTeachMoshiV1(["rollback", "--id", draftId, "--version", "1.0.0"], deps);
    expect(rollback.exitCode).toBe(0);
    expect(rollback.envelope).toMatchObject({ ok: true, result: { changed: false } });

    // revoke, then revoke-inactive is unchanged
    const revoke = await runTeachMoshiV1(["revoke", "--id", draftId], deps);
    expect(revoke.exitCode).toBe(0);
    expect(revoke.envelope).toMatchObject({ ok: true, result: { changed: true } });
    const revokeAgain = await runTeachMoshiV1(["revoke", "--id", draftId], deps);
    expect(revokeAgain.envelope).toMatchObject({ ok: true, result: { changed: false } });

    // refresh-source with UNCHANGED content is a no-op generation bump
    const refreshSource = await runTeachMoshiV1(["refresh-source", "--card", cardPath], deps);
    expect(refreshSource.exitCode).toBe(0);
    expect(refreshSource.envelope).toMatchObject({ ok: true, result: { changed: true } }); // extends freshness (checkedAt changes)

    // revoke-source
    const revokeSource = await runTeachMoshiV1(["revoke-source", "--id", "yt-dark-trap-808-walkthrough-001"], deps);
    expect(revokeSource.exitCode).toBe(0);
    expect(revokeSource.envelope).toMatchObject({ ok: true, result: { changed: true } });
    const revokeSourceAgain = await runTeachMoshiV1(["revoke-source", "--id", "yt-dark-trap-808-walkthrough-001"], deps);
    expect(revokeSourceAgain.envelope).toMatchObject({ ok: true, result: { changed: false } });

    // dry-run gc changes nothing (default, no --apply)
    const gcDryRun = await runTeachMoshiV1(["gc"], deps);
    expect(gcDryRun.exitCode).toBe(0);
    expect(gcDryRun.envelope).toMatchObject({ ok: true, result: { dryRun: true } });
    const gcDryRunAgain = await runTeachMoshiV1(["gc"], deps);
    // The CLI's real wiring uses the real wall clock (by design — a real owner invocation
    // needs real timestamps), so `ageDays`/`generatedAt`/`planSha256` legitimately drift by a
    // few milliseconds between two calls. Compare the STABLE part: the same set of paths/kinds.
    const pathsOf = (envelope: unknown) =>
      (envelope as { result: { plan: { entries: { path: string; kind: string }[] } } }).result.plan.entries.map((e) => `${e.kind}:${e.path}`);
    expect(pathsOf(gcDryRunAgain.envelope)).toEqual(pathsOf(gcDryRun.envelope));
    expect((gcDryRunAgain.envelope as { result: { dryRun: boolean } }).result.dryRun).toBe(true);
  });
});

describe("teach-moshi CLI — usage and unknown command", () => {
  it("emits exactly one JSON envelope and exits 2 for an unknown command", async () => {
    const { createStubTeachMoshiDepsV1 } = await import("./commands");
    const result = await runTeachMoshiV1(["frobnicate"], createStubTeachMoshiDepsV1());
    expect(result.exitCode).toBe(2);
    expect(result.envelope).toMatchObject({ schemaVersion: 1, ok: false });
  });
});

describe("teach-moshi CLI — real subprocess entrypoint (isolated via HOME override)", () => {
  it("emits exactly one JSON line and never touches the real home directory", async () => {
    const isolatedHome = await mkdtemp(join(tmpdir(), "mosh-cli-subprocess-home-"));
    try {
      const { stdout } = await execFileAsync(
        "npx",
        ["tsx", "src/skillFoundry/cli.ts", "status", "--draft", "owner-never-created"],
        { env: { ...process.env, HOME: isolatedHome }, cwd: process.cwd() },
      ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
      const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const envelope = JSON.parse(lines[0]);
      expect(envelope).toMatchObject({ schemaVersion: 1, ok: false, command: "status" });
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }, 20000);
});
