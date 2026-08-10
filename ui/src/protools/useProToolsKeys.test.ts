import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, Snapshot } from "../types";
import { useStore } from "../store";
import { useShell } from "../v2/shellState";
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
  annotations: [
    { id: "marker-1", text: "Verse", beat: 4 },
    { id: "marker-2", text: "Hook", beat: 12 },
  ],
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
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selection: new Set<string>(),
      peaks: {},
      projectEpoch: 7,
      selectedTrackId: "track-1",
      pxPerSec: 80,
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
    useShell.setState({ timeRange: null, timeRangeDragging: false });
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

  it("toggles Normal and Single Zoom with a repeated F5", () => {
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "F5", bubbles: true, cancelable: true,
    })));
    expect(useProTools.getState().activeTool).toBe("zoomer");
    expect(useProTools.getState().singleZoomEnabled).toBe(false);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "F5", bubbles: true, cancelable: true,
    })));
    expect(useProTools.getState().activeTool).toBe("zoomer");
    expect(useProTools.getState().singleZoomEnabled).toBe(true);
  });

  it("does not claim mode keys while an editable control has focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", bubbles: true, cancelable: true })));

    expect(useProTools.getState().editMode).toBe("slip");
    input.remove();
  });

  it("toggles Link Timeline and Edit Selection with Shift+Slash", () => {
    // Given a linked Edit range.
    act(() => useShell.setState({ timeRange: { start: 2, end: 6 } }));

    // When the documented shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "?",
      code: "Slash",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));

    // Then the Timeline becomes independent without an engine command.
    expect(useProTools.getState().timelineEditLinked).toBe(false);
    expect(useProTools.getState().timelineSelection).toEqual({ start: 2, end: 6 });
    expect(execCalls).toEqual([]);
  });

  it("toggles Link Track and Edit Selection with Shift+T", () => {
    // Given the default linked active track.
    expect(useStore.getState().selectedTrackId).toBe("track-1");

    // When the documented shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "T",
      code: "KeyT",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));

    // Then Track/Edit becomes independent without issuing a project command.
    expect(useProTools.getState().trackEditLinked).toBe(false);
    expect(useProTools.getState().editSelectionTrackId).toBe("track-1");
    expect(execCalls).toEqual([]);
  });

  it("focuses the Edit Selection Start indicator with unmodified Slash", () => {
    const start = document.createElement("input");
    start.id = "pt-selection-start";
    start.value = "2.1.1";
    document.body.appendChild(start);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      code: "NumpadDivide",
      bubbles: true,
      cancelable: true,
    })));

    expect(document.activeElement).toBe(start);
    expect(start.selectionStart).toBe(0);
    expect(start.selectionEnd).toBe(start.value.length);
    start.remove();
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

  it("uses R and T for horizontal zoom while the editing timeline owns focus", () => {
    const canvas = document.createElement("div");
    canvas.className = "pt-timeline-scroll";
    canvas.tabIndex = 0;
    document.body.appendChild(canvas);
    canvas.focus();

    act(() => canvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: "r", bubbles: true, cancelable: true,
    })));
    expect(useStore.getState().pxPerSec).toBe(56);

    act(() => canvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: "t", bubbles: true, cancelable: true,
    })));
    expect(useStore.getState().pxPerSec).toBe(80);
    canvas.remove();
  });

  it("recalls zoom presets 1-5 only from the editing timeline", () => {
    useProTools.getState().setHorizontalZoomPreset(0, 160);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    act(() => outside.dispatchEvent(new KeyboardEvent("keydown", {
      key: "1", bubbles: true, cancelable: true,
    })));
    expect(useStore.getState().pxPerSec).toBe(80);

    const canvas = document.createElement("div");
    canvas.className = "pt-timeline-scroll";
    canvas.tabIndex = 0;
    document.body.appendChild(canvas);
    canvas.focus();
    act(() => canvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: "1", bubbles: true, cancelable: true,
    })));
    expect(useStore.getState().pxPerSec).toBe(160);
    outside.remove();
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

  it("opens a new Memory Location at the playhead with numeric keypad Enter", () => {
    useStore.setState({ transport: { ...SNAPSHOT.transport, position: 3.5 } });

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "NumpadEnter", bubbles: true, cancelable: true,
    })));

    expect(useProTools.getState().memoryLocationsOpen).toBe(true);
    expect(useProTools.getState().memoryLocationEditor).toEqual({ mode: "create", seconds: 3.5 });
    expect(execCalls).toEqual([]);
  });

  it("recalls a numbered Memory Location with period-number-period", async () => {
    for (const init of [
      { key: ".", code: "NumpadDecimal" },
      { key: "2", code: "Numpad2" },
      { key: ".", code: "NumpadDecimal" },
    ]) {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
        ...init, bubbles: true, cancelable: true,
      })));
    }

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { position: 6 },
    }));
  });

  it("steps to the next and previous Memory Locations with period plus or minus", async () => {
    useStore.setState({ transport: { ...SNAPSHOT.transport, position: 2.5 } });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: ".", code: "NumpadDecimal", bubbles: true, cancelable: true,
    })));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "+", code: "NumpadAdd", bubbles: true, cancelable: true,
    })));
    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { position: 6 },
    }));

    execCalls = [];
    useStore.setState({ transport: { ...SNAPSHOT.transport, position: 5 } });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: ".", code: "NumpadDecimal", bubbles: true, cancelable: true,
    })));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "-", code: "NumpadSubtract", bubbles: true, cancelable: true,
    })));
    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { position: 2 },
    }));
  });

  it("uses double period for the last recalled location but forgets it after project replacement", async () => {
    const press = (key: string, code: string) => act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key, code, bubbles: true, cancelable: true,
    })));
    press(".", "NumpadDecimal");
    press("1", "Numpad1");
    press(".", "NumpadDecimal");
    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { position: 2 },
    }));

    execCalls = [];
    press(".", "NumpadDecimal");
    press(".", "NumpadDecimal");
    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { position: 2 },
    }));

    execCalls = [];
    useStore.setState({ projectEpoch: 8 });
    press(".", "NumpadDecimal");
    press(".", "NumpadDecimal");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
