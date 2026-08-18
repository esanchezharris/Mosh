// Task 8 — the seven-phase atomic declarative executor.
//
// Exercises `executeDeclarativeSkillV1` against a small, deterministic in-memory transaction
// engine (`FakeEngine`) that implements the real `batch_begin`/`batch_status`/`batch_rollback`/
// `batch_end` protocol shape `atomicPlan.ts` depends on, plus `list_plugins` and the mutation
// commands the V1 catalog closes over. This lets every scenario — happy path, ambiguity,
// confirmation (never/always/on_ambiguity), drift, rollback, timeout, and the expansion caps —
// be driven precisely and deterministically, with injected `nowMs`/`newId`, never a real
// wall-clock wait.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, Track } from "../../types";
import { createContinuationStoreV1 } from "./continuations";
import type {
  PredicateV1,
  SkillManifestV1,
  SkillSlotV1,
  SkillSourceStatusReadV1,
  SkillStepV1,
  StudioSkillEnvironmentV1,
} from "./contracts";
import { executeDeclarativeSkillV1, type DeclarativeExecutionInputV1 } from "./declarativeExecutor";
import type { ValidatedDeclarativeSkillV1 } from "./packageValidation";

// ---------------------------------------------------------------------------------------
// FakeEngine — a small, faithful-enough simulation of the MoshOps batch-transaction protocol.
// ---------------------------------------------------------------------------------------

type FakeBridgeResult = { readonly ok: boolean; readonly error?: string; readonly data?: unknown };

type FakeTxn = {
  status: "open" | "committed" | "rolled_back" | "needs_recovery";
  manifestCount: number;
  applied: number;
  entries: { index: number; requestId: string; command: string; state: "pending" | "applied" | "failed"; result?: FakeBridgeResult }[];
  preFingerprint: string;
  fingerprint?: string;
  canCommit: boolean;
  canRollback: boolean;
  preTracks: Track[];
};

class FakeEngine {
  tracks: Track[];
  plugins: { id: string; name: string; format: string; manufacturer: string; isInstrument: boolean }[] = [];
  selectedTrackId: string | null;
  projectEpoch = 1;
  recording = false;
  stateVersion = 0;
  private readonly txns = new Map<string, FakeTxn>();
  /** Command name to fail exactly once (its own return, not a rejection). */
  failCommandOnce: string | null = null;
  /** Source-status generation returned on each successive `readSourceStatus()` call. */
  sourceStatusGenerations: readonly number[] = [];
  private sourceStatusCallIndex = 0;
  readonly batchBeginCalls: { transactionId: string; name: string; commands: readonly { index: number; requestId: string; command: string }[] }[] = [];

  constructor(tracks: Track[], selectedTrackId: string | null) {
    this.tracks = tracks;
    this.selectedTrackId = selectedTrackId;
  }

  private fingerprint(): string {
    return `v${this.stateVersion}`;
  }

