// Skill Foundry Slice B, Task 7 (+ owner decision, CODE-BOUND SEEDING) — the composer routes
// load-named-plugin through the ONE registry-backed runtime (runtime.ts's `runStudioSkillV1`)
// instead of the legacy single-skill `studioSkills.ts` copy.
//
// This file exercises the REAL, UNMOCKED default (lazy, production) runtime —
// `runStudioSkillV1` -> `buildDefaultRuntimeV1` — end to end through actual AgentComposer UI
// interaction. Before the owner's code-bound-seeding fix, the default runtime's registry was
// empty outside a real WebView/native bridge (both `loadCertifiedOwnerSkillsV1`/
// `loadBundledNativeSkillsV1` are external artifact-graph loaders that return nothing without
// $MOSH_AGENT_DIR / staged native resources — see runtime.defaultRuntime.test.ts's header for
// the full account), so this file used to mock `../agent/skillFoundry/runtime` to swap in a
// hand-built registry just to have anything to test against. Now that
// `buildDefaultRuntimeV1` seeds the four core skills directly from the compiled-in
// `NATIVE_PAYLOADS_V1` (nativeAdapter.ts's `adaptCodeBoundNativeSkillV1`), the SAME registry
// the default runtime would carry in a shipped app is already populated in this jsdom test
// environment — bridge.ts's `readCertifiedSkillPackages`/`readCertifiedNativeSkills` already
// return their empty envelopes here (no `window.__JUCE__`, i.e. `realNative()` is false; see
// bridge.ts), which is exactly the "both external sources empty" case code-bound seeding
// exists for. No mocking of runtime.ts (or the bridge) is needed at all — this is now a true
// proof that a shipped app serves "load OTT" out of the box.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot, Track } from "../types";
import { __resetDefaultStudioSkillRuntimeForTestsV1, clearDefaultStudioSkillContinuationsV1 } from "../agent/skillFoundry/runtime";

import { AgentComposer } from "./AgentComposer";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/moshi-named-plugin.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{ id: "synth", index: 0, name: "Synth", type: "midi", clips: [] }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

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

// Backs BOTH exec protocols this test exercises: `runAgentBatch`/`logAgentTurn`'s implicit,
// transactionId-less batch_begin/batch_end (a plain "name,turn_id,source" marker — see
// executor.ts's `turnMarkerArgs`), and the FS-B2a atomic-plan protocol
// (`runAtomicSkillPlanV1`) load-named-plugin drives, which always names its transaction and
// always cross-checks `batch_status` before `batch_end` — one extra call the pre-Task-7
// legacy `studioSkills.ts` path never made.
class FakeEngine {
  tracks: Track[];
  plugins: FakePlugin[];
  projectEpoch = 7;
  private stateVersion = 0;
  private readonly txns = new Map<string, FakeTxn>();

  constructor(tracks: Track[], plugins: FakePlugin[]) {
    this.tracks = tracks;
    this.plugins = plugins;
  }

  private fingerprint(): string { return `v${this.stateVersion}`; }

  snapshot(): Snapshot {
    return { ...SNAPSHOT, tracks: this.tracks.map((t) => ({ ...t, plugins: t.plugins ? t.plugins.map((p) => ({ ...p })) : t.plugins })) };
  }

  private applyMutation(command: string, args: Record<string, unknown>): CommandResult {
    if (command === "load_plugin") {
      const track = this.tracks.find((t) => t.id === args.trackId);
      if (!track) return { ok: false, command, error: "no such track" };
      track.plugins = [...(track.plugins ?? []), {
        index: track.plugins?.length ?? 0, name: "loaded", type: "vst3", enabled: true, external: true,
        isInstrument: false, params: [], catalogId: args.pluginId as string,
      }];
      return { ok: true, command };
    }
    return { ok: true, command };
  }

