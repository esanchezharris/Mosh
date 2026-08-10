import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, Snapshot } from "../types";
import { useStore } from "../store";
import { useProTools } from "./proToolsState";
import { transientCandidates, useProToolsKeys } from "./useProToolsKeys";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-keys.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "track-1",
    index: 0,
    name: "Audio",
    type: "audio",
    clips: [{
      id: "clip-1",
      name: "Verse",
      type: "wave",
      start: 2,
      length: 4,
      offset: 0,
      sourceFile: "/tmp/verse.wav",
      hasRenderLayer: false,
    }],
  }, {
    id: "track-2",
    index: 1,
    name: "Instrument",
    type: "midi",
    isInstrument: true,
    clips: [{
      id: "clip-2",
      name: "Keys",
      type: "midi",
      start: 8,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
      notes: [],
    }],
  }],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

function Harness() {
  useProToolsKeys();
  return React.createElement("div");
}

describe("useProToolsKeys", () => {
  let host: HTMLDivElement;
  let root: Root;
  let execCalls: { readonly command: string; readonly args?: Record<string, unknown> }[];
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    execCalls = [];
    useProTools.getState().resetForProject(useProTools.getState().projectEpoch + 1);
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selection: new Set<string>(),
      peaks: {},
      projectEpoch: 7,
      selectedTrackId: "track-1",
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: null,
      selection: new Set<string>(),
      peaks: {},
      selectedTrackId: null,
      exec: originalExec,
    });
    vi.restoreAllMocks();
  });

  it.each([
    ["F1", "shuffle"],
    ["F2", "slip"],
    ["F3", "spot"],
    ["F4", "grid"],
  ] as const)("selects %s's edit mode without sending an engine command", (key, editMode) => {
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

    expect(useProTools.getState().editMode).toBe(editMode);
    expect(execCalls).toEqual([]);
  });

  it.each([
    ["F5", "zoomer"],
    ["F6", "trimmer"],
    ["F7", "selector"],
    ["F8", "grabber"],
    ["F9", "scrubber"],
    ["F10", "pencil"],
  ] as const)("selects %s's tool and leaves Smart Tool mode", (key, activeTool) => {
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

    expect(useProTools.getState().activeTool).toBe(activeTool);
    expect(useProTools.getState().smartToolEnabled).toBe(false);
  });

  it("does not claim mode keys while an editable control has focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", bubbles: true, cancelable: true })));

    expect(useProTools.getState().editMode).toBe("slip");
    input.remove();
  });

  it("tabs to the next clip boundary when transient data is unavailable", async () => {
    useStore.setState({ transport: { ...SNAPSHOT.transport, position: 1 } });

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { position: 2 },
    }));
  });

  it.each([
    ["toolbar", "pt-toolbar"],
    ["Track List", "pt-track-list"],
    ["Clip List", "pt-clip-list"],
    ["detail dock", "pt-detail-dock"],
    ["settings", "pt-settings-dialog"],
  ])("does not steal Tab from %s controls", async (_name, ownerClass) => {
    useStore.setState({ transport: { ...SNAPSHOT.transport, position: 1 } });
    const control = document.createElement("button");
    const owner = document.createElement("section");
    owner.className = ownerClass;
    owner.appendChild(control);
    document.body.appendChild(owner);
    control.focus();

    act(() => control.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", bubbles: true, cancelable: true,
    })));

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(execCalls).toEqual([]);
    owner.remove();
  });

  it("keeps transient navigation available from a focused editing canvas", async () => {
    useStore.setState({ transport: { ...SNAPSHOT.transport, position: 1 } });
    const canvas = document.createElement("div");
    canvas.className = "pt-timeline-scroll";
    canvas.tabIndex = 0;
    document.body.appendChild(canvas);
    canvas.focus();

    act(() => canvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", bubbles: true, cancelable: true,
    })));

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { position: 2 },
    }));
    canvas.remove();
  });

  it("moves the selected clip by the local nudge amount through the command seam", async () => {
    useStore.setState({ selection: new Set(["clip-1"]) });

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "+",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })));

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "move_clip",
      args: { clipId: "clip-1", start: 2.25 },
    }));
  });

  it("toggles the selected track's two common Track Views with Minus", () => {
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "-", code: "Minus", bubbles: true, cancelable: true,
    })));
    expect(useProTools.getState().trackViews["track-1"]).toBe("volume");

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "-", code: "Minus", bubbles: true, cancelable: true,
    })));
    expect(useProTools.getState().trackViews["track-1"]).toBe("waveform");

    act(() => useStore.setState({ selectedTrackId: "track-2" }));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "-", code: "Minus", bubbles: true, cancelable: true,
    })));
    expect(useProTools.getState().trackViews["track-2"]).toBe("notes");
    expect(execCalls).toEqual([]);
  });

  it("leaves a consumed Minus event with the focused automation editor", () => {
    const event = new KeyboardEvent("keydown", {
      key: "-", code: "Minus", bubbles: true, cancelable: true,
    });
    event.preventDefault();

    act(() => window.dispatchEvent(event));

    expect(useProTools.getState().trackViews).toEqual({});
    expect(execCalls).toEqual([]);
  });
});

describe("Pro Tools transient candidates", () => {
  it("maps a waveform onset bucket onto its clip's timeline position", () => {
    const peaks = {
      "clip-1": [[-0.1, 0.1], [-0.2, 0.2], [-0.9, 0.8], [-0.3, 0.3]],
    } satisfies Record<string, [number, number][]>;

    expect(transientCandidates(SNAPSHOT, peaks)).toEqual([4]);
  });
});
