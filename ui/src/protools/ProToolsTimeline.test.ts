import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, Snapshot } from "../types";
import { useStore } from "../store";
import { useProTools } from "./proToolsState";
import { ProToolsTimeline } from "./ProToolsTimeline";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

vi.mock("../ui/clipRenderers", async () => {
  const actual = await vi.importActual<typeof import("../ui/clipRenderers")>("../ui/clipRenderers");
  return { ...actual, ClipMidi: () => React.createElement("div") };
});

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-timeline.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "midi-track",
    index: 0,
    name: "MIDI",
    type: "midi",
    clips: [{
      id: "midi-clip",
      name: "Verse",
      type: "midi",
      start: 0,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
      notes: [{ i: 0, pitch: 60, start: 4, length: 2, velocity: 80 }],
    }],
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return React.createElement(ProToolsTimeline, {
    snapshot: SNAPSHOT,
    contentWidth: 600,
    scrollRef,
    onScroll: () => {},
    onSpotClip: openSpot,
  });
}

let openSpot: ReturnType<typeof vi.fn>;

describe("ProToolsTimeline pointer capture", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;

  const clip = () => {
    const element = host.querySelector<HTMLElement>('[data-testid="v2-clip"]');
    if (!element) throw new Error("MIDI clip did not render");
    element.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 400, bottom: 60, width: 400, height: 60, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    return element;
  };

  const dispatchPointer = (element: HTMLElement, type: string, init: PointerEventInit) => {
    act(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })));
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    openSpot = vi.fn();
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selection: new Set<string>(),
      pxPerSec: 100,
      projectEpoch: 41,
      exec,
    });
    useProTools.getState().resetForProject(41);
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null, selection: new Set<string>(), exec: originalExec });
    vi.restoreAllMocks();
  });

  it("routes a blank MIDI edge through timeline capture into ClipView trimming", () => {
    // Given: the only note is in the clip's middle, so the left edge is explicitly blank.
    const element = clip();

    // When: the user edge-drags through the real timeline capture layer and the shared ClipView.
    dispatchPointer(element, "pointerdown", { pointerId: 7, button: 0, clientX: 2, clientY: 50 });
    expect(element.dataset.ptIntent).toBe("trimmer");
    dispatchPointer(element, "pointermove", { pointerId: 7, buttons: 1, clientX: 26, clientY: 50 });
    dispatchPointer(element, "pointerup", { pointerId: 7, clientX: 26, clientY: 50 });

    // Then: the real clip drag reaches the command seam.
    expect(exec).toHaveBeenCalledWith("trim_clip", expect.objectContaining({ clipId: "midi-clip" }));
  });

  it("opens Spot placement after a Grabber click without moving the clip", () => {
    // Given: Spot mode is active and the pointer is over MIDI note content, which is Grabber intent.
    act(() => useProTools.getState().setEditMode("spot"));
    const element = clip();

    // When: the matching primary pointer press and release completes without a drag.
    dispatchPointer(element, "pointerdown", { pointerId: 12, button: 0, clientX: 200, clientY: 30 });
    expect(element.dataset.ptIntent).toBe("grabber");
    dispatchPointer(element, "pointerup", { pointerId: 12, button: 0, clientX: 200, clientY: 30 });

    // Then: the shell requests precise placement and sends no free-move command.
    expect(openSpot).toHaveBeenCalledWith(expect.objectContaining({ id: "midi-clip" }));
    expect(exec).not.toHaveBeenCalled();
  });

  it("opens Spot placement when a focused clip is activated with Enter", () => {
    // Given: Spot mode and Smart Tool are active with keyboard focus on a rendered clip.
    act(() => useProTools.getState().setEditMode("spot"));
    const element = clip();
    element.focus();

    // When: the producer activates the clip from the keyboard.
    act(() => element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })));

    // Then: the same placement request opens without a mutation.
    expect(openSpot).toHaveBeenCalledWith(expect.objectContaining({ id: "midi-clip" }));
    expect(exec).not.toHaveBeenCalled();
  });

  it("abandons Spot placement when the project epoch changes", () => {
    // Given: a Spot-mode Grabber press captures the current project epoch.
    act(() => useProTools.getState().setEditMode("spot"));
    const element = clip();
    dispatchPointer(element, "pointerdown", { pointerId: 13, button: 0, clientX: 200, clientY: 30 });

    // When: the project is replaced before that pointer is released.
    act(() => useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 })));
    dispatchPointer(element, "pointerup", { pointerId: 13, button: 0, clientX: 200, clientY: 30 });

    // Then: the stale clip never opens a placement dialog or mutates the new project.
    expect(openSpot).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("abandons Spot placement when the browser cancels the pointer", () => {
    // Given: a Spot-mode Grabber press is waiting for its matching release.
    act(() => useProTools.getState().setEditMode("spot"));
    const element = clip();
    dispatchPointer(element, "pointerdown", { pointerId: 14, button: 0, clientX: 200, clientY: 30 });

    // When: the browser cancels it and a separate pointer later releases.
    dispatchPointer(element, "pointercancel", { pointerId: 14, clientX: 200, clientY: 30 });
    dispatchPointer(element, "pointerup", { pointerId: 15, clientX: 200, clientY: 30 });

    // Then: the cancelled gesture cannot open a dialog or send a command.
    expect(openSpot).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not execute a Cmd MIDI velocity drag after the project epoch changes", () => {
    // Given: Cmd on a rendered MIDI note starts the timeline-owned velocity drag.
    const element = clip();
    dispatchPointer(element, "pointerdown", {
      pointerId: 8, button: 0, clientX: 200, clientY: 30, metaKey: true,
    });
    dispatchPointer(element, "pointermove", { pointerId: 8, buttons: 1, clientX: 200, clientY: 10, metaKey: true });

    // When: the active project is replaced before the matching pointer release.
    act(() => useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 })));
    dispatchPointer(element, "pointerup", { pointerId: 8, clientX: 200, clientY: 10, metaKey: true });

    // Then: the captured stale gesture reaches no MoshOps mutation.
    expect(exec).not.toHaveBeenCalled();
  });

  it("abandons a Cmd MIDI velocity drag when the pointer is cancelled", () => {
    // Given: Cmd on a MIDI note begins a drag with a nonzero velocity delta.
    const element = clip();
    dispatchPointer(element, "pointerdown", {
      pointerId: 9, button: 0, clientX: 200, clientY: 30, metaKey: true,
    });
    dispatchPointer(element, "pointermove", {
      pointerId: 9, buttons: 1, clientX: 200, clientY: 10, metaKey: true,
    });

    // When: the browser cancels it and a separate pointer later releases.
    dispatchPointer(element, "pointercancel", { pointerId: 9, clientX: 200, clientY: 10, metaKey: true });
    dispatchPointer(element, "pointerup", { pointerId: 10, clientX: 200, clientY: 10, metaKey: true });

    // Then: neither cancellation nor the unrelated release applies note edits.
    expect(exec).not.toHaveBeenCalled();
  });

  it("abandons a marquee when the pointer is cancelled", () => {
    // Given: a blank MIDI area starts a marquee and renders its transient box.
    const element = clip();
    dispatchPointer(element, "pointerdown", { pointerId: 10, button: 0, clientX: 10, clientY: 30 });
    expect(element.dataset.ptIntent).toBe("marquee");
    dispatchPointer(element, "pointermove", { pointerId: 10, buttons: 1, clientX: 110, clientY: 30 });
    expect(host.querySelector(".pt-marquee")).not.toBeNull();

    // When: the browser cancels the drag before a separate pointer releases.
    dispatchPointer(element, "pointercancel", { pointerId: 10, clientX: 110, clientY: 30 });
    dispatchPointer(element, "pointerup", { pointerId: 11, clientX: 110, clientY: 30 });

    // Then: the transient selection gesture is removed without selecting a clip.
    expect(host.querySelector(".pt-marquee")).toBeNull();
    expect(useStore.getState().selection).toEqual(new Set<string>());
  });
});
