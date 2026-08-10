import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { Clip, CommandResult, Snapshot } from "../../types";
import { proToolsGestureTable } from "../../protools/proToolsGestureTable";
import { useShell } from "../shellState";
import { ClipView } from "./ClipView";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});

const CLIP: Clip = {
  id: "vocal-comp",
  name: "Lead Comp",
  type: "wave",
  start: 1,
  length: 4,
  offset: 0,
  sourceFile: "/tmp/lead.wav",
  hasRenderLayer: false,
};

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/comp.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{ id: "vocal", index: 0, name: "Vocal", type: "audio", clips: [CLIP] }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("shared clip time-range gesture", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const clipElement = () => {
    const clip = host.querySelector<HTMLElement>("[data-testid=v2-clip]");
    if (!clip) throw new Error("clip is missing");
    clip.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 400, height: 80 });
    return clip;
  };

  const beginRange = (pointerId: number) => {
    const clip = clipElement();
    act(() => clip.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId, button: 0, clientX: 200, clientY: 108,
    })));
    act(() => clip.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId, buttons: 1, clientX: 350, clientY: 108,
    })));
    return clip;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      exec,
      projectEpoch: 90,
      pxPerSec: 100,
      snap: false,
      selection: new Set<string>(),
      ensurePeaks: vi.fn(),
    });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    act(() => root.render(React.createElement(ClipView, {
      clip: CLIP,
      trackType: "audio",
      snapshot: SNAPSHOT,
      clipHeaderPx: 44,
      gestureTable: () => proToolsGestureTable("audio", true, "selector"),
    })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null, selection: new Set<string>() });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    vi.restoreAllMocks();
  });

  it("marks a header-drawn selection as dragging until pointerup", () => {
    const clip = beginRange(51);
    expect(useShell.getState().timeRangeDragging).toBe(true);
    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 3.5 });

    act(() => clip.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 51, clientX: 350, clientY: 108,
    })));
    expect(useShell.getState().timeRangeDragging).toBe(false);
    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 3.5 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("clears an in-progress range on pointer cancellation, Escape, and stale pointerup", () => {
    let clip = beginRange(52);
    act(() => clip.dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true, pointerId: 52, clientX: 350, clientY: 108,
    })));
    expect(useShell.getState().timeRange).toBeNull();
    expect(useShell.getState().timeRangeDragging).toBe(false);

    clip = beginRange(53);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(useShell.getState().timeRange).toBeNull();
    expect(useShell.getState().timeRangeDragging).toBe(false);

    clip = beginRange(54);
    useStore.setState({ projectEpoch: 91 });
    act(() => clip.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 54, clientX: 350, clientY: 108,
    })));
    expect(useShell.getState().timeRange).toBeNull();
    expect(useShell.getState().timeRangeDragging).toBe(false);
  });

  it("clears an in-progress range if project replacement unmounts the clip", () => {
    beginRange(55);
    expect(useShell.getState().timeRangeDragging).toBe(true);

    act(() => root.render(null));

    expect(useShell.getState().timeRange).toBeNull();
    expect(useShell.getState().timeRangeDragging).toBe(false);
  });
});