  snapshot(): Snapshot {
    return {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "x" },
      tracks: this.tracks.map((t) => ({ ...t })),
      controller: this.recording
        ? { mode: "capture", record: "recording", take: { exists: false }, agent: "idle" }
        : undefined,
    } as unknown as Snapshot;
  }

  context(): { projectEpoch: number; selectedTrackId: string | null; tracks: readonly { id: string; name: string }[] } {
    return {
      projectEpoch: this.projectEpoch,
      selectedTrackId: this.selectedTrackId,
      tracks: this.tracks.map((t) => ({ id: t.id, name: t.name })),
    };
  }

  async readSourceStatus(): Promise<SkillSourceStatusReadV1> {
    if (this.sourceStatusGenerations.length === 0) {
      return { schemaVersion: 1, ok: true, statusIndex: null, diagnostics: [] };
    }
    const idx = Math.min(this.sourceStatusCallIndex, this.sourceStatusGenerations.length - 1);
    this.sourceStatusCallIndex += 1;
    const generation = this.sourceStatusGenerations[idx]!;
    const utf8 = JSON.stringify({ schemaVersion: 1, generation, updatedAt: "2026-01-01T00:00:00.000Z", entries: [] });
    return {
      schemaVersion: 1, ok: true,
      statusIndex: { name: "source-status.json", bytes: utf8.length, sha256: "0".repeat(64), utf8 },
      diagnostics: [],
    };
  }

  private applyMutation(command: string, args: Record<string, unknown>): FakeBridgeResult {
    if (command === "set_track_volume") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.volumeDb = args.db as number;
      return { ok: true };
    }
    if (command === "set_track_mute") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.mute = args.mute as boolean;
      return { ok: true };
    }
    if (command === "set_track_solo") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.solo = args.solo as boolean;
      return { ok: true };
    }
    if (command === "load_plugin") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.plugins = [...(track.plugins ?? []), {
        index: (track.plugins?.length ?? 0), name: "plugin", type: "vst3", enabled: true, external: true,
        isInstrument: false, params: [], catalogId: args.pluginId as string,
      }];
      return { ok: true };
    }
    return { ok: false, error: `unknown command ${command}` };
  }

  async exec(command: string, args: Record<string, unknown>, transaction?: { transactionId: string; requestId: string; index: number }): Promise<FakeBridgeResult> {
    if (command === "list_plugins") return { ok: true, data: { plugins: this.plugins } };

    if (command === "batch_begin") {
      const transactionId = args.transactionId as string;
      const commands = args.commands as { index: number; requestId: string; command: string }[];
      this.batchBeginCalls.push({ transactionId, name: args.name as string, commands });
      const preFingerprint = this.fingerprint();
      const txn: FakeTxn = {
        status: "open", manifestCount: commands.length, applied: 0,
        entries: commands.map((c) => ({ index: c.index, requestId: c.requestId, command: c.command, state: "pending" as const })),
        preFingerprint, canCommit: false, canRollback: true,
        preTracks: this.tracks.map((t) => ({ ...t })),
      };
      this.txns.set(transactionId, txn);
      return { ok: true, data: { found: true, transactionId, status: "open", manifestCount: commands.length, applied: 0, canCommit: false, canRollback: true, preFingerprint } };
    }

    if (command === "batch_status") {
      const txn = this.txns.get(args.transactionId as string);
      if (!txn) return { ok: true, data: { found: false } };
      return {
        ok: true,
        data: {
          found: true, transactionId: args.transactionId, status: txn.status, manifestCount: txn.manifestCount,
          applied: txn.applied, canCommit: txn.canCommit, canRollback: txn.canRollback,
          preFingerprint: txn.preFingerprint, fingerprint: txn.fingerprint,
          entries: txn.entries.map((e) => ({ index: e.index, requestId: e.requestId, command: e.command, state: e.state, result: e.result })),
        },
      };
    }

    if (command === "batch_rollback") {
      const txn = this.txns.get(args.transactionId as string);
      if (!txn) return { ok: false, error: "unknown transaction" };
      this.tracks = txn.preTracks.map((t) => ({ ...t }));
      txn.status = "rolled_back";
      txn.fingerprint = txn.preFingerprint;
      txn.canRollback = false;
      return { ok: true };
    }

    if (command === "batch_end") {
      const txn = this.txns.get(args.transactionId as string);
      if (!txn) return { ok: false, error: "unknown transaction" };
      if (txn.applied !== txn.manifestCount || !txn.canCommit) return { ok: false, error: "not ready to commit" };
      txn.status = "committed";
      txn.fingerprint = this.fingerprint();
      return { ok: true, data: { found: true, status: "committed" } };
    }

    // A mutation command riding inside a transaction.
    if (!transaction) return { ok: false, error: "mutation without a transaction" };
    const txn = this.txns.get(transaction.transactionId);
    if (!txn) return { ok: false, error: "unknown transaction" };
    const entry = txn.entries.find((e) => e.requestId === transaction.requestId);
    if (this.failCommandOnce === command) {
      this.failCommandOnce = null;
      const result: FakeBridgeResult = { ok: false, error: `${command} refused` };
      if (entry) { entry.state = "failed"; entry.result = result; }
      return result;
    }
    const result = this.applyMutation(command, args);
    if (result.ok) this.stateVersion += 1;
    if (entry) { entry.state = result.ok ? "applied" : "failed"; entry.result = result; }
    if (result.ok) {
      txn.applied += 1;
      if (txn.applied === txn.manifestCount) txn.canCommit = true;
    }
    return result;
  }
}

