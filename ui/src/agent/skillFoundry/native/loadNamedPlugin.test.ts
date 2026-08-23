// Skill Foundry Slice B, Task 5 — named plug-in loading migrated onto the atomic runtime.

import { describe, expect, it } from "vitest";
import type { Snapshot, Track } from "../../../types";
import type { NativeSkillPayloadV1, StudioSkillEnvironmentV1 } from "../contracts";
import { loadNamedPluginV1, parsePluginCatalogV1, pluginQueryV1 } from "./loadNamedPlugin";

type FakeBridgeResult = { readonly ok: boolean; readonly error?: string; readonly data?: unknown };
type FakePlugin = { id: string; name: string; format: string; manufacturer: string; isInstrument: boolean };

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
  plugins: FakePlugin[];
  projectEpoch = 1;
  stateVersion = 0;
  sourceStatusGeneration = 1;
  sourceStatusSequence: readonly number[] | null = null;
  failLoadOnce = false;
  failLoadReason = "instrument on an audio track";
  private sourceStatusCallIndex = 0;
  private readonly txns = new Map<string, FakeTxn>();
  readonly batchBeginCalls: { transactionId: string; commands: readonly { command: string }[] }[] = [];

  constructor(tracks: Track[], selectedTrackId: string | null, plugins: FakePlugin[]) {
    this.tracks = tracks;
    this.selectedTrackId = selectedTrackId;
    this.plugins = plugins;
  }

  private fingerprint(): string { return `v${this.stateVersion}`; }

  snapshot(): Snapshot {
    return {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "x" },
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      tracks: this.tracks.map((t) => ({ ...t, plugins: t.plugins ? t.plugins.map((p) => ({ ...p })) : t.plugins })),
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
    if (command === "load_plugin") {
      if (this.failLoadOnce) { this.failLoadOnce = false; return { ok: false, error: this.failLoadReason }; }
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      const pluginId = args.pluginId as string;
      track.plugins = [...(track.plugins ?? []), {
        index: (track.plugins?.length ?? 0), name: "loaded", type: "vst3", enabled: true, external: true,
        isInstrument: false, params: [], catalogId: pluginId,
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
      this.batchBeginCalls.push({ transactionId, commands });
      const preFingerprint = this.fingerprint();
      const txn: FakeTxn = {
        status: "open", manifestCount: commands.length, applied: 0,
        entries: commands.map((c) => ({ index: c.index, requestId: c.requestId, command: c.command, state: "pending" as const })),
        preFingerprint, canCommit: false, canRollback: true,
        preTracks: this.tracks.map((t) => ({ ...t, plugins: t.plugins ? [...t.plugins] : t.plugins })),
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
      this.tracks = txn.preTracks.map((t) => ({ ...t, plugins: t.plugins ? [...t.plugins] : t.plugins }));
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
  schemaVersion: 1, id: "load-named-plugin", version: "1.0.0", implementation: "native",
  handlerKey: "loadNamedPluginV1", title: "Load a named plug-in",
  description: "Resolve an installed plug-in by name and load it on the selected track.",
  intents: { positiveExamples: ["load Serum 2"], negativeExamples: [], tags: ["plugins"] },
  slots: [], execution: { mode: "atomic", confirmation: "never" },
  responses: { completed: "Done.", needsChoice: "Which one?", blocked: "Can't do that." },
  provenance: [], legacyAliases: ["load_named_plugin"],
  compatibility: {
    minMoshVersion: "0.1.0", commandCatalogSha256: "x", predicateCatalogVersion: 1,
    resolverCatalogVersion: 1, nativeSourceSha256: "load-named-plugin-src",
  },
};

function plugin(overrides: Partial<FakePlugin> = {}): FakePlugin {
  return { id: "p1", name: "Serum 2", format: "VST3", manufacturer: "Xfer", isInstrument: true, ...overrides };
}

describe("pluginQueryV1 / parsePluginCatalogV1", () => {
  it("extracts the plugin name from a load phrase", () => {
    expect(pluginQueryV1("load Serum 2")).toBe("Serum 2");
    expect(pluginQueryV1("could you add OTT on the selected track")).toBe("OTT");
    expect(pluginQueryV1("mute the drums")).toBeNull();
  });

  it("does not steal clip and note creation requests from the producer brain", () => {
    expect(pluginQueryV1("add a 3 second 220 hertz test tone clip to the selected Audio track")).toBeNull();
    expect(pluginQueryV1("add a MIDI clip on the selected track")).toBeNull();
    expect(pluginQueryV1("add four notes to this clip")).toBeNull();
  });

  it("rejects a catalog over the 64-entry cap", () => {
    const oversized = { plugins: Array.from({ length: 65 }, (_, i) => plugin({ id: `p${i}` })) };
    expect(parsePluginCatalogV1(oversized)).toBeNull();
    const exact = { plugins: Array.from({ length: 64 }, (_, i) => plugin({ id: `p${i}` })) };
    expect(parsePluginCatalogV1(exact)).not.toBeNull();
  });

  it("rejects an overlong field (>1024 UTF-16 code units)", () => {
    const overlong = { plugins: [plugin({ name: "x".repeat(1025) })] };
    expect(parsePluginCatalogV1(overlong)).toBeNull();
  });
});

describe("loadNamedPluginV1 — exact resolution", () => {
  it("loads the exact match on the selected track, atomically", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Synth" })], "track-1", [plugin()]);
    const outcome = await loadNamedPluginV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "load Serum 2", slots: {},
    });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(engine.tracks[0]!.plugins?.map((p) => p.catalogId)).toEqual(["p1"]);
    expect(engine.batchBeginCalls[0]!.commands.map((c) => c.command)).toEqual(["load_plugin"]);
  });

  it("missing selected track blocks with missing_target and zero mutation", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Synth" })], null, [plugin()]);
    const outcome = await loadNamedPluginV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "load Serum 2", slots: {},
    });
    expect(outcome).toMatchObject({ kind: "blocked", code: "missing_target" });
    expect(engine.batchBeginCalls).toHaveLength(0);
  });

  it("an absent plugin blocks with missing_target and rescan guidance", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Synth" })], "track-1", [plugin()]);
    const outcome = await loadNamedPluginV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "load Nonexistent Plugin", slots: {},
    });
    expect(outcome).toMatchObject({ kind: "blocked", code: "missing_target" });
    expect(outcome.kind === "blocked" && outcome.say).toMatch(/rescan/i);
  });

  it("instrument/audio mismatch surfaces actionable guidance without a raw error", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1", [plugin()]);
    engine.failLoadOnce = true;
    const outcome = await loadNamedPluginV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "load Serum 2", slots: {},
    });
    expect(outcome).toMatchObject({ kind: "blocked", code: "command_failed" });
    expect(outcome.kind === "blocked" && outcome.say).toMatch(/instrument track/i);
  });

  it("one Undo restores no plugin after a failed load (exact rollback)", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1", [plugin()]);
    engine.failLoadOnce = true;
    await loadNamedPluginV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "load Serum 2", slots: {} });
    expect(engine.tracks[0]!.plugins ?? []).toHaveLength(0);
  });
});

