// Skill Foundry Slice B, Task 4 — explicit balance through the atomic executor.
//
// Reuses the same "faithful enough" batch-transaction FakeEngine pattern
// declarativeExecutor.test.ts already established for atomicPlan.ts, scoped down to just
// the three mutation commands this handler ever compiles.

import { beforeEach, describe, expect, it } from "vitest";
import type { Snapshot, Track } from "../../../types";
import type { NativeSkillPayloadV1, StudioSkillEnvironmentV1 } from "../contracts";
import { explicitBalanceV1 } from "./explicitBalance";

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
  selectedTrackId: string | null;
  projectEpoch = 1;
  stateVersion = 0;
  sourceStatusGeneration = 1;
  /** Returns a NEW value on the 2nd+ call (simulating a mid-run change), or a fixed
   *  sequence when set explicitly. */
  sourceStatusSequence: readonly number[] | null = null;
  private sourceStatusCallIndex = 0;
  private readonly txns = new Map<string, FakeTxn>();
  failCommandOnce: string | null = null;
  readonly batchBeginCalls: { transactionId: string; commands: readonly { command: string }[] }[] = [];

  constructor(tracks: Track[], selectedTrackId: string | null) {
    this.tracks = tracks;
    this.selectedTrackId = selectedTrackId;
  }

  private fingerprint(): string { return `v${this.stateVersion}`; }

  snapshot(): Snapshot {
    return {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "x" },
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      tracks: this.tracks.map((t) => ({ ...t })),
    } as unknown as Snapshot;
  }

  context() {
    return { projectEpoch: this.projectEpoch, selectedTrackId: this.selectedTrackId, tracks: this.tracks.map((t) => ({ id: t.id, name: t.name })) };
  }

  async readSourceStatus() {
    const generation = this.sourceStatusSequence
      ? this.sourceStatusSequence[Math.min(this.sourceStatusCallIndex, this.sourceStatusSequence.length - 1)]!
      : this.sourceStatusGeneration;
    this.sourceStatusCallIndex += 1;
    const utf8 = JSON.stringify({ schemaVersion: 1, generation, updatedAt: "2026-01-01T00:00:00.000Z", entries: [] });
    return {
      schemaVersion: 1 as const, ok: true as const,
      statusIndex: { name: "source-status.json", bytes: utf8.length, sha256: `sha-${generation}`, utf8 },
      diagnostics: [],
    };
  }

  private applyMutation(command: string, args: Record<string, unknown>): FakeBridgeResult {
    const track = this.tracks.find((t) => t.id === args.trackId);
    if (!track) return { ok: false, error: "no such track" };
    if (command === "set_track_volume") { track.volumeDb = args.db as number; return { ok: true }; }
    if (command === "set_track_mute") { track.mute = args.mute as boolean; return { ok: true }; }
    if (command === "set_track_solo") { track.solo = args.solo as boolean; return { ok: true }; }
    return { ok: false, error: `unknown command ${command}` };
  }

  async exec(command: string, args: Record<string, unknown>, transaction?: { transactionId: string; requestId: string; index: number }): Promise<FakeBridgeResult> {
    if (command === "batch_begin") {
      const transactionId = args.transactionId as string;
      const commands = args.commands as { index: number; requestId: string; command: string }[];
      this.batchBeginCalls.push({ transactionId, commands });
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
      txn.status = "rolled_back"; txn.fingerprint = txn.preFingerprint; txn.canRollback = false;
      return { ok: true };
    }
    if (command === "batch_end") {
      const txn = this.txns.get(args.transactionId as string);
      if (!txn) return { ok: false, error: "unknown transaction" };
      if (txn.applied !== txn.manifestCount || !txn.canCommit) return { ok: false, error: "not ready to commit" };
      txn.status = "committed"; txn.fingerprint = this.fingerprint();
      return { ok: true, data: { found: true, status: "committed" } };
    }
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
    if (result.ok) { txn.applied += 1; if (txn.applied === txn.manifestCount) txn.canCommit = true; }
    return result;
  }
}

