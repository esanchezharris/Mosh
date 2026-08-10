import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsTimeline } from "./ProToolsTimeline";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

vi.mock("../ui/clipRenderers", async () => {
  const actual = await vi.importActual<typeof import("../ui/clipRenderers")>("../ui/clipRenderers");
  return { ...actual, ClipWave: () => React.createElement("canvas") };
});

const CLIP_ID = "audio-clip";
const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-inline-gain.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "audio-track",
    index: 0,
    name: "Lead Vocal",
    type: "audio",
    clips: [{
      id: CLIP_ID,
      name: "Verse Take",
      type: "wave",
      start: 2,
      length: 4,
      offset: 0,
      gainDb: -6,
      hasRenderLayer: false,
    }],
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return React.createElement(ProToolsTimeline, {
    snapshot: SNAPSHOT,
    contentWidth: 800,
    scrollRef,
    onScroll: () => {},
    onSpotClip: () => {},
  });
}

describe("Pro Tools inline clip gain", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  const slider = () => {
    const control = host.querySelector<HTMLElement>('[role="slider"][data-testid="pt-clip-gain-handle"]');
    if (!control) throw new Error("inline clip gain handle did not render");
    return control;
  };

  const pointer = (element: HTMLElement, type: string, init: PointerEventInit) => {
    act(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })));
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selection: new Set([CLIP_ID]),
      pxPerSec: 100,
      projectEpoch: 80,
      peaks: { [CLIP_ID]: [[-0.5, 0.5]] },
      ensurePeaks: vi.fn(),
      exec,
    });
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      selection: originalState.selection,
      pxPerSec: originalState.pxPerSec,
      projectEpoch: originalState.projectEpoch,
      peaks: originalState.peaks,
      ensurePeaks: originalState.ensurePeaks,
      exec: originalState.exec,
    });
    vi.restoreAllMocks();
  });

  it("shows the selected clip value and scales its waveform from snapshot gain", () => {
    // Given: a selected audio clip whose static gain is -6 dB.
    const control = slider();
    const stack = host.querySelector<HTMLElement>("[data-testid=pt-audio-clip-stack]");
    const line = host.querySelector<HTMLElement>("[data-testid=pt-clip-gain-line]");
    if (!stack || !line) throw new Error("inline gain feedback did not render");

    // When: the timeline paints the clip from the snapshot.
    const scale = Number(stack.style.getPropertyValue("--pt-clip-gain-scale"));

    // Then: assistive value text, the gain line, and the dB amplitude transform agree.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(control.getAttribute("aria-valuetext")).toBe("-6.0 dB");
    expect(scale).toBeCloseTo(0.5011872336, 8);
    expect(line.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps an upward pointer draft local until release and commits its exact gain", () => {
    // Given: pointer capture begins on the selected clip's -6 dB handle.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 4, button: 0, clientY: 60 });

    // When: the producer drags 20 px upward, then releases.
    pointer(control, "pointermove", { pointerId: 4, buttons: 1, clientY: 40 });
    expect(control.getAttribute("aria-valuenow")).toBe("-1");
    expect(exec).not.toHaveBeenCalled();
    pointer(control, "pointerup", { pointerId: 4, clientY: 40 });

    // Then: one MoshOps command commits the previewed value.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("set_clip_gain", { clipId: CLIP_ID, gainDb: -1 });
  });

  it("abandons a pointer draft when the browser cancels it", () => {
    // Given: an upward drag has previewed a different clip gain.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 5, button: 0, clientY: 60 });
    pointer(control, "pointermove", { pointerId: 5, buttons: 1, clientY: 40 });
    expect(control.getAttribute("aria-valuenow")).toBe("-1");

    // When: pointer capture is cancelled before release.
    pointer(control, "pointercancel", { pointerId: 5, clientY: 40 });

    // Then: the snapshot value returns and no command is issued.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(exec).not.toHaveBeenCalled();
  });

  it("cancels an active pointer draft with Escape", () => {
    // Given: an active gesture has previewed a gain above the snapshot value.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 7, button: 0, clientY: 60 });
    pointer(control, "pointermove", { pointerId: 7, buttons: 1, clientY: 40 });
    expect(control.getAttribute("aria-valuenow")).toBe("-1");

    // When: the producer presses Escape before releasing the pointer.
    act(() => control.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })));

    // Then: the snapshot value returns and nothing enters the command trail.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not address the old clip after a project epoch change", () => {
    // Given: an inline gain drag is active for the current project.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 6, button: 0, clientY: 60 });
    pointer(control, "pointermove", { pointerId: 6, buttons: 1, clientY: 40 });

    // When: the project is replaced before the matching pointer release.
    act(() => useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 })));
    pointer(control, "pointerup", { pointerId: 6, clientY: 40 });

    // Then: the preview is invalidated and the stale clip receives no command.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(exec).not.toHaveBeenCalled();
  });

  it("supports precise keyboard adjustment through the same command seam", () => {
    // Given: keyboard focus is on the selected clip's gain handle.
    const control = slider();
    control.focus();

    // When: ArrowUp requests one supported gain step.
    act(() => control.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    })));

    // Then: the visible value and command both advance by 0.5 dB.
    expect(control.getAttribute("aria-valuenow")).toBe("-5.5");
    expect(exec).toHaveBeenCalledWith("set_clip_gain", { clipId: CLIP_ID, gainDb: -5.5 });
  });

  it("keeps the reference line visible while hiding the handle on an unselected clip", () => {
    // Given: the audio clip loses selection.
    act(() => useStore.setState({ selection: new Set() }));

    // Then: its gain remains legible without adding an inactive focus target.
    expect(host.querySelector("[data-testid=pt-clip-gain-line]")).not.toBeNull();
    expect(host.querySelector("[data-testid=pt-clip-gain-handle]")).toBeNull();
  });
});
