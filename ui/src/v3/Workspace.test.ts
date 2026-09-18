import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Arrangement } from "./Arrangement";
import { LeftRail } from "./LeftRail";
import { TopBar } from "./TopBar";
import { useV3 } from "./shellState";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

vi.mock("../bridge", async (original) => ({ ...await original<typeof import("../bridge")>(), onEvent: vi.fn(() => () => {}) }));
const snapshot: Snapshot = {
  schemaVersion: 1,
  session: { key: { tonic: "A", mode: "minor" }, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, sampleRate: 48000, length: 4, editFile: "workspace.mosh", countInBars: 0 },
  tracks: [{ id: "keys", index: 0, name: "Keys", type: "audio", clips: [{ id: "melody", name: "Melody", type: "midi", start: 0, offset: 0, length: 4, hasRenderLayer: false, notes: [] }] },
    { id: "audio", index: 1, name: "Audio", type: "audio", clips: [] }],
  transport: { playing: false, recording: false, looping: false, position: 0, loopStart: 0, loopEnd: 4 },
};

describe("V3 ordinary workspace controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  const original = useStore.getState();
  const shell = useV3.getState();
  const exec = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<CommandResult> => ({ ok: true, command }));
  function element<T extends HTMLElement>(selector: string): T {
    const el = host.querySelector<T>(selector);
    if (!el) throw new Error(`Missing ${selector}`);
    return el;
  }
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    exec.mockClear();
    useStore.setState({ snapshot, view: "arrange", selection: new Set(["melody"]), selectedTrackId: "keys", editingClipId: null, exec, ensurePeaks: vi.fn() });
    useV3.setState({ pane: "none", posture: "studio" });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); useStore.setState(original); useV3.setState(shell); });

  it("opens and closes the real mixer view and returns from Booth", () => {
    useV3.setState({ posture: "booth", pane: "browser" });
    act(() => root.render(React.createElement(LeftRail)));
    act(() => element<HTMLButtonElement>('[data-testid="v3-rail-mixer"]').click());
    expect(useStore.getState().view).toBe("mixer");
    expect(useV3.getState().posture).toBe("studio");
    expect(element('[data-testid="v3-rail-mixer"]').getAttribute("aria-pressed")).toBe("true");
    act(() => element<HTMLButtonElement>('[data-testid="v3-rail-mixer"]').click());
    expect(useStore.getState().view).toBe("arrange");
  });
  it("selects a track header without changing session content", () => {
    act(() => root.render(React.createElement(Arrangement, { snapshot })));
    act(() => element<HTMLButtonElement>('[aria-label="Select track Audio"]').click());
    expect(useStore.getState().selectedTrackId).toBe("audio");
    expect(useStore.getState().selection.size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });
  it("opens an existing MIDI clip with a double click or Enter", () => {
    act(() => root.render(React.createElement(Arrangement, { snapshot })));
    act(() => element('[data-clip-id="melody"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(useStore.getState().editingClipId).toBe("melody");
    act(() => useStore.setState({ editingClipId: null }));
    act(() => element('[data-clip-id="melody"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(useStore.getState().editingClipId).toBe("melody");
  });
  it("provides a starting action in an empty session", () => {
    act(() => root.render(React.createElement(Arrangement, { snapshot: { ...snapshot, tracks: [] } })));
    expect(element('[data-testid="v3-add-audio"]').textContent).toContain("Audio track");
    act(() => element<HTMLButtonElement>('[data-testid="v3-import-audio"]').click());
    expect(useV3.getState().pane).toBe("browser");
    expect(useV3.getState().browserTab).toBe("files");
  });
  it("sets count-in through the existing command, from actual session state", async () => {
    useV3.setState({ posture: "booth" });
    act(() => root.render(React.createElement(TopBar, { snapshot })));
    const select = element<HTMLSelectElement>('[aria-label="Count-in"]');
    expect(select.value).toBe("0");
    await act(async () => { select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(exec).toHaveBeenCalledWith("set_count_in", { bars: 2 });
    act(() => root.render(React.createElement(TopBar, { snapshot: { ...snapshot, session: { ...snapshot.session, countInBars: 2 } } })));
    expect(select.value).toBe("2");
  });
});
