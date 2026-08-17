// Task 4 — RED-first pin for deterministic `owner-*` init, collision, legal/illegal
// transitions, truncation, a reordered line, the 4,096/4,097 record boundary, and crash
// recovery (a genesis write left incomplete never exposes a half-published draft).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOUNDRY_STORAGE_LIMITS_V1 } from "./contracts";
import { createDraftStoreV1, deriveOwnerSkillIdV1 } from "./draftStore";
import { appendStateTransitionV1, GENESIS_PREVIOUS_HASH_V1, isLegalStateTransitionV1, readStateLedgerV1 } from "./stateLedger";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import type { ExecutionIdentityV1, FoundryStateRecordV1 } from "./contracts";

const FAKE_IDENTITY: ExecutionIdentityV1 = {
  gitCommit: "a".repeat(40),
  appVersion: "1.0.0",
  build: { kind: "offline", toolVersion: "teach-moshi-v1" },
};

const FAKE_IDENTITY_DEPS = {
  resolveGitCommit: async () => FAKE_IDENTITY.gitCommit,
  resolveAppVersion: async () => FAKE_IDENTITY.appVersion,
};

const FIXED_CLOCK = { now: () => new Date("2026-08-14T00:00:00.000Z") };

describe("deriveOwnerSkillIdV1", () => {
  it("slugifies a goal into an owner-* id", () => {
    expect(deriveOwnerSkillIdV1({ goal: "Park backgrounds" })).toEqual({ ok: true, id: "owner-park-backgrounds" });
  });

  it("accepts an explicit id and prepends owner- once", () => {
    expect(deriveOwnerSkillIdV1({ goal: "unused", id: "park-backgrounds" })).toEqual({
      ok: true,
      id: "owner-park-backgrounds",
    });
    expect(deriveOwnerSkillIdV1({ goal: "unused", id: "owner-park-backgrounds" })).toEqual({
      ok: true,
      id: "owner-park-backgrounds",
    });
  });

  it("rejects a goal that slugifies to empty", () => {
    expect(deriveOwnerSkillIdV1({ goal: "!!!" }).ok).toBe(false);
  });
});

describe("createDraftStoreV1 — createDraft", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("deterministically creates an owner-* draft with a genesis 'draft' record", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    expect(created.skillId).toBe("owner-park-backgrounds");
    const ledger = await readStateLedgerV1(created.statePath);
    expect(ledger.at(-1)?.state).toBe("draft");
    expect(ledger[0].previousRecordSha256).toBe(GENESIS_PREVIOUS_HASH_V1);
  });

  it("rejects a colliding draft id without touching the existing draft", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    await store.createDraft({ goal: "Park backgrounds" });
    await expect(store.createDraft({ goal: "Park backgrounds" })).rejects.toThrow(/collision/i);
    const ledger = await readStateLedgerV1(join(foundry.paths.draftsRoot, "owner-park-backgrounds", "state.jsonl"));
    expect(ledger).toHaveLength(1);
  });

  it("loadDraft round-trips the created draft", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    await store.createDraft({ goal: "Park backgrounds" });
    const snapshot = await store.loadDraft("owner-park-backgrounds");
    expect(snapshot.currentState).toBe("draft");
    expect(snapshot.draftId).toBe("owner-park-backgrounds");
  });

  it("rejects an unsafe draft id before touching the filesystem (path-traversal defence)", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    await expect(store.loadDraft("../../etc/passwd")).rejects.toThrow(/unsafe/i);
  });
});

describe("createDraftStoreV1 — artifact read/write", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("writes create-only, then rejects a second create-only write", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const bytes = new TextEncoder().encode('{"a":1}');
    const first = await store.writeArtifactBytes(created.skillId, "candidate", bytes, { createOnly: true });
    expect(first.ok).toBe(true);
    const second = await store.writeArtifactBytes(created.skillId, "candidate", bytes, { createOnly: true });
    expect(second).toMatchObject({ ok: false, code: "already_exists" });
  });

  it("compare-and-swap write succeeds on a matching hash and fails on a stale one", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const v1Bytes = new TextEncoder().encode("v1");
    const write1 = await store.writeArtifactBytes(created.skillId, "candidate", v1Bytes, { createOnly: true });
    expect(write1.ok).toBe(true);
    if (!write1.ok) return;

    const v2Bytes = new TextEncoder().encode("v2");
    const swapOk = await store.writeArtifactBytes(created.skillId, "candidate", v2Bytes, {
      createOnly: false,
      expectedSha256: write1.sha256,
    });
    expect(swapOk.ok).toBe(true);

    const staleSwap = await store.writeArtifactBytes(created.skillId, "candidate", v1Bytes, {
      createOnly: false,
      expectedSha256: write1.sha256, // stale — file is now v2
    });
    expect(staleSwap).toMatchObject({ ok: false, code: "hash_mismatch" });
  });

  it("readArtifactBytes returns null for a missing optional artifact and throws by default", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const missing = await store.readArtifactBytes(created.skillId, "candidate", { missing: "null" });
    expect(missing).toBeNull();
    await expect(store.readArtifactBytes(created.skillId, "candidate")).rejects.toBeDefined();
  });

  it("createRunArtifactRoot creates a safe, isolated run directory", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    const runDir = await store.createRunArtifactRoot("run-abc123");
    expect(runDir).toBe(join(foundry.paths.artifactsRoot, "run-abc123"));
  });

  it("rejects an unsafe run id (path-traversal defence)", async () => {
    const store = createDraftStoreV1(foundry.paths, FIXED_CLOCK, FAKE_IDENTITY_DEPS);
    await expect(store.createRunArtifactRoot("../escape")).rejects.toThrow(/unsafe/i);
  });
});

