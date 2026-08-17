// Skill Foundry Slice B, Task 7 — the composer now routes load-named-plugin through the
// ONE registry-backed runtime (runtime.ts's `runStudioSkillV1`) instead of the legacy
// single-skill `studioSkills.ts` copy. The default (lazy, production) runtime's registry is
// empty in this slice (no bundled/certified native resources ship yet — see
// loadCertifiedSkills.ts's own "expected Slice A steady state" note), so this file mocks
// `../agent/skillFoundry/runtime` to swap in a runtime built the SAME way runtime.test.ts's
// own fixture is (the real `createStudioSkillRuntimeV1` over the four real native
// payloads/handlers) — this exercises the REAL `loadNamedPluginV1` handler end-to-end
// through actual AgentComposer UI interaction, not a stand-in.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot, Track } from "../types";

vi.mock("../agent/skillFoundry/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/skillFoundry/runtime")>();
  const { buildStudioSkillRegistryV1 } = await import("../agent/skillFoundry/registry");
  const { createContinuationStoreV1 } = await import("../agent/skillFoundry/continuations");
  const { NATIVE_HANDLERS_V1, NATIVE_PAYLOADS_V1 } = await import("../agent/skillFoundry/native/index");

  const candidates = NATIVE_PAYLOADS_V1.map((payload) => ({
    id: payload.id,
    origin: "native" as const,
    aliases: payload.legacyAliases,
    manifest: payload,
  }));
  const registryResult = await buildStudioSkillRegistryV1({ generation: 1, native: candidates, builtin: [], owner: [] });
  if (!registryResult.ok) throw new Error("test fixture: the four native payloads failed to register");
  const testRuntime = actual.createStudioSkillRuntimeV1({
    registry: registryResult.registry,
    continuations: createContinuationStoreV1(),
    nativeHandlers: NATIVE_HANDLERS_V1,
  });

  return {
    ...actual,
    runStudioSkillV1: (utterance: string, environment: Parameters<typeof actual.runStudioSkillV1>[1], continuationToken?: string) =>
      testRuntime.run(utterance, environment, continuationToken),
    clearDefaultStudioSkillContinuationsV1: async () => { testRuntime.onProjectReplaced(); },
  };
});

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

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
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
