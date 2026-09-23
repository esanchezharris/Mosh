import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Arrangement } from "./Arrangement";
import { useStore } from "../store";
import { useTaskStore, type TaskView } from "../agent/loop/taskStore";
import type { CommandResult, Snapshot } from "../types";

// Review fix 1: while Moshi holds an open batch, every toolbar edit button waits. A Moshi dock
// ask that runs through runAgentBatch (fast path, studio skills, section rework) holds the
// native batch with agentBusy=true and NO live loop task (useTaskStore.current === null), so
// gating on the task alone let a click fold into the agent's undo step.

vi.mock("../bridge", async (original) => ({ ...await original<typeof import("../bridge")>(), onEvent: vi.fn(() => () => {}) }));

const snapshot: Snapshot = {
  schemaVersion: 1,
  session: { key: { tonic: "A", mode: "minor" }, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, sampleRate: 48000, length: 4, editFile: "gating.mosh", countInBars: 0 },
  tracks: [{ id: "keys", index: 0, name: "Keys", type: "midi", clips: [{ id: "melody", name: "Melody", type: "midi", start: 0, offset: 0, length: 4, hasRenderLayer: false, notes: [] }] }],
  transport: { playing: false, recording: false, looping: false, position: 0, loopStart: 0, loopEnd: 4 },
};

const EDIT_BUTTONS = ["v3-add-audio", "v3-add-midi", "v3-add-drum-beat", "v3-add-chords", "v3-add-midi-clip"] as const;

const liveTask = (): TaskView => ({ ask: "build a beat", phase: "stepping", plan: [], steps: [], startedAt: Date.now() });

describe("V3 toolbar edits wait while Moshi holds the undo step", () => {
  let host: HTMLDivElement;
  let root: Root;
  const original = useStore.getState();
  const exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
  const button = (id: string) => {
    const el = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!el) throw new Error(`Missing ${id}`);
    return el;
  };

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    exec.mockClear();
    // a MIDI track is selected, so + MIDI clip is otherwise available (anti-vacuity below)
    useStore.setState({ snapshot, selection: new Set(), selectedTrackId: "keys", editingClipId: null, exec, ensurePeaks: vi.fn(), agentBusy: false });
    useTaskStore.setState({ current: null, signal: null });
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove();
    useStore.setState(original);
    useTaskStore.setState({ current: null, signal: null });
  });

  it("baseline: with Moshi idle every edit button is enabled", () => {
    act(() => root.render(React.createElement(Arrangement, { snapshot })));
    for (const id of EDIT_BUTTONS) expect(button(id).disabled, id).toBe(false);
  });

  it("agentBusy with no live task (a dock batch) disables every edit button, with a reason", () => {
    useStore.setState({ agentBusy: true });
    expect(useTaskStore.getState().current).toBeNull();
    act(() => root.render(React.createElement(Arrangement, { snapshot })));
    for (const id of EDIT_BUTTONS) {
      expect(button(id).disabled, id).toBe(true);
      expect(button(id).title, id).toMatch(/Moshi is working/);
    }
    act(() => { for (const id of EDIT_BUTTONS) button(id).click(); });
    expect(exec).not.toHaveBeenCalled();
    // Import audio only opens the Browser (no edit), so it stays available
    expect(button("v3-import-audio").disabled).toBe(false);
  });

  it("a live loop task disables every edit button too, and they come back when it ends", () => {
    act(() => useTaskStore.setState({ current: liveTask(), signal: { aborted: false } }));
    act(() => root.render(React.createElement(Arrangement, { snapshot })));
    for (const id of EDIT_BUTTONS) expect(button(id).disabled, id).toBe(true);
    act(() => useTaskStore.setState({ current: null, signal: null }));
    for (const id of EDIT_BUTTONS) expect(button(id).disabled, id).toBe(false);
  });

  it("+ MIDI clip keeps its own condition: disabled with no MIDI-capable track selected, even when idle", () => {
    useStore.setState({ selectedTrackId: null });
    act(() => root.render(React.createElement(Arrangement, { snapshot })));
    expect(button("v3-add-midi-clip").disabled).toBe(true);
    expect(button("v3-add-midi-clip").title).toMatch(/Select a MIDI track/);
    expect(button("v3-add-audio").disabled).toBe(false);
  });
});
