import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, CommandResult } from "../types";
import { useStore } from "../store";
import { ProToolsFadeHandles } from "./ProToolsFadeHandles";

const CLIP: Clip = {
  id: "audio-clip",
  name: "Vocal",
  type: "wave",
  start: 0,
  length: 4,
  offset: 0,
  hasRenderLayer: false,
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
    act(() => root.render(React.createElement(ProToolsFadeHandles, { clip: CLIP })));
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
});