  async exec(command: string, args: Record<string, unknown> = {}, transaction?: { transactionId: string; requestId: string; index: number }): Promise<CommandResult> {
    if (command === "list_plugins") return { ok: true, command, data: { plugins: this.plugins } };

    if (command === "batch_begin") {
      if (!Array.isArray(args.commands)) return { ok: true, command }; // runAgentBatch/logAgentTurn marker — no transaction identity
      const transactionId = args.transactionId as string;
      const commands = args.commands as unknown[];
      const preFingerprint = this.fingerprint();
      this.txns.set(transactionId, { status: "open", manifestCount: commands.length, applied: 0, canCommit: false, canRollback: true, preFingerprint });
      return { ok: true, command, data: { found: true, transactionId, status: "open", manifestCount: commands.length, applied: 0, canCommit: false, canRollback: true, preFingerprint } };
    }
    if (command === "batch_status") {
      const txn = this.txns.get(args.transactionId as string);
      if (!txn) return { ok: true, command, data: { found: false } };
      return { ok: true, command, data: { found: true, transactionId: args.transactionId, ...txn } };
    }
    if (command === "batch_rollback") {
      const txn = this.txns.get(args.transactionId as string);
      if (txn) { txn.status = "rolled_back"; txn.fingerprint = txn.preFingerprint; txn.canRollback = false; }
      return { ok: true, command };
    }
    if (command === "batch_end") {
      const txn = this.txns.get(args.transactionId as string);
      if (!txn) return { ok: true, command }; // runAgentBatch/logAgentTurn marker close
      if (txn.applied !== txn.manifestCount || !txn.canCommit) return { ok: false, command, error: "not ready to commit" };
      txn.status = "committed"; txn.fingerprint = this.fingerprint();
      return { ok: true, command, data: { found: true, status: "committed" } };
    }

    const result = this.applyMutation(command, args);
    if (result.ok) this.stateVersion += 1;
    if (transaction) {
      const txn = this.txns.get(transaction.transactionId);
      if (txn && result.ok) { txn.applied += 1; if (txn.applied === txn.manifestCount) txn.canCommit = true; }
    }
    return result;
  }
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!nativeInputValueSetter) throw new Error("native input value setter is unavailable");
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AgentComposer named plug-in skill", () => {
  let host: HTMLDivElement;
  let root: Root;
  let engine: FakeEngine;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(async () => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
    // Fresh default-runtime generation per test — the registry itself is deterministic
    // (compiled-in constants, no I/O variance), but this keeps each test's continuation
    // routing table/private handler stores isolated rather than relying solely on the
    // composer's own mount-time `clearDefaultStudioSkillContinuationsV1()` effect.
    //
    // Built and AWAITED here, before the component ever mounts: `buildDefaultRuntimeV1()`
    // does real async work (catalog fingerprint hashing, two bridge reads) that spans more
    // event-loop turns than a single `act(async () => send.click())` flushes. Without this,
    // the first interaction races the registry build — observed as a flaky "exec never
    // called" failure in one test and a stray extra call bleeding into the NEXT test (the
    // first test's still-in-flight promise resolving mid-way through the second, since
    // `buildSkillEnvironment` reads the store's `exec` live). Pre-building here (the SAME
    // path AgentComposer's own mount effect calls) makes every subsequent `runStudioSkillV1`
    // call resolve on just the handler's own async work, matching this test's original
    // (mocked-runtime) timing.
    __resetDefaultStudioSkillRuntimeForTestsV1();
    await clearDefaultStudioSkillContinuationsV1();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    engine = new FakeEngine(
      [{ id: "synth", index: 0, name: "Synth", type: "midi", clips: [] }],
      [
        { id: "serum-1", name: "Serum", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
        { id: "serum-2", name: "Serum 2", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
        { id: "serum-2-fx", name: "Serum 2 FX", format: "VST3", manufacturer: "Xfer Records", isInstrument: false },
      ],
    );
    // Every exec call re-syncs the store's cached snapshot from the SAME engine instance —
    // the composer's environment.snapshot() is a plain (non-refreshing) read of that field
    // (matching session-control's runSave, the one existing precedent for the contract), so
    // a mutation's postcondition check needs this to observe it.
    exec = vi.fn(async (command: string, args: Record<string, unknown> = {}, transaction?: { transactionId: string; requestId: string; index: number }): Promise<CommandResult> => {
      const result = await engine.exec(command, args, transaction);
      useStore.setState({ snapshot: engine.snapshot() });
      return result;
    });
    useStore.setState({
      snapshot: engine.snapshot(),
      projectEpoch: engine.projectEpoch,
      selectedTrackId: "synth",
      agentBusy: false,
      agentChangeSet: null,
      exec,
      refresh: vi.fn(async () => { useStore.setState({ snapshot: engine.snapshot() }); }),
    });
    act(() => root.render(React.createElement(AgentComposer)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      projectEpoch: originalState.projectEpoch,
      selectedTrackId: originalState.selectedTrackId,
      agentBusy: originalState.agentBusy,
      agentChangeSet: originalState.agentChangeSet,
      exec: originalState.exec,
      refresh: originalState.refresh,
    });
  });

  it("offers text entry without a speech-recognition control", () => {
    expect(host.querySelector("[data-testid=agent-input]")).not.toBeNull();
    expect(host.querySelector("[data-testid=agent-mic]")).toBeNull();
  });

  it("loads the unique exact Serum 2 match without asking the cloud brain for an id", async () => {
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "can you load serum 2?"));
    await act(async () => send.click());

    expect(exec).toHaveBeenCalledWith("list_plugins", {}, undefined);
    expect(exec).toHaveBeenCalledWith("load_plugin", { trackId: "synth", pluginId: "serum-2" }, expect.any(Object));
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      "list_plugins",
      "batch_begin",
      "load_plugin",
      "batch_status",
      "batch_end",
    ]);
    // Task 7 — the native handler's response is a generic per-payload confirmation
    // (`payload.responses.completed`), not the legacy skill's per-plugin/per-track say.
    expect(host.querySelector("[role=status]")?.textContent).toBe("Done.");
    expect(engine.tracks[0]?.plugins?.[0]?.catalogId).toBe("serum-2");
  });

  it("keeps an ambiguous catalog choice and loads the numbered follow-up", async () => {
    engine.plugins = [
      { id: "serum-au", name: "Serum 2", format: "AudioUnit", manufacturer: "Xfer Records", isInstrument: true },
      { id: "serum-vst3", name: "Serum 2", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
    ];
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "load Serum 2"));
    await act(async () => send.click());
    expect(host.querySelector("[role=status]")?.textContent).toContain("choose 1–2");
    expect(exec.mock.calls.map(([command]) => command)).toEqual(["list_plugins"]);

    act(() => setInputValue(input, "2"));
    await act(async () => send.click());
    expect(exec).toHaveBeenCalledWith("load_plugin", { trackId: "synth", pluginId: "serum-vst3" }, expect.any(Object));
    expect(host.querySelector("[role=status]")?.textContent).toBe("Done.");
  });

  it("fails closed for an unsupported ask instead of invoking the free-form brain", async () => {
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "make the whole mix warmer"));
    await act(async () => send.click());

    expect(exec.mock.calls.map(([command]) => command)).toEqual(["batch_begin", "batch_end"]);
    expect(host.querySelector("[role=status]")?.textContent).toBe("I can't do that reliably yet.");
  });

  it("records a recognized but unavailable plug-in ask as unserved", async () => {
    engine.plugins = [];
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "load Omnisphere"));
    await act(async () => send.click());

    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      "list_plugins",
      "batch_begin",
      "batch_end",
    ]);
    const begin = exec.mock.calls.find(([command]) => command === "batch_begin");
    expect(begin?.[1]).toMatchObject({
      utterance: "load Omnisphere",
      source: "studio_skill_blocked",
    });
    expect(host.querySelector("[role=status]")?.textContent).toContain("open Plug-in Manager or rescan");
  });
});
