// Skill Foundry Slice B — owner decision, CODE-BOUND SEEDING (resolves the empty-registry
// regression flagged in 0e860fea's own commit message).
//
// `buildDefaultRuntimeV1` (runtime.ts) previously seeded the registry ONLY from
// `loadCertifiedOwnerSkillsV1`/`loadBundledNativeSkillsV1`'s `accepted` arrays — both of
// which are external-artifact-graph loaders over $MOSH_AGENT_DIR / the app's staged native
// resources. Outside a real WebView/native bridge (i.e. every non-native test, and every
// shipped app that has not yet had Slice E's bundled-index staging land — see
// nativeReads.ts's own note that bridge.ts returns EMPTY_* envelopes when `realNative()` is
// false), BOTH sources are empty. So the default, PRODUCTION runtime — the one
// `runStudioSkillV1`/AgentComposer actually calls — had an empty registry, and every one of
// the four core skills, including `load_named_plugin` (which works today via the legacy
// `studioSkills.ts` path), was INACTIVE.
//
// This file proves the regression against the real default runtime (no mocking of runtime.ts
// itself — only the FakeEngine standing in for MoshOps/the bridge, the same fixture shape
// loadNamedPlugin.test.ts/AgentComposer.namedPlugin.test.ts already use), then proves the fix:
// the default runtime seeds code-bound candidates straight from the compiled-in
// `NATIVE_PAYLOADS_V1` (native/payloads.ts) — trust root is the app's own code signature, not
// an external artifact graph — so the four core skills are ACTIVE even when both external
// sources are empty.

import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot, Track } from "../../types";
import type { StudioSkillEnvironmentV1 } from "./contracts";

type FakeBridgeResult = { readonly ok: boolean; readonly error?: string; readonly data?: unknown };
type FakePlugin = { id: string; name: string; format: string; manufacturer: string; isInstrument: boolean };

type FakeTxn = {
  status: "open" | "committed" | "rolled_back";
  manifestCount: number;
  applied: number;
  canCommit: boolean;
  canRollback: boolean;
  preFingerprint: string;
  fingerprint?: string;
};

// Minimal MoshOps-shaped fake engine — enough for the load-named-plugin atomic plan
// (list_plugins, batch_begin/status/end, load_plugin) to run end to end. Trimmed copy of the
// same fixture shape native/loadNamedPlugin.test.ts and AgentComposer.namedPlugin.test.ts
// already establish, not re-derived logic.
class FakeEngine {
  tracks: Track[];
  plugins: FakePlugin[];
  projectEpoch = 1;
  private stateVersion = 0;
  private readonly txns = new Map<string, FakeTxn>();

  constructor(tracks: Track[], plugins: FakePlugin[]) {
    this.tracks = tracks;
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
    return { projectEpoch: this.projectEpoch, selectedTrackId: this.tracks[0]?.id ?? null, tracks: this.tracks.map((t) => ({ id: t.id, name: t.name })) };
  }

  private applyMutation(command: string, args: Record<string, unknown>): FakeBridgeResult {
    if (command === "load_plugin") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, error: "no such track" };
      track.plugins = [...(track.plugins ?? []), {
        index: track.plugins?.length ?? 0, name: "loaded", type: "vst3", enabled: true, external: true,
        isInstrument: false, params: [], catalogId: args.pluginId as string,
      }];
      return { ok: true };
    }
    return { ok: false, error: `unknown command ${command}` };
  }

  async exec(command: string, args: Record<string, unknown> = {}, transaction?: { transactionId: string; requestId: string; index: number }): Promise<FakeBridgeResult> {
    if (command === "list_plugins") return { ok: true, data: { plugins: this.plugins } };

    if (command === "batch_begin") {
      const transactionId = args.transactionId as string;
      const commands = args.commands as unknown[];
      const preFingerprint = this.fingerprint();
      this.txns.set(transactionId, { status: "open", manifestCount: commands.length, applied: 0, canCommit: false, canRollback: true, preFingerprint });
      return { ok: true, data: { found: true, transactionId, status: "open", manifestCount: commands.length, applied: 0, canCommit: false, canRollback: true, preFingerprint } };
    }
    if (command === "batch_status") {
      const txn = this.txns.get(args.transactionId as string);
      if (!txn) return { ok: true, data: { found: false } };
      return { ok: true, data: { found: true, transactionId: args.transactionId, ...txn } };
    }
    if (command === "batch_rollback") {
      const txn = this.txns.get(args.transactionId as string);
      if (txn) { txn.status = "rolled_back"; txn.fingerprint = txn.preFingerprint; txn.canRollback = false; }
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
    const result = this.applyMutation(command, args);
    if (result.ok) this.stateVersion += 1;
    if (txn && result.ok) { txn.applied += 1; if (txn.applied === txn.manifestCount) txn.canCommit = true; }
    return result;
  }
}

function environmentFor(engine: FakeEngine): StudioSkillEnvironmentV1 {
  let counter = 0;
  return {
    context: () => engine.context(),
    snapshot: async () => engine.snapshot(),
    exec: (command, args, transaction) => engine.exec(command, args as Record<string, unknown>, transaction),
    readSourceStatus: async () => ({ schemaVersion: 1, ok: true, statusIndex: null, diagnostics: [] }),
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

describe("buildDefaultRuntimeV1 — code-bound native seeding (owner decision)", () => {
  afterEach(async () => {
    const { __resetDefaultStudioSkillRuntimeForTestsV1 } = await import("./runtime");
    __resetDefaultStudioSkillRuntimeForTestsV1();
  });

  it("serves 'load ott' end to end through the REAL default runtime — no owner packages, no bundled native index, both external sources empty", async () => {
    const { runStudioSkillV1, __resetDefaultStudioSkillRuntimeForTestsV1 } = await import("./runtime");
    __resetDefaultStudioSkillRuntimeForTestsV1();

    const engine = new FakeEngine(
      [{ id: "bus", index: 0, name: "Bus", type: "audio", clips: [] }],
      [{ id: "ott-1", name: "OTT", format: "VST3", manufacturer: "Xfer Records", isInstrument: false }],
    );

    const outcome = await runStudioSkillV1("load ott", environmentFor(engine));

    expect(outcome.kind).toBe("completed");
    expect(engine.tracks[0]?.plugins?.[0]?.catalogId).toBe("ott-1");
  });

  it("also serves session-control ('play') and explicit-balance ('mute the bus') through the default runtime", async () => {
    const { runStudioSkillV1, __resetDefaultStudioSkillRuntimeForTestsV1 } = await import("./runtime");
    __resetDefaultStudioSkillRuntimeForTestsV1();

    const engine = new FakeEngine([{ id: "bus", index: 0, name: "Bus", type: "audio", clips: [] }], []);

    const playOutcome = await runStudioSkillV1("play", environmentFor(engine));
    expect(playOutcome.kind).not.toBe("unsupported");

    const muteOutcome = await runStudioSkillV1("mute the bus", environmentFor(engine));
    expect(muteOutcome.kind).not.toBe("unsupported");
  });
});
