import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, Snapshot } from "../types";
import { useStore, type State } from "../store";
import { useShell } from "../v2/shellState";
import { useProTools } from "./proToolsState";
import { useProToolsKeys } from "./useProToolsKeys";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-fades-shortcut.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "audio-track",
    index: 0,
    name: "Audio",
    type: "audio",
    clips: [{
      id: "audio-clip",
      name: "Verse",
      type: "wave",
      start: 0,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
    }],
  }, {
    id: "midi-track",
    index: 1,
    name: "Instrument",
    type: "midi",
    clips: [{
      id: "midi-clip",
      name: "Keys",
      type: "midi",
      start: 4,
      length: 4,
      offset: 0,
      notes: [],
      hasRenderLayer: false,
    }],
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

function Harness({ onOpenFades }: { readonly onOpenFades: () => void }) {
  useProToolsKeys(onOpenFades);
  return React.createElement("div");
}

describe("useProToolsKeys Create Fades shortcut", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onOpenFades: ReturnType<typeof vi.fn>;
  let exec: ReturnType<typeof vi.fn>;
  let runAtomic: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;
  const originalRunAtomic = useStore.getState().runAtomic;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onOpenFades = vi.fn();
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    runAtomic = vi.fn(async (_label: string, body: (run: State["exec"]) => Promise<void>) => body(exec));
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    useProTools.getState().resetForProject(useProTools.getState().projectEpoch + 1);
    useStore.setState({
      snapshot: SNAPSHOT,
      selection: new Set(),
      editingClipId: null,
      lastError: null,
      exec,
      runAtomic,
    });
    act(() => root.render(React.createElement(Harness, { onOpenFades })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: null,
      selection: new Set(),
      editingClipId: null,
      exec: originalExec,
      runAtomic: originalRunAtomic,
    });
  });

  it("opens Command+F only for an eligible audio selection", () => {
    useStore.setState({ selection: new Set(["audio-clip"]), editingClipId: "audio-clip" });
    const eligible = commandF();
    act(() => window.dispatchEvent(eligible));
    expect(eligible.defaultPrevented).toBe(true);
    expect(onOpenFades).toHaveBeenCalledTimes(1);

    onOpenFades.mockClear();
    useStore.setState({ selection: new Set(["midi-clip"]), editingClipId: "midi-clip" });
    const ineligible = commandF();
    act(() => window.dispatchEvent(ineligible));
    expect(ineligible.defaultPrevented).toBe(true);
    expect(onOpenFades).not.toHaveBeenCalled();
  });

  it("quick-applies the default fade with Command+Control+F without opening the dialog", async () => {
    useStore.setState({ selection: new Set(["audio-clip"]), editingClipId: "audio-clip" });
    const quickApply = commandF({ ctrlKey: true });

    act(() => window.dispatchEvent(quickApply));

    expect(quickApply.defaultPrevented).toBe(true);
    expect(onOpenFades).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runAtomic).toHaveBeenCalledWith("create default fades", expect.any(Function)));
    expect(exec).toHaveBeenCalledWith("set_clip_fade", {
      clipId: "audio-clip",
      fadeInSec: 0.01,
      fadeOutSec: 0.01,
      curveIn: "linear",
      curveOut: "linear",
    });
  });

  it("surfaces a rejected default fade in the shell error state", async () => {
    exec.mockResolvedValueOnce({ ok: false, command: "set_clip_fade", error: "clip locked" });
    useStore.setState({ selection: new Set(["audio-clip"]), editingClipId: "audio-clip" });

    act(() => window.dispatchEvent(commandF({ ctrlKey: true })));

    await vi.waitFor(() => expect(useStore.getState().lastError).toBe("clip locked"));
    expect(onOpenFades).not.toHaveBeenCalled();
  });
});

function commandF(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}