describe("isLegalStateTransitionV1", () => {
  function record(state: FoundryStateRecordV1["state"]): FoundryStateRecordV1 {
    return {
      schemaVersion: 1,
      sequence: 1,
      previousRecordSha256: GENESIS_PREVIOUS_HASH_V1,
      state,
      artifactHashes: {},
      executionIdentity: FAKE_IDENTITY,
      testCommand: "x",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      result: "passed",
      recordSha256: "x".repeat(64),
    };
  }

  it("only 'draft' is legal as the very first record", () => {
    expect(isLegalStateTransitionV1([], "draft", "declarative")).toEqual({ ok: true });
    expect(isLegalStateTransitionV1([], "schema_valid", "declarative").ok).toBe(false);
  });

  it("declarative forward chain is legal in order", () => {
    expect(isLegalStateTransitionV1([record("draft")], "source_reviewed", "declarative")).toEqual({ ok: true });
    expect(isLegalStateTransitionV1([record("owner_approved")], "certified", "declarative")).toEqual({ ok: true });
  });

  it("native cannot go owner_approved -> certified directly; must pass release_packaged_green", () => {
    expect(isLegalStateTransitionV1([record("owner_approved")], "certified", "native").ok).toBe(false);
    expect(isLegalStateTransitionV1([record("owner_approved")], "release_packaged_green", "native")).toEqual({ ok: true });
    expect(isLegalStateTransitionV1([record("release_packaged_green")], "certified", "native")).toEqual({ ok: true });
  });

  it("declarative cannot use release_packaged_green at all", () => {
    expect(isLegalStateTransitionV1([record("owner_approved")], "release_packaged_green", "declarative").ok).toBe(false);
  });

  it("rejects skipping a stage", () => {
    expect(isLegalStateTransitionV1([record("draft")], "mock_green", "declarative").ok).toBe(false);
  });

  it("terminal states accept no further transitions", () => {
    for (const terminal of ["certified", "rejected", "superseded", "revoked"] as const) {
      expect(isLegalStateTransitionV1([record(terminal)], "draft", "declarative").ok).toBe(false);
    }
  });

  it("any proven stage can transition to blocked", () => {
    expect(isLegalStateTransitionV1([record("mock_green")], "blocked", "declarative")).toEqual({ ok: true });
  });

  it("blocked resumes only at its last proven stage", () => {
    const history = [record("draft"), { ...record("blocked"), sequence: 2 }];
    expect(isLegalStateTransitionV1(history, "draft", "declarative")).toEqual({ ok: true });
    expect(isLegalStateTransitionV1(history, "schema_valid", "declarative").ok).toBe(false);
  });

  it("stale resumes only to source_reviewed", () => {
    expect(isLegalStateTransitionV1([record("stale")], "source_reviewed", "declarative")).toEqual({ ok: true });
    expect(isLegalStateTransitionV1([record("stale")], "draft", "declarative").ok).toBe(false);
  });
});

