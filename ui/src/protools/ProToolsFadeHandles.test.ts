import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, CommandResult, Track } from "../types";
import { useStore } from "../store";
import { ProToolsFadeHandles } from "./ProToolsFadeHandles";
import { proToolsFadePath } from "./proToolsFades";

const CLIP: Clip = {
  id: "audio-clip",
  name: "Vocal",
  type: "wave",
  start: 0,
  length: 4,
  offset: 0,
  hasRenderLayer: false,
};

const TRACK: Track = {
  id: "audio-track",
  index: 0,
  name: "Vocal",
  type: "audio",
  clips: [CLIP, {
    id: "audio-neighbor",
    name: "Vocal Double",
    type: "wave",
    start: 3,
    length: 4,
    offset: 0,
    hasRenderLayer: false,
  }],
};

describe("ProToolsFadeHandles project epoch cancellation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;

  const dispatchPointer = (element: HTMLButtonElement, type: string, init: PointerEventInit) => {
    act(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })));
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ pxPerSec: 100, projectEpoch: 51, exec });
    act(() => root.render(React.createElement(ProToolsFadeHandles, { clip: CLIP, track: TRACK })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ exec: originalExec });
    vi.restoreAllMocks();
  });

  it("does not execute a fade drag after the project epoch changes", () => {
    // Given: an in-handle fade drag has a nonzero preview value.
    const handle = host.querySelector<HTMLButtonElement>('button[aria-label^="Fade in"]');
    if (!handle) throw new Error("fade-in handle did not render");
    dispatchPointer(handle, "pointerdown", { pointerId: 9, button: 0, clientX: 10, clientY: 20 });
    dispatchPointer(handle, "pointermove", { pointerId: 9, buttons: 1, clientX: 110, clientY: 20 });

    // When: the project changes before pointer release.
    useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 }));
    dispatchPointer(handle, "pointerup", { pointerId: 9, clientX: 110, clientY: 20 });

    // Then: the old clip is never addressed by set_clip_fade.
    expect(exec).not.toHaveBeenCalled();
  });

  it("abandons a fade preview when the drag is cancelled", () => {
    // Given: an in-handle drag has produced a nonzero preview.
    const handle = host.querySelector<HTMLButtonElement>('button[aria-label^="Fade in"]');
    const fadeLine = host.querySelector<HTMLElement>(".pt-fade-line.in");
    if (!handle || !fadeLine) throw new Error("fade-in controls did not render");
    dispatchPointer(handle, "pointerdown", { pointerId: 10, button: 0, clientX: 10, clientY: 20 });
    dispatchPointer(handle, "pointermove", { pointerId: 10, buttons: 1, clientX: 110, clientY: 20 });
    expect(fadeLine.style.width).toBe("100px");

    // When: the browser cancels the drag and an unrelated release follows.
    dispatchPointer(handle, "pointercancel", { pointerId: 10, clientX: 110, clientY: 20 });
    dispatchPointer(handle, "pointerup", { pointerId: 11, clientX: 110, clientY: 20 });

    // Then: no fade command is committed and the preview is gone.
    expect(exec).not.toHaveBeenCalled();
    expect(fadeLine.style.width).toBe("0px");
  });

  it("draws the enabled overlap as an original crossfade curve", () => {
    act(() => root.render(React.createElement(ProToolsFadeHandles, {
      clip: { ...CLIP, autoCrossfade: true },
      track: TRACK,
    })));

    const region = host.querySelector<HTMLElement>("[data-testid=pt-crossfade-region]");
    if (!region) throw new Error("crossfade region did not render");
    expect(region.style.left).toBe("300px");
    expect(region.style.width).toBe("100px");
    expect(region.querySelectorAll("path")).toHaveLength(2);
  });

  it("draws persisted edge shapes and an explicit two-curve overlap after Auto Crossfade is disabled", () => {
    const neighbor = TRACK.clips.find((clip) => clip.id === "audio-neighbor");
    if (!neighbor) throw new Error("audio neighbor fixture is missing");
    const shapedClip = {
      ...CLIP,
      autoCrossfade: false,
      fadeInSec: 0.5,
      fadeOutSec: 1,
      fadeInType: 2,
      fadeOutType: 3,
    };
    const shapedTrack: Track = {
      ...TRACK,
      clips: [shapedClip, {
        ...neighbor,
        fadeInSec: 1,
        fadeInType: 2,
      }],
    };
    act(() => root.render(React.createElement(ProToolsFadeHandles, {
      clip: shapedClip,
      track: shapedTrack,
    })));

    const fadeInPath = host.querySelector(".pt-fade-line.in path");
    const fadeOutPath = host.querySelector(".pt-fade-line.out path");
    expect(fadeInPath?.getAttribute("d")).toBe(proToolsFadePath("convex", "in"));
    expect(fadeOutPath?.getAttribute("d")).toBe(proToolsFadePath("concave", "out"));
    const region = host.querySelector<HTMLElement>("[data-testid=pt-crossfade-region]");
    expect(region?.dataset.crossfadeMode).toBe("explicit");
    expect(region?.querySelector("path.in")?.getAttribute("d")).toBe(proToolsFadePath("convex", "in"));
    expect(region?.querySelector("path.out")?.getAttribute("d")).toBe(proToolsFadePath("concave", "out"));
  });
});