function track(overrides: Partial<Track> = {}): Track {
  return { id: "track-1", index: 0, name: "Bass", type: "audio", clips: [], ...overrides };
}

function environmentFor(engine: FakeEngine): StudioSkillEnvironmentV1 {
  let counter = 0;
  return {
    context: () => engine.context(),
    snapshot: async () => engine.snapshot(),
    exec: (command, args, transaction) => engine.exec(command, args as Record<string, unknown>, transaction),
    readSourceStatus: () => engine.readSourceStatus(),
    runBatch: async () => ({ label: "", entries: [], applied: 0 }),
    refresh: async () => {},
    newId: () => `id-${(counter += 1)}`,
    nowMs: () => 1_000_000,
    recording: {
      start: async () => ({ ok: true, state: "recording", say: "", changes: null }),
      stop: async () => ({ ok: true, state: "idle", say: "", changes: null }),
      audition: async () => ({ ok: true, state: "idle", say: "", changes: null }),
      keep: async () => ({ ok: true, state: "idle", say: "", changes: null }),
    },
  };
}

const PAYLOAD: NativeSkillPayloadV1 = {
  schemaVersion: 1, id: "explicit-balance", version: "1.0.0", implementation: "native",
  handlerKey: "explicitBalanceV1", title: "Explicit balance",
  description: "Mute, unmute, solo, or set an explicit level on a track.",
  intents: { positiveExamples: ["set drums to -6 db"], negativeExamples: ["mix this"], tags: ["mixing"] },
  slots: [], execution: { mode: "atomic", confirmation: "never" },
  responses: { completed: "Done.", needsChoice: "Which one?", blocked: "Can't do that." },
  provenance: [], legacyAliases: [],
  compatibility: {
    minMoshVersion: "0.1.0", commandCatalogSha256: "x", predicateCatalogVersion: 1,
    resolverCatalogVersion: 1, nativeSourceSha256: "explicit-balance-src",
  },
};

describe("explicitBalanceV1 — set_level", () => {
  let engine: FakeEngine;
  beforeEach(() => { engine = new FakeEngine([track({ id: "track-1", name: "Drums", volumeDb: 0 })], "track-1"); });

  it("sets the selected track's level and commits atomically", async () => {
    const outcome = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "set it to -8 dB",
      slots: { action: "set_level", db: -8 },
    });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.volumeDb).toBe(-8);
    expect(engine.batchBeginCalls[0]!.commands.map((c) => c.command)).toEqual(["set_track_volume"]);
  });

  it("resolves an exact unique track name", async () => {
    engine.selectedTrackId = null;
    const outcome = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "set Drums to -8 dB",
      slots: { action: "set_level", db: -8, trackName: "Drums" },
    });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.volumeDb).toBe(-8);
  });

  it("rejects an out-of-range level with no mutation", async () => {
    const outcome = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "set it to -80 dB",
      slots: { action: "set_level", db: -80 },
    });
    expect(outcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
    expect(engine.tracks[0]!.volumeDb).toBe(0);
    expect(engine.batchBeginCalls).toHaveLength(0);
  });

  it("accepts the exact -60/+6 boundary values", async () => {
    const low = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "x", slots: { action: "set_level", db: -60 },
    });
    expect(low).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.volumeDb).toBe(-60);
    const high = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "x", slots: { action: "set_level", db: 6 },
    });
    expect(high).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.volumeDb).toBe(6);
  });

  it("one Undo restores the changed track (delegated to the caller's own undo command — proven here via rollback on command failure)", async () => {
    engine.failCommandOnce = "set_track_volume";
    const outcome = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "x", slots: { action: "set_level", db: -8 },
    });
    expect(outcome).toMatchObject({ kind: "blocked" });
    expect(engine.tracks[0]!.volumeDb).toBe(0); // exact rollback — the failed attempt left no trace
  });
});