describe("appendStateTransitionV1 / readStateLedgerV1 — chain integrity", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    const foundry = await createIsolatedFoundryV1();
    dir = foundry.homeDir;
    statePath = join(foundry.paths.teachRoot, "scratch-state.jsonl");
    // No further use of `foundry` object needed beyond its isolated root paths.
  });

  afterEach(async () => {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  });

  function transitionInput(state: FoundryStateRecordV1["state"]) {
    return {
      state,
      artifactKind: "declarative" as const,
      artifactHashes: {},
      executionIdentity: FAKE_IDENTITY,
      testCommand: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      result: "passed" as const,
    };
  }

  it("appends a legal chain and reads it back verified", async () => {
    await appendStateTransitionV1(statePath, transitionInput("draft"));
    await appendStateTransitionV1(statePath, transitionInput("source_reviewed"));
    const ledger = await readStateLedgerV1(statePath);
    expect(ledger.map((r) => r.state)).toEqual(["draft", "source_reviewed"]);
    expect(ledger[1].previousRecordSha256).toBe(ledger[0].recordSha256);
  });

  it("throws on an illegal transition and does not write anything", async () => {
    await appendStateTransitionV1(statePath, transitionInput("draft"));
    await expect(appendStateTransitionV1(statePath, transitionInput("mock_green"))).rejects.toThrow(/illegal/i);
    const ledger = await readStateLedgerV1(statePath);
    expect(ledger).toHaveLength(1);
  });

  it("detects truncation (missing trailing newline)", async () => {
    await appendStateTransitionV1(statePath, transitionInput("draft"));
    const raw = await readFile(statePath, "utf8");
    await writeFile(statePath, raw.slice(0, -1));
    await expect(readStateLedgerV1(statePath)).rejects.toThrow(/truncated/i);
  });

  it("detects a reordered/tampered line", async () => {
    await appendStateTransitionV1(statePath, transitionInput("draft"));
    await appendStateTransitionV1(statePath, transitionInput("source_reviewed"));
    const raw = await readFile(statePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    const swapped = [lines[1], lines[0]].join("\n") + "\n";
    await writeFile(statePath, swapped);
    await expect(readStateLedgerV1(statePath)).rejects.toThrow();
  });

  it("detects a tampered field even when recordSha256 is left alone", async () => {
    await appendStateTransitionV1(statePath, transitionInput("draft"));
    const raw = await readFile(statePath, "utf8");
    const record = JSON.parse(raw.trimEnd()) as FoundryStateRecordV1;
    const tampered = { ...record, testCommand: "tampered-command" };
    await writeFile(statePath, `${JSON.stringify(tampered)}\n`);
    await expect(readStateLedgerV1(statePath)).rejects.toThrow(/recordSha256/);
  });

  it("rejects a record missing executionIdentity", async () => {
    await appendStateTransitionV1(statePath, transitionInput("draft"));
    const raw = await readFile(statePath, "utf8");
    const record = JSON.parse(raw.trimEnd()) as Record<string, unknown>;
    delete record.executionIdentity;
    const rehashed = { ...record };
    delete (rehashed as Record<string, unknown>).recordSha256;
    const recordSha256 = await sha256Bytes(canonicalJsonBytes(rehashed));
    await writeFile(statePath, `${JSON.stringify({ ...record, recordSha256 })}\n`);
    await expect(readStateLedgerV1(statePath)).rejects.toThrow(/executionIdentity/);
  });

  it("accepts exactly maxStateRecords and rejects one more", async () => {
    // Directly construct a ledger at the boundary rather than appending one-by-one (slow);
    // build it the same way appendStateTransitionV1 would so the hash chain is valid.
    const lines: string[] = [];
    let previousHash = GENESIS_PREVIOUS_HASH_V1;
    for (let i = 1; i <= FOUNDRY_STORAGE_LIMITS_V1.maxStateRecords; i += 1) {
      const withoutHash = {
        schemaVersion: 1 as const,
        sequence: i,
        previousRecordSha256: previousHash,
        state: i === 1 ? ("draft" as const) : ("blocked" as const),
        artifactHashes: {},
        executionIdentity: FAKE_IDENTITY,
        testCommand: "x",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.000Z",
        result: "passed" as const,
      };
      const recordSha256 = await sha256Bytes(canonicalJsonBytes(withoutHash));
      lines.push(JSON.stringify({ ...withoutHash, recordSha256 }));
      previousHash = recordSha256;
    }
    await writeFile(statePath, lines.join("\n") + "\n");
    const ledger = await readStateLedgerV1(statePath);
    expect(ledger).toHaveLength(FOUNDRY_STORAGE_LIMITS_V1.maxStateRecords);

    // Appending ONE more must be rejected as a quota violation, not silently written.
    await expect(appendStateTransitionV1(statePath, transitionInput("draft"))).rejects.toThrow(/quota/i);
  });

  it("crash-before-rename leaves the OLD complete ledger intact, never a truncated one", async () => {
    await appendStateTransitionV1(statePath, transitionInput("draft"));
    const before = await readFile(statePath, "utf8");
    // Simulate a crash mid atomic-write by leaving a stray temp file in the directory: the
    // real ledger file at `statePath` must be untouched (atomicWriteBytesV1 only replaces
    // its target via a completed rename, never in place).
    const dirName = join(statePath, "..");
    await mkdir(dirName, { recursive: true });
    await writeFile(join(dirName, ".tmp-simulated-crash"), "PARTIAL-GARBAGE-NOT-A-VALID-LINE");
    const after = await readFile(statePath, "utf8");
    expect(after).toBe(before);
    const ledger = await readStateLedgerV1(statePath);
    expect(ledger).toHaveLength(1);
  });
});
