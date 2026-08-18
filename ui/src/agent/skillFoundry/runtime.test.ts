// Skill Foundry Slice B, Task 6 — the one studio-skill runtime, exercised directly against
// `createStudioSkillRuntimeV1` with a hand-built registry over the four real native
// payloads/handlers (native/index.ts) and a small fake environment — the same
// batch-transaction FakeEngine pattern explicitBalance.test.ts/loadNamedPlugin.test.ts
// already established, reused here rather than re-derived.

import { beforeEach, describe, expect, it } from "vitest";
import type { Snapshot, Track } from "../../types";
import { NATIVE_HANDLERS_V1, NATIVE_PAYLOADS_V1 } from "./native/index";
import { createContinuationStoreV1 } from "./continuations";
import { buildStudioSkillRegistryV1 } from "./registry";
import { createStudioSkillRuntimeV1 } from "./runtime";
import type { RegisteredSkillV1, StudioSkillEnvironmentV1, StudioSkillRegistryV1 } from "./contracts";

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
  plugins: FakePlugin[] = [];
  projectEpoch = 1;
  stateVersion = 0;
  transportPlaying = false;
  transportRecording = false;
  private readonly txns = new Map<string, FakeTxn>();
  readonly execCalls: { command: string; args: Record<string, unknown> }[] = [];

  constructor(tracks: Track[], selectedTrackId: string | null) {
    this.tracks = tracks;
    this.selectedTrackId = selectedTrackId;
  }

  private fingerprint(): string { return `v${this.stateVersion}`; }

  snapshot(): Snapshot {
    return {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "x", dirty: false },
      transport: { playing: this.transportPlaying, recording: this.transportRecording, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      tracks: this.tracks.map((t) => ({ ...t, plugins: t.plugins ? t.plugins.map((p) => ({ ...p })) : t.plugins })),
    } as unknown as Snapshot;
  }

  context() {
    return { projectEpoch: this.projectEpoch, selectedTrackId: this.selectedTrackId, tracks: this.tracks.map((t) => ({ id: t.id, name: t.name })) };
  }

  async readSourceStatus() {
    const utf8 = JSON.stringify({ schemaVersion: 1, generation: 1, updatedAt: "2026-01-01T00:00:00.000Z", entries: [] });
    return { schemaVersion: 1 as const, ok: true as const, statusIndex: { name: "s.json", bytes: utf8.length, sha256: "sha-1", utf8 }, diagnostics: [] };
  }

  private applyMutation(command: string, args: Record<string, unknown>): FakeBridgeResult {
    if (command === "set_track_mute") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.mute = args.mute as boolean;
      return { ok: true };
    }
    if (command === "set_track_volume") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.volumeDb = args.db as number;
      return { ok: true };
    }
    if (command === "load_plugin") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.plugins = [...(track.plugins ?? []), {
        index: track.plugins?.length ?? 0, name: "loaded", type: "vst3", enabled: true, external: true,
        isInstrument: false, params: [], catalogId: args.pluginId as string,
      }];
      return { ok: true };
    }
    if (command === "undo") return { ok: true, data: { undone: true } };
    if (command === "redo") return { ok: true, data: { redone: true } };
    if (command === "save") return { ok: true };
    if (command === "set_transport") return { ok: true };
    return { ok: false, error: `unknown command ${command}` };
  }

  async exec(command: string, args: Record<string, unknown>, transaction?: { transactionId: string; requestId: string; index: number }): Promise<FakeBridgeResult> {
    this.execCalls.push({ command, args });
    if (command === "list_plugins") return { ok: true, data: { plugins: this.plugins } };
    if (command === "set_transport") {
      if (args.action === "play") this.transportPlaying = true;
      if (args.action === "stop") this.transportPlaying = false;
      return { ok: true };
    }

    if (command === "batch_begin") {
      const transactionId = args.transactionId as string;
      const commands = args.commands as { index: number; requestId: string; command: string }[];
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
      start: async () => { engine.transportRecording = true; return { ok: true, state: "recording", say: "Recording.", changes: null }; },
      stop: async () => { engine.transportRecording = false; return { ok: true, state: "reviewing", say: "Stopped.", changes: null }; },
      audition: async () => ({ ok: true, state: "reviewing", say: "Switched.", changes: null }),
      keep: async () => ({ ok: true, state: "kept", say: "Kept.", changes: null }),
    },
  };
}

async function buildFourCoreRegistry(): Promise<StudioSkillRegistryV1> {
  const candidates: RegisteredSkillV1[] = NATIVE_PAYLOADS_V1.map((payload) => ({
    id: payload.id, origin: "native", aliases: payload.legacyAliases, manifest: payload,
  }));
  const result = await buildStudioSkillRegistryV1({ generation: 1, native: candidates, builtin: [], owner: [] });
  if (!result.ok) throw new Error("test fixture: expected the four native payloads to register cleanly");
  return result.registry;
}

describe("createStudioSkillRuntimeV1 — registry identity", () => {
  it("registers exactly the four native ids, plus only the documented plugin alias", async () => {
    const registry = await buildFourCoreRegistry();
    const ids = registry.list().map((entry) => entry.id).sort();
    expect(ids).toEqual(["capture-review-choose-take", "explicit-balance", "load-named-plugin", "session-control"]);
    expect(registry.get("load_named_plugin")?.id).toBe("load-named-plugin");
    expect(registry.get("session_control")).toBeNull();
  });
});