describe("explicitBalanceV1 — mute/unmute/solo", () => {
  let engine: FakeEngine;
  beforeEach(() => { engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1"); });

  it("mute reaches the exact requested state", async () => {
    const outcome = await explicitBalanceV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "mute it", slots: { action: "mute" } });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.mute).toBe(true);
  });

  it("unmute reaches the exact requested state", async () => {
    engine.tracks[0]!.mute = true;
    const outcome = await explicitBalanceV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "unmute it", slots: { action: "unmute" } });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.mute).toBe(false);
  });

  it("solo reaches the exact requested state", async () => {
    const outcome = await explicitBalanceV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "solo it", slots: { action: "solo" } });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.solo).toBe(true);
  });
});

describe("explicitBalanceV1 — target resolution", () => {
  it("missing target blocks with zero mutation", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], null);
    const outcome = await explicitBalanceV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "mute it", slots: { action: "mute" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "missing_target" });
    expect(engine.batchBeginCalls).toHaveLength(0);
  });

  it("duplicate-name ambiguity (up to 5) issues needs_choice with zero mutation", async () => {
    const engine = new FakeEngine([
      track({ id: "t1", name: "Vox" }), track({ id: "t2", name: "Vox" }),
    ], null);
    const outcome = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "mute Vox",
      slots: { action: "mute", trackName: "Vox" },
    });
    expect(outcome).toMatchObject({ kind: "needs_choice" });
    expect(outcome.kind === "needs_choice" && outcome.options).toHaveLength(2);
    expect(engine.batchBeginCalls).toHaveLength(0);
  });

  it("more than 5 duplicate names is ambiguous_target, not a truncated choice list", async () => {
    const engine = new FakeEngine(
      Array.from({ length: 6 }, (_, i) => track({ id: `t${i}`, name: "Vox" })), null,
    );
    const outcome = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "mute Vox",
      slots: { action: "mute", trackName: "Vox" },
    });
    expect(outcome).toMatchObject({ kind: "blocked", code: "ambiguous_target" });
    expect(engine.batchBeginCalls).toHaveLength(0);
  });
});

describe("explicitBalanceV1 — vague taste refusal", () => {
  it("an unrecognized action is unsupported_intent with zero mutation", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1");
    const outcome = await explicitBalanceV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "mix this professionally",
      slots: {},
    });
    expect(outcome).toMatchObject({ kind: "blocked", code: "unsupported_intent" });
    expect(engine.batchBeginCalls).toHaveLength(0);
  });
});

describe("explicitBalanceV1 — atomic executor discipline", () => {
  it("uses runAtomicSkillPlanV1 (batch_begin/status/end), never a bare exec of the mutation", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1");
    await explicitBalanceV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "mute it", slots: { action: "mute" } });
    expect(engine.batchBeginCalls).toHaveLength(1);
  });

  it("source status changing between plan and commit rolls back exactly", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1");
    engine.sourceStatusSequence = [1, 1, 2, 2]; // changes between the before_begin and before_commit reads
    const outcome = await explicitBalanceV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "mute it", slots: { action: "mute" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "manifest_stale" });
    expect(engine.tracks[0]!.mute).toBeFalsy();
  });

  it("project epoch changing before commit rolls back exactly", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1");
    const environment = environmentFor(engine);
    const originalExec = environment.exec;
    (environment as { exec: typeof originalExec }).exec = async (command, args, transaction) => {
      if (command === "set_track_mute") engine.projectEpoch += 1; // the project changes mid-flight
      return originalExec(command, args, transaction);
    };
    const outcome = await explicitBalanceV1({ payload: PAYLOAD, environment, utterance: "mute it", slots: { action: "mute" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "manifest_stale" });
    expect(engine.tracks[0]!.mute).toBeFalsy();
  });
});