describe("loadNamedPluginV1 — ambiguous choice + resume", () => {
  it("an ambiguous name issues an opaque continuation token, not raw choice data", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Synth" })], "track-1", [
      plugin({ id: "p1", manufacturer: "Xfer" }), plugin({ id: "p2", manufacturer: "OtherCo" }),
    ]);
    const outcome = await loadNamedPluginV1({
      payload: PAYLOAD, environment: environmentFor(engine), utterance: "load Serum 2", slots: {},
    });
    expect(outcome).toMatchObject({ kind: "needs_choice" });
    expect(outcome.kind === "needs_choice" && typeof outcome.continuationToken).toBe("string");
    expect(engine.batchBeginCalls).toHaveLength(0);
  });

  it("resuming with the numbered reply completes canonically with mutation manifest [load_plugin]", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Synth" })], "track-1", [
      plugin({ id: "p1", manufacturer: "Xfer" }), plugin({ id: "p2", manufacturer: "OtherCo" }),
    ]);
    const environment = environmentFor(engine);
    const first = await loadNamedPluginV1({ payload: PAYLOAD, environment, utterance: "load Serum 2", slots: {} });
    expect(first.kind).toBe("needs_choice");
    const token = first.kind === "needs_choice" ? first.continuationToken : "";

    const second = await loadNamedPluginV1({
      payload: PAYLOAD, environment, utterance: "2", slots: {}, continuationToken: token,
    });
    expect(second).toMatchObject({ kind: "completed" });
    expect(engine.batchBeginCalls[0]!.commands.map((c) => c.command)).toEqual(["load_plugin"]);
  });

  it("an old (already-consumed) token is rejected on replay", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Synth" })], "track-1", [
      plugin({ id: "p1", manufacturer: "Xfer" }), plugin({ id: "p2", manufacturer: "OtherCo" }),
    ]);
    const environment = environmentFor(engine);
    const first = await loadNamedPluginV1({ payload: PAYLOAD, environment, utterance: "load Serum 2", slots: {} });
    const token = first.kind === "needs_choice" ? first.continuationToken : "";
    await loadNamedPluginV1({ payload: PAYLOAD, environment, utterance: "1", slots: {}, continuationToken: token });

    const replay = await loadNamedPluginV1({ payload: PAYLOAD, environment, utterance: "1", slots: {}, continuationToken: token });
    expect(replay).toMatchObject({ kind: "blocked", code: "stale_context" });
  });

  it("a project change before resume rolls back exactly (blocked, zero mutation)", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Synth" })], "track-1", [
      plugin({ id: "p1", manufacturer: "Xfer" }), plugin({ id: "p2", manufacturer: "OtherCo" }),
    ]);
    const environment = environmentFor(engine);
    const first = await loadNamedPluginV1({ payload: PAYLOAD, environment, utterance: "load Serum 2", slots: {} });
    const token = first.kind === "needs_choice" ? first.continuationToken : "";
    engine.projectEpoch += 1;

    const second = await loadNamedPluginV1({ payload: PAYLOAD, environment, utterance: "1", slots: {}, continuationToken: token });
    expect(second).toMatchObject({ kind: "blocked", code: "stale_context" });
    expect(engine.batchBeginCalls).toHaveLength(0);
  });
});

describe("loadNamedPluginV1 — postcondition (exactly one added, others unchanged)", () => {
  it("only the target track's matching-catalogId count increases; a sibling track's is unaffected", async () => {
    const engine = new FakeEngine(
      [track({ id: "track-1", name: "Synth" }), track({ id: "track-2", name: "Other" })],
      "track-1", [plugin()],
    );
    await loadNamedPluginV1({ payload: PAYLOAD, environment: environmentFor(engine), utterance: "load Serum 2", slots: {} });
    expect(engine.tracks[0]!.plugins?.length).toBe(1);
    expect(engine.tracks[1]!.plugins ?? []).toHaveLength(0);
  });
});
