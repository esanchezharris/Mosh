// Task 6 — RED-first pin for `authorCandidateArtifactsV1`: internal create-only authoring,
// changed-artifact staleness, no public author command, crash-marker detection/recovery, and
// native-artifact-kind rejection.

import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorCandidateArtifactsV1, markerPathForTestV1 } from "./compilerAuthoring";
import { createDraftStoreV1 } from "./draftStore";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { runAuthorCandidateV1 } from "../../scripts/teachMoshi/authorCandidate";
import { atomicWriteBytesV1 } from "./safeFs";
import { join } from "node:path";

const FAKE_IDENTITY_DEPS = { resolveGitCommit: async () => "a".repeat(40), resolveAppVersion: async () => "1.0.0" };
const CLOCK = { now: () => new Date("2026-01-01T00:00:00.000Z") };

describe("authorCandidateArtifactsV1", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("create-only writes both artifacts on first authoring", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const result = await authorCandidateArtifactsV1(
      { draftId: created.skillId, candidateBytes: new TextEncoder().encode('{"a":1}'), evalsBytes: new TextEncoder().encode('{"b":2}\n') },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );
    expect(result.changed).toBe(true);
  });

  it("returns unchanged for exact-existing bytes (idempotent)", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const candidateBytes = new TextEncoder().encode('{"a":1}');
    const evalsBytes = new TextEncoder().encode('{"b":2}\n');
    await authorCandidateArtifactsV1({ draftId: created.skillId, candidateBytes, evalsBytes }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS });
    const second = await authorCandidateArtifactsV1({ draftId: created.skillId, candidateBytes, evalsBytes }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS });
    expect(second.changed).toBe(false);
  });

  it("a changed artifact appends 'stale' once the draft has passed source_reviewed", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const { appendStateTransitionV1 } = await import("./stateLedger");
    await appendStateTransitionV1(created.statePath, {
      state: "source_reviewed",
      artifactKind: "declarative",
      artifactHashes: {},
      executionIdentity: { gitCommit: "a".repeat(40), appVersion: "1.0.0", build: { kind: "offline", toolVersion: "teach-moshi-v1" } },
      testCommand: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      result: "passed",
    });

    await authorCandidateArtifactsV1(
      { draftId: created.skillId, candidateBytes: new TextEncoder().encode('{"a":1}'), evalsBytes: new TextEncoder().encode('{"b":2}\n') },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );
    const changed = await authorCandidateArtifactsV1(
      { draftId: created.skillId, candidateBytes: new TextEncoder().encode('{"a":2}'), evalsBytes: new TextEncoder().encode('{"b":2}\n') },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );
    expect(changed.changed).toBe(true);
    const { readStateLedgerV1 } = await import("./stateLedger");
    const ledger = await readStateLedgerV1(created.statePath);
    expect(ledger.at(-1)?.state).toBe("stale");
  });

  it("rejects a native draft id", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    await expect(
      authorCandidateArtifactsV1(
        { draftId: "session-control", candidateBytes: new TextEncoder().encode("{}"), evalsBytes: new TextEncoder().encode("{}\n") },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      ),
    ).rejects.toThrow(/native/i);
  });

  it("recovers a crash-interrupted marker on the next authoring attempt", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    await authorCandidateArtifactsV1(
      { draftId: created.skillId, candidateBytes: new TextEncoder().encode('{"a":1}'), evalsBytes: new TextEncoder().encode('{"b":2}\n') },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );

    // Simulate a crash: hand-write a marker claiming an in-flight transition to v3, where
    // the candidate file is still at v1 (matches marker.old) — recovery must finish writing
    // v3 deterministically from the marker's own stored bytes, not by re-running authoring.
    const v3Candidate = new TextEncoder().encode('{"a":3}');
    const { sha256Bytes } = await import("../agent/skillFoundry/hash");
    const v1Sha = await sha256Bytes(new TextEncoder().encode('{"a":1}'));
    const v3Sha = await sha256Bytes(v3Candidate);
    const evalSha = await sha256Bytes(new TextEncoder().encode('{"b":2}\n'));
    const marker = {
      schemaVersion: 1,
      nonce: "crash-nonce",
      old: { candidateSha256: v1Sha, evalSha256: evalSha },
      new: { candidateSha256: v3Sha, evalSha256: evalSha },
      newCandidateBase64: Buffer.from(v3Candidate).toString("base64"),
      newEvalBase64: Buffer.from(new TextEncoder().encode('{"b":2}\n')).toString("base64"),
      staleAppended: true,
    };
    await atomicWriteBytesV1(markerPathForTestV1(created.draftDir), new TextEncoder().encode(JSON.stringify(marker)));

    // A NORMAL load must fail closed while the marker exists.
    await expect(store.loadDraft(created.skillId)).rejects.toMatchObject({ code: "draft_update_incomplete" });

    const recovered = await authorCandidateArtifactsV1(
      { draftId: created.skillId, candidateBytes: v3Candidate, evalsBytes: new TextEncoder().encode('{"b":2}\n') },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );
    expect(recovered.changed).toBe(false); // v3 already matches what recovery just finished writing
    const finalBytes = await readFile(join(created.draftDir, "candidate.skill.json"));
    expect(finalBytes.toString("utf8")).toBe('{"a":3}');
    // Recovery must have removed the marker.
    await expect(readFile(markerPathForTestV1(created.draftDir))).rejects.toBeDefined();
  });
});

