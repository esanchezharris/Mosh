import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../types";
import { useStore } from "../store";
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

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onOpenFades = vi.fn();
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    useProTools.getState().resetForProject(useProTools.getState().projectEpoch + 1);
    useStore.setState({ snapshot: SNAPSHOT, selection: new Set(), editingClipId: null });
    act(() => root.render(React.createElement(Harness, { onOpenFades })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null, selection: new Set(), editingClipId: null });
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
});

function commandF(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
}