describe("createStudioSkillRuntimeV1 — deterministic dispatch", () => {
  let engine: FakeEngine;
  beforeEach(() => { engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1"); });

  it("routes 'play' to session-control with zero exec calls when already playing", async () => {
    engine.transportPlaying = true;
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const outcome = await runtime.run("play", environmentFor(engine));
    expect(outcome).toMatchObject({ kind: "completed", skill: "session-control" });
    expect(engine.execCalls).toHaveLength(0);
  });

  it("routes 'mute the drums' to explicit-balance, mutating atomically", async () => {
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const outcome = await runtime.run("mute it", environmentFor(engine));
    expect(outcome).toMatchObject({ kind: "completed", skill: "explicit-balance" });
    expect(engine.tracks[0]!.mute).toBe(true);
  });

  it("routes 'load Serum 2' to load-named-plugin", async () => {
    engine.plugins = [{ id: "p1", name: "Serum 2", format: "VST3", manufacturer: "Xfer", isInstrument: true }];
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const outcome = await runtime.run("load Serum 2", environmentFor(engine));
    expect(outcome).toMatchObject({ kind: "completed", skill: "load-named-plugin" });
    expect(engine.tracks[0]!.plugins?.[0]?.catalogId).toBe("p1");
  });

  it("routes 'stop' to session-control, and 'keep it' to capture-review-choose-take", async () => {
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const stop = await runtime.run("stop", environmentFor(engine));
    expect(stop).toMatchObject({ kind: "completed", skill: "session-control" });
    const keep = await runtime.run("keep it", environmentFor(engine));
    expect(keep).toMatchObject({ kind: "completed", skill: "capture-review-choose-take" });
  });

  it("an utterance matching no vocabulary is unsupported, never a raw command or dev-loop fallback", async () => {
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const outcome = await runtime.run("mix this professionally and make it sound huge", environmentFor(engine));
    expect(outcome).toMatchObject({ kind: "unsupported" });
    expect(engine.execCalls).toHaveLength(0);
  });
});

describe("createStudioSkillRuntimeV1 — continuation-first resume and routing", () => {
  it("an ambiguous name issues a token, and resume routes back to the SAME handler", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Vox" }), track({ id: "track-2", name: "Vox" })], null);
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });

    const first = await runtime.run("mute Vox", environmentFor(engine));
    expect(first.kind).toBe("needs_choice");
    const token = first.kind === "needs_choice" ? first.continuationToken : "";
    expect(typeof token).toBe("string");

    const second = await runtime.run("1", environmentFor(engine), token);
    expect(second).toMatchObject({ kind: "completed", skill: "explicit-balance" });
  });

  it("resume takes precedence over deterministic matching even if the reply text also parses", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Vox" }), track({ id: "track-2", name: "Vox" })], null);
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const first = await runtime.run("mute Vox", environmentFor(engine));
    const token = first.kind === "needs_choice" ? first.continuationToken : "";

    // "stop" would otherwise deterministically match session-control — but a pending
    // continuation must resume FIRST, so this reply is consumed by explicit-balance's
    // own choice matcher (and fails to parse as a valid option there).
    const resumed = await runtime.run("stop", environmentFor(engine), token);
    expect(resumed).toMatchObject({ kind: "blocked" });
    expect(resumed).not.toMatchObject({ skill: "session-control" });
  });

  it("an unknown/expired token is blocked with stale_context, never silently falls through to a fresh match", async () => {
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const outcome = await runtime.run("1", environmentFor(new FakeEngine([track()], "track-1")), "not-a-real-token");
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context" });
  });

  it("onProjectReplaced clears pending routing so a stale token can no longer resume", async () => {
    const engine = new FakeEngine([track({ id: "track-1", name: "Vox" }), track({ id: "track-2", name: "Vox" })], null);
    const registry = await buildFourCoreRegistry();
    const runtime = createStudioSkillRuntimeV1({ registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const first = await runtime.run("mute Vox", environmentFor(engine));
    const token = first.kind === "needs_choice" ? first.continuationToken : "";

    runtime.onProjectReplaced();

    const resumed = await runtime.run("1", environmentFor(engine), token);
    expect(resumed).toMatchObject({ kind: "blocked", code: "stale_context" });
  });
});

describe("createStudioSkillRuntimeV1 — eligible-set precedence", () => {
  it("an utterance only matches within the PUBLISHED registry — an unregistered id never dispatches", async () => {
    // A registry missing load-named-plugin (simulating a quarantined package) must never
    // let "load Serum 2" fall through to anything else.
    const candidates: RegisteredSkillV1[] = NATIVE_PAYLOADS_V1
      .filter((payload) => payload.id !== "load-named-plugin")
      .map((payload) => ({ id: payload.id, origin: "native" as const, aliases: payload.legacyAliases, manifest: payload }));
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: candidates, builtin: [], owner: [] });
    if (!result.ok) throw new Error("test fixture build failed");
    const runtime = createStudioSkillRuntimeV1({ registry: result.registry, continuations: createContinuationStoreV1(), nativeHandlers: NATIVE_HANDLERS_V1 });
    const engine = new FakeEngine([track({ id: "track-1", name: "Drums" })], "track-1");
    const outcome = await runtime.run("load Serum 2", environmentFor(engine));
    expect(outcome).toMatchObject({ kind: "unsupported" });
  });
});