describe("authorCandidate.ts — no public author command, input validation", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("teach-moshi has no 'author' command in its known command set", async () => {
    const { parseTeachMoshiArgsV1 } = await import("./commands");
    const result = parseTeachMoshiArgsV1(["author", "--draft", "x", "--candidate", "/tmp/a", "--evals", "/tmp/b"]);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown flag", async () => {
    const result = await runAuthorCandidateV1(["--bogus", "x"], foundry.paths);
    expect(result.ok).toBe(false);
  });

  it("rejects a relative --candidate path", async () => {
    const result = await runAuthorCandidateV1(["--draft", "owner-x", "--candidate", "relative.json", "--evals", "/tmp/e.json"], foundry.paths);
    expect(result.ok).toBe(false);
  });

  it("rejects a symlinked --candidate file without mutating the draft", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const realPath = join(foundry.homeDir, "real.json");
    await atomicWriteBytesV1(realPath, new TextEncoder().encode("{}"));
    const linkPath = join(foundry.homeDir, "link.json");
    const { symlink } = await import("node:fs/promises");
    await symlink(realPath, linkPath);
    const evalsPath = join(foundry.homeDir, "evals.jsonl");
    await atomicWriteBytesV1(evalsPath, new TextEncoder().encode("{}\n"));

    const result = await runAuthorCandidateV1(["--draft", created.skillId, "--candidate", linkPath, "--evals", evalsPath], foundry.paths);
    expect(result.ok).toBe(false);
    const snapshot = await store.loadDraft(created.skillId);
    expect(snapshot.currentState).toBe("draft"); // unchanged
  });

  it("rejects an oversized --candidate file", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const bigPath = join(foundry.homeDir, "big.json");
    const { MAX_CANDIDATE_BYTES } = await import("../../scripts/teachMoshi/authorCandidate");
    await atomicWriteBytesV1(bigPath, new TextEncoder().encode("x".repeat(MAX_CANDIDATE_BYTES + 1)));
    const evalsPath = join(foundry.homeDir, "evals.jsonl");
    await atomicWriteBytesV1(evalsPath, new TextEncoder().encode("{}\n"));

    const result = await runAuthorCandidateV1(["--draft", created.skillId, "--candidate", bigPath, "--evals", evalsPath], foundry.paths);
    expect(result.ok).toBe(false);
  });
});