function track(overrides: Partial<Track> = {}): Track {
  return { id: "track-1", index: 0, name: "Bass", type: "audio", clips: [], ...overrides };
}

function environmentFor(engine: FakeEngine): StudioSkillEnvironmentV1 {
  return {
    context: () => engine.context(),
    snapshot: async () => engine.snapshot(),
    exec: (command, args, transaction) => engine.exec(command, args as Record<string, unknown>, transaction),
    readSourceStatus: () => engine.readSourceStatus(),
    runBatch: async () => ({ label: "", entries: [], applied: 0 }),
    refresh: async () => {},
    recording: {
      start: async () => ({ ok: true, state: "recording", say: "", changes: null }),
      stop: async () => ({ ok: true, state: "idle", say: "", changes: null }),
      audition: async () => ({ ok: true, state: "idle", say: "", changes: null }),
      keep: async () => ({ ok: true, state: "idle", say: "", changes: null }),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Manifest fixtures
// ---------------------------------------------------------------------------------------

function slot(overrides: Partial<SkillSlotV1>): SkillSlotV1 {
  return { name: "x", type: "string", required: false, source: "utterance", description: "x", ...overrides };
}

const HASH64 = "a".repeat(64);

function manifest(overrides: Partial<SkillManifestV1> = {}): SkillManifestV1 {
  return {
    schemaVersion: 1, id: "owner-set-volume", version: "1.0.0", title: "Set Volume",
    description: "Set the selected track's volume.", implementation: "declarative",
    intents: { positiveExamples: [], negativeExamples: [], tags: [] },
    slots: [],
    preconditions: [],
    steps: [
      { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
      { kind: "mutate", command: "set_track_volume", args: { trackId: { binding: "track" }, db: { literal: -6 } } },
    ],
    postconditions: [{ name: "track_volume_equals", args: { trackId: { binding: "track" }, db: { literal: -6 } } }],
    execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 5000 },
    responses: { completed: "done", needsChoice: "which one?", blocked: "couldn't do that" },
    provenance: [],
    compatibility: { minMoshVersion: "0.0.0", commandCatalogSha256: HASH64, predicateCatalogVersion: 1, resolverCatalogVersion: 1 },
    ...overrides,
  };
}

function validated(m: SkillManifestV1): ValidatedDeclarativeSkillV1 {
  return {
    id: m.id, version: m.version, manifest: m,
    manifestSha256: HASH64, certificationReportSha256: HASH64, approvalSha256: HASH64, releaseSha256: HASH64,
  };
}

function baseInput(engine: FakeEngine, m: SkillManifestV1, overrides: Partial<DeclarativeExecutionInputV1> = {}): DeclarativeExecutionInputV1 {
  let clock = 0;
  let counter = 0;
  return {
    skill: validated(m),
    utteranceSlots: {},
    environment: environmentFor(engine),
    continuations: createContinuationStoreV1({ now: () => clock }),
    registryGeneration: 1,
    newId: () => `id-${(counter += 1)}`,
    nowMs: () => clock,
    ...overrides,
  };
}

describe("executeDeclarativeSkillV1", () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine([track({ id: "track-1", name: "Bass", volumeDb: 0 })], "track-1");
  });

  // ---------------------------------------------------------------------------------------
  // Happy path / phase order
  // ---------------------------------------------------------------------------------------

  it("commits the mutation, runs preconditions/postconditions, and reports completed", async () => {
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, manifest()));
    expect(outcome).toMatchObject({ kind: "completed", skill: "owner-set-volume", version: "1.0.0", say: "done" });
    expect(engine.tracks[0]!.volumeDb).toBe(-6);
  });

  it("`never` proceeds straight through with zero continuations issued", async () => {
    const issueSpy = vi.fn();
    const input = baseInput(engine, manifest());
    const realIssue = input.continuations.issue.bind(input.continuations);
    input.continuations.issue = (payload) => { issueSpy(); return realIssue(payload); };
    const outcome = await executeDeclarativeSkillV1(input);
    expect(outcome.kind).toBe("completed");
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it("only mutation commands ever reach batch_begin.commands — never observe/resolve", async () => {
    const m = manifest({
      steps: [
        { kind: "observe", command: "current_snapshot", args: {}, bind: "snap" },
        { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
        { kind: "mutate", command: "set_track_volume", args: { trackId: { binding: "track" }, db: { literal: -6 } } },
      ],
    });
    await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(engine.batchBeginCalls).toHaveLength(1);
    const commands = engine.batchBeginCalls[0]!.commands.map((c) => c.command);
    expect(commands).toEqual(["set_track_volume"]);
  });

  // ---------------------------------------------------------------------------------------
  // Slots: defaults, missing required, invalid
  // ---------------------------------------------------------------------------------------

  it("fills a missing slot from its default", async () => {
    const m = manifest({
      slots: [slot({ name: "db", type: "number", required: true, default: -9 })],
      steps: [
        { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
        { kind: "mutate", command: "set_track_volume", args: { trackId: { binding: "track" }, db: { slot: "db" } } },
      ],
      postconditions: [{ name: "track_volume_equals", args: { trackId: { binding: "track" }, db: { slot: "db" } } }],
    });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome.kind).toBe("completed");
    expect(engine.tracks[0]!.volumeDb).toBe(-9);
  });

  it("blocks with missing_slot for a required free-form slot with no default and no bounded choice set", async () => {
    const m = manifest({ slots: [slot({ name: "note", type: "string", required: true })] });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({ kind: "blocked", code: "missing_slot" });
  });

  it("offers a bounded choice for a required boolean slot with no default", async () => {
    const m = manifest({ slots: [slot({ name: "confirm", type: "boolean", required: true })] });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({ kind: "needs_choice", options: [{ label: "yes" }, { label: "no" }] });
  });

  it("rejects an out-of-bounds numeric slot as invalid_slot", async () => {
    const m = manifest({
      slots: [slot({ name: "db", type: "number", required: true, minimum: -60, maximum: 6 })],
    });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m, { utteranceSlots: { db: 100 } }));
    expect(outcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
  });

  // ---------------------------------------------------------------------------------------
  // Resolvers: track_by_unique_name ambiguity, missing target
  // ---------------------------------------------------------------------------------------

  it("blocks missing_target when the resolver finds nothing", async () => {
    const m = manifest({
      slots: [slot({ name: "trackName", type: "string", required: true })],
      steps: [
        { kind: "resolve", resolver: "track_by_unique_name", input: { slot: "trackName" }, bind: "track", maxChoices: 5 },
        { kind: "mutate", command: "set_track_mute", args: { trackId: { binding: "track" }, mute: { literal: true } } },
      ],
    });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m, { utteranceSlots: { trackName: "Drums" } }));
    expect(outcome).toMatchObject({ kind: "blocked", code: "missing_target" });
  });

  it("pauses with needs_choice on an ambiguous resolver match, and resumes when the reply picks one", async () => {
    engine.tracks.push(track({ id: "track-2", name: "Bass", volumeDb: 0 }));
    const m = manifest({
      slots: [slot({ name: "trackName", type: "string", required: true })],
      steps: [
        { kind: "resolve", resolver: "track_by_unique_name", input: { slot: "trackName" }, bind: "track", maxChoices: 5 },
        { kind: "mutate", command: "set_track_mute", args: { trackId: { binding: "track" }, mute: { literal: true } } },
      ],
      postconditions: [],
    });
    const input = baseInput(engine, m, { utteranceSlots: { trackName: "Bass" } });
    const first = await executeDeclarativeSkillV1(input);
    expect(first).toMatchObject({ kind: "needs_choice", options: [{ id: "1" }, { id: "2" }] });
    if (first.kind !== "needs_choice") throw new Error("unreachable");

    const resumed = await executeDeclarativeSkillV1({ ...input, continuationToken: first.continuationToken, reply: "1" });
    expect(resumed.kind).toBe("completed");
    expect(engine.tracks[0]!.mute).toBe(true);
    expect(engine.tracks[1]!.mute).toBeUndefined();
  });

  it("terminally blocks after three unmatched replies to a choice, without ever mutating", async () => {
    engine.tracks.push(track({ id: "track-2", name: "Bass" }));
    const m = manifest({
      slots: [slot({ name: "trackName", type: "string", required: true })],
      steps: [
        { kind: "resolve", resolver: "track_by_unique_name", input: { slot: "trackName" }, bind: "track", maxChoices: 5 },
        { kind: "mutate", command: "set_track_mute", args: { trackId: { binding: "track" }, mute: { literal: true } } },
      ],
      postconditions: [],
    });
    const input = baseInput(engine, m, { utteranceSlots: { trackName: "Bass" } });
    let outcome = await executeDeclarativeSkillV1(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (outcome.kind !== "needs_choice") throw new Error(`unreachable at attempt ${attempt}`);
      outcome = await executeDeclarativeSkillV1({ ...input, continuationToken: outcome.continuationToken, reply: "nonsense" });
    }
    expect(outcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
    expect(engine.tracks[0]!.mute).toBeUndefined();
    expect(engine.tracks[1]!.mute).toBeUndefined();
  });

  // ---------------------------------------------------------------------------------------
  // Confirmation modes
  // ---------------------------------------------------------------------------------------

  it("`always` returns needs_choice with confirm/cancel and makes zero bridge mutations", async () => {
    const execSpy = vi.spyOn(engine, "exec");
    const m = manifest({ execution: { mode: "atomic", confirmation: "always", maxMutations: 1, timeoutMs: 5000 } });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({
      kind: "needs_choice",
      options: [{ id: "confirm", label: "Apply" }, { id: "cancel", label: "Cancel" }],
      continuationToken: expect.any(String),
    });
    expect(execSpy).not.toHaveBeenCalled();
    expect(engine.tracks[0]!.volumeDb).toBe(0);
  });

  it("`always` executes only after a matching confirm reply", async () => {
    const m = manifest({ execution: { mode: "atomic", confirmation: "always", maxMutations: 1, timeoutMs: 5000 } });
    const input = baseInput(engine, m);
    const first = await executeDeclarativeSkillV1(input);
    if (first.kind !== "needs_choice") throw new Error("unreachable");
    const resumed = await executeDeclarativeSkillV1({ ...input, continuationToken: first.continuationToken, reply: "confirm" });
    expect(resumed.kind).toBe("completed");
    expect(engine.tracks[0]!.volumeDb).toBe(-6);
  });

  it("cancel returns blocked/unsupported_intent and mutates nothing", async () => {
    const m = manifest({ execution: { mode: "atomic", confirmation: "always", maxMutations: 1, timeoutMs: 5000 } });
    const input = baseInput(engine, m);
    const first = await executeDeclarativeSkillV1(input);
    if (first.kind !== "needs_choice") throw new Error("unreachable");
    const resumed = await executeDeclarativeSkillV1({ ...input, continuationToken: first.continuationToken, reply: "cancel" });
    expect(resumed).toMatchObject({ kind: "blocked", code: "unsupported_intent" });
    expect(engine.tracks[0]!.volumeDb).toBe(0);
  });

  it("a stale confirmation (plan changed since it was issued) never mutates", async () => {
    const m = manifest({
      slots: [slot({ name: "db", type: "number", required: false, default: -6, minimum: -60, maximum: 6 })],
      steps: [
        { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
        { kind: "mutate", command: "set_track_volume", args: { trackId: { binding: "track" }, db: { slot: "db" } } },
      ],
      postconditions: [],
      execution: { mode: "atomic", confirmation: "always", maxMutations: 1, timeoutMs: 5000 },
    });
    const input = baseInput(engine, m);
    const first = await executeDeclarativeSkillV1(input);
    if (first.kind !== "needs_choice") throw new Error("unreachable");
    // Resume with a DIFFERENT slot value than what was confirmed — the recomputed digest
    // must not match, so nothing may mutate.
    const resumed = await executeDeclarativeSkillV1({
      ...input, continuationToken: first.continuationToken, reply: "confirm", utteranceSlots: { db: -20 },
    });
    expect(resumed).toMatchObject({ kind: "blocked", code: "stale_context" });
    expect(engine.tracks[0]!.volumeDb).toBe(0);
  });

  it("`on_ambiguity` proceeds without confirmation when resolution was unambiguous", async () => {
    const m = manifest({ execution: { mode: "atomic", confirmation: "on_ambiguity", maxMutations: 1, timeoutMs: 5000 } });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome.kind).toBe("completed");
  });

  it("`on_ambiguity` requires confirmation only after an ambiguity was actually resolved", async () => {
    engine.tracks.push(track({ id: "track-2", name: "Bass" }));
    const m = manifest({
      slots: [slot({ name: "trackName", type: "string", required: true })],
      steps: [
        { kind: "resolve", resolver: "track_by_unique_name", input: { slot: "trackName" }, bind: "track", maxChoices: 5 },
        { kind: "mutate", command: "set_track_mute", args: { trackId: { binding: "track" }, mute: { literal: true } } },
      ],
      postconditions: [],
      execution: { mode: "atomic", confirmation: "on_ambiguity", maxMutations: 1, timeoutMs: 5000 },
    });
    const input = baseInput(engine, m, { utteranceSlots: { trackName: "Bass" } });
    const first = await executeDeclarativeSkillV1(input);
    expect(first).toMatchObject({ kind: "needs_choice", options: [{ id: "1" }, { id: "2" }] });
    if (first.kind !== "needs_choice") throw new Error("unreachable");

    const resumed = await executeDeclarativeSkillV1({ ...input, continuationToken: first.continuationToken, reply: "1" });
    // The choice was consumed, but nothing mutated yet — a SECOND continuation (confirmation)
    // must be issued, because this "needs_choice" was reached via an ambiguity.
    expect(resumed).toMatchObject({ kind: "needs_choice", options: [{ id: "confirm" }, { id: "cancel" }] });
    expect(engine.tracks[0]!.mute).toBeUndefined();

    if (resumed.kind !== "needs_choice") throw new Error("unreachable");
    const confirmed = await executeDeclarativeSkillV1({ ...input, continuationToken: resumed.continuationToken, reply: "confirm" });
    expect(confirmed.kind).toBe("completed");
    expect(engine.tracks[0]!.mute).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // Preconditions
  // ---------------------------------------------------------------------------------------

  it("blocks on a failing precondition before any mutation", async () => {
    const pre: PredicateV1 = { name: "track_volume_equals", args: { trackId: { binding: "track" }, db: { literal: -99 } } };
    const m = manifest({ preconditions: [pre] });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
    expect(engine.tracks[0]!.volumeDb).toBe(0);
  });

  it("not_recording precondition blocks while a take is recording", async () => {
    engine.recording = true;
    const m = manifest({ preconditions: [{ name: "not_recording", args: {} }] });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context" });
  });

  // ---------------------------------------------------------------------------------------
  // Command failure, postcondition failure, and rollback proof
  // ---------------------------------------------------------------------------------------

  it("rolls back to the exact pre-state on a command failure and reports command_failed", async () => {
    engine.failCommandOnce = "set_track_volume";
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, manifest()));
    expect(outcome).toMatchObject({ kind: "blocked", code: "command_failed", unserved: false });
    expect(engine.tracks[0]!.volumeDb).toBe(0); // restored
  });

  it("rolls back and reports postcondition_failed when the postcondition disagrees with reality", async () => {
    const m = manifest({
      postconditions: [{ name: "track_volume_equals", args: { trackId: { binding: "track" }, db: { literal: -999 } } }],
    });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({ kind: "blocked", code: "postcondition_failed", unserved: false });
    expect(engine.tracks[0]!.volumeDb).toBe(0); // restored
  });

  // ---------------------------------------------------------------------------------------
  // Drift: epoch and target staleness caught by the before_begin/before_commit guards
  // ---------------------------------------------------------------------------------------

  it("blocks stale_context (no_edit, no attempt) when the project epoch drifts before before_begin even runs", async () => {
    // Bump the epoch on the SECOND `context()` read: preflight's own capture is the first
    // read, and the before_begin guard's re-read is the second — so the guard sees drift
    // before `batch_begin` (or any mutation) is ever called.
    let contextCalls = 0;
    const baseEnv = environmentFor(engine);
    const environment: StudioSkillEnvironmentV1 = {
      ...baseEnv,
      context: () => {
        contextCalls += 1;
        if (contextCalls === 2) engine.projectEpoch += 1;
        return baseEnv.context();
      },
    };
    const execSpy = vi.spyOn(engine, "exec");
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, manifest(), { environment }));
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context", unserved: true });
    expect(execSpy).not.toHaveBeenCalled(); // before_begin guard rejected before batch_begin
    expect(engine.tracks[0]!.volumeDb).toBe(0);
  });

  it("blocks stale_context (restored, an attempt was made) when the project epoch drifts before before_commit", async () => {
    const realExec = engine.exec.bind(engine);
    const bumpOnBegin = vi.fn(async (command: string, args: Record<string, unknown>, transaction?: { transactionId: string; requestId: string; index: number }) => {
      if (command === "batch_begin") engine.projectEpoch += 1; // drifts AFTER before_begin already passed
      return realExec(command, args, transaction);
    });
    engine.exec = bumpOnBegin;
    const input = baseInput(engine, manifest(), { environment: environmentFor(engine) });
    const outcome = await executeDeclarativeSkillV1(input);
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context", unserved: false });
    expect(engine.tracks[0]!.volumeDb).toBe(0); // rolled back exactly
  });

  it("blocks stale_context when the resolved track is renamed away between preflight and before_commit", async () => {
    const m = manifest({
      slots: [slot({ name: "trackName", type: "string", required: true })],
      steps: [
        { kind: "resolve", resolver: "track_by_unique_name", input: { slot: "trackName" }, bind: "track", maxChoices: 5 },
        { kind: "mutate", command: "set_track_volume", args: { trackId: { binding: "track" }, db: { literal: -6 } } },
      ],
      postconditions: [],
    });
    const realExec = engine.exec.bind(engine);
    engine.exec = async (command, args, transaction) => {
      const result = await realExec(command, args, transaction);
      // Rename the track out from under the resolved "Bass" match right after the mutation
      // applies, so before_commit's re-resolution of track_by_unique_name("Bass") fails.
      if (command === "set_track_volume") engine.tracks[0]!.name = "Renamed";
      return result;
    };
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m, { utteranceSlots: { trackName: "Bass" } }));
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context", unserved: false });
    expect(engine.tracks[0]!.volumeDb).toBe(0); // restored
  });

  it("blocks manifest_stale when the source-status generation changes mid-run", async () => {
    engine.sourceStatusGenerations = [1, 2]; // preflight reads 1; before_begin guard reads 2
    const m = manifest({ provenance: [{ sourceCardId: "sc-1", claimIds: [], sourceSnapshotSha256: HASH64 }] });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({ kind: "blocked", code: "manifest_stale" });
    expect(engine.tracks[0]!.volumeDb).toBe(0);
  });

  // ---------------------------------------------------------------------------------------
  // Timeout — no new-ID retry
  // ---------------------------------------------------------------------------------------

  it("reports timeout and never calls exec when the budget is already spent before opening a transaction", async () => {
    const execSpy = vi.spyOn(engine, "exec");
    let clock = 0;
    const m = manifest({ execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 100 } });
    const input = baseInput(engine, m, { nowMs: () => { const t = clock; clock += 1000; return t; } });
    const outcome = await executeDeclarativeSkillV1(input);
    expect(outcome).toMatchObject({ kind: "blocked", code: "timeout" });
    expect(execSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------------------
  // forEach expansion, ordering, and the expanded-mutation-count / preflight-call caps
  // ---------------------------------------------------------------------------------------

  it("expands forEach over a string[] slot into one identical mutation per item, in order", async () => {
    const m = manifest({
      slots: [slot({ name: "names", type: "string[]", required: true })],
      steps: [
        { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
        { kind: "mutate", command: "set_track_solo", args: { trackId: { binding: "track" }, solo: { literal: true } }, forEach: "names" },
      ],
      postconditions: [],
      execution: { mode: "atomic", confirmation: "never", maxMutations: 3, timeoutMs: 5000 },
    });
    const input = baseInput(engine, m, { utteranceSlots: { names: ["a", "b", "c"] } });
    const outcome = await executeDeclarativeSkillV1(input);
    expect(outcome.kind).toBe("completed");
    expect(engine.batchBeginCalls[0]!.commands.map((c) => c.command)).toEqual(["set_track_solo", "set_track_solo", "set_track_solo"]);
  });

  it("accepts exactly the 32-mutation cap and rejects 33, before opening any transaction", async () => {
    const namesA = Array.from({ length: 16 }, (_, i) => `a${i}`);
    const namesB = Array.from({ length: 16 }, (_, i) => `b${i}`);

    const okManifest = manifest({
      slots: [slot({ name: "namesA", type: "string[]", required: true }), slot({ name: "namesB", type: "string[]", required: true })],
      steps: [
        { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
        { kind: "mutate", command: "set_track_solo", args: { trackId: { binding: "track" }, solo: { literal: true } }, forEach: "namesA" },
        { kind: "mutate", command: "set_track_solo", args: { trackId: { binding: "track" }, solo: { literal: false } }, forEach: "namesB" },
      ],
      postconditions: [],
      execution: { mode: "atomic", confirmation: "never", maxMutations: 32, timeoutMs: 5000 },
    });
    const okOutcome = await executeDeclarativeSkillV1(baseInput(engine, okManifest, { utteranceSlots: { namesA, namesB } }));
    expect(okOutcome.kind).toBe("completed");
    expect(engine.batchBeginCalls[0]!.commands).toHaveLength(32);

    const engine2 = new FakeEngine([track({ id: "track-1", name: "Bass" })], "track-1");
    const overManifest = manifest({
      slots: [slot({ name: "namesA", type: "string[]", required: true }), slot({ name: "namesB", type: "string[]", required: true })],
      steps: [
        { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
        { kind: "mutate", command: "set_track_solo", args: { trackId: { binding: "track" }, solo: { literal: true } }, forEach: "namesA" },
        { kind: "mutate", command: "set_track_solo", args: { trackId: { binding: "track" }, solo: { literal: false } }, forEach: "namesB" },
        { kind: "mutate", command: "set_track_mute", args: { trackId: { binding: "track" }, mute: { literal: true } } },
      ],
      postconditions: [],
      execution: { mode: "atomic", confirmation: "never", maxMutations: 33, timeoutMs: 5000 },
    });
    const overOutcome = await executeDeclarativeSkillV1(baseInput(engine2, overManifest, { utteranceSlots: { namesA, namesB } }));
    expect(overOutcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
    expect(engine2.batchBeginCalls).toHaveLength(0);
  });

  it("accepts exactly 32 preflight observation/resolver steps and rejects 33", async () => {
    const observeSteps = (n: number): SkillStepV1[] =>
      Array.from({ length: n }, (_, i) => ({ kind: "observe" as const, command: "current_snapshot", args: {}, bind: `snap${i}` }));

    const okManifest = manifest({
      steps: [...observeSteps(32), { kind: "mutate", command: "set_track_volume", args: { trackId: { context: "selectedTrackId" }, db: { literal: -6 } } }],
      postconditions: [],
    });
    const okOutcome = await executeDeclarativeSkillV1(baseInput(engine, okManifest));
    expect(okOutcome.kind).toBe("completed");

    const engine2 = new FakeEngine([track({ id: "track-1", name: "Bass" })], "track-1");
    const overManifest = manifest({
      steps: [...observeSteps(33), { kind: "mutate", command: "set_track_volume", args: { trackId: { context: "selectedTrackId" }, db: { literal: -6 } } }],
      postconditions: [],
    });
    const overOutcome = await executeDeclarativeSkillV1(baseInput(engine2, overManifest));
    expect(overOutcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
    expect(engine2.batchBeginCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------
  // ValueRefV1 sourcing: literal, slot, context, binding all resolve; each is unreachable.
  // ---------------------------------------------------------------------------------------

  it("resolves a context-sourced argument (selectedTrackId)", async () => {
    const m = manifest({
      steps: [{ kind: "mutate", command: "set_track_volume", args: { trackId: { context: "selectedTrackId" }, db: { literal: -6 } } }],
      postconditions: [],
    });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome.kind).toBe("completed");
    expect(engine.tracks[0]!.volumeDb).toBe(-6);
  });

  it("blocks missing_target when no track is selected and the target is only sourced from context", async () => {
    engine.selectedTrackId = null;
    const m = manifest({
      steps: [{ kind: "mutate", command: "set_track_volume", args: { trackId: { context: "selectedTrackId" }, db: { literal: -6 } } }],
    });
    const outcome = await executeDeclarativeSkillV1(baseInput(engine, m));
    expect(outcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
  });
});
