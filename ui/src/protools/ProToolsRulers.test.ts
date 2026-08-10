import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { ProToolsRulers } from "./ProToolsRulers";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-marker-ruler.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: {
    playing: false,
    recording: false,
    position: 1,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
  annotations: [{ id: "marker-1", text: "Verse", beat: 4, color: "#4a90d9" }],
};

describe("Pro Tools Marker ruler", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      pxPerSec: 100,
      snap: false,
      snapDivision: "1/4",
      projectEpoch: 60,
      exec,
    });
    useProTools.getState().resetForProject(60);
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    act(() => root.render(React.createElement(ProToolsRulers, {
      snapshot: SNAPSHOT,
      rulersVisible: useProTools.getState().rulersVisible,
      contentWidth: 3_200,
      fieldRef: React.createRef<HTMLDivElement>(),
      getScrollLeft: () => 0,
    })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      projectEpoch: originalState.projectEpoch,
      exec: originalState.exec,
    });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  function button(testId: string): HTMLButtonElement {
    const control = host.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`);
    if (!control) throw new Error(`${testId} is missing`);
    return control;
  }

  function ruler(id = "barsBeats"): HTMLButtonElement {
    const control = host.querySelector<HTMLButtonElement>(`[data-ruler=${id}]`);
    if (!control) throw new Error(`${id} ruler is missing`);
    control.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 3_200, bottom: 18,
      width: 3_200, height: 18, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    return control;
  }

  const pointer = (
    element: HTMLElement,
    type: string,
    clientX: number,
    pointerId = 1,
    altKey = false,
  ) => act(() => element.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: type === "pointerdown" ? 0 : undefined,
    buttons: type === "pointermove" ? 1 : 0,
    clientX,
    pointerId,
    altKey,
  })));

  it("renders persistent markers and exposes create, recall, edit, and Alt-remove gestures", async () => {
    expect(host.querySelectorAll("[data-ruler]")).toHaveLength(5);
    expect(host.querySelector("[data-ruler=markers]")?.textContent).toContain("Verse");

    await act(async () => button("pt-memory-ruler-add").click());
    expect(useProTools.getState().memoryLocationEditor).toEqual({ mode: "create", seconds: 1 });

    await act(async () => button("pt-memory-marker-marker-1").click());
    expect(exec).toHaveBeenCalledWith("set_transport", { position: 2 });

    act(() => button("pt-memory-marker-marker-1")
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(useProTools.getState().memoryLocationEditor).toEqual({
      mode: "edit",
      annotationId: "marker-1",
    });

    await act(async () => button("pt-memory-marker-marker-1")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(exec).toHaveBeenCalledWith("remove_annotation", { annotationId: "marker-1" });
  });

  it("drags a linked Edit selection in a timebase ruler without seeking", () => {
    const bars = ruler();

    pointer(bars, "pointerdown", 400);
    pointer(bars, "pointermove", 650);
    expect(useShell.getState().timeRangeDragging).toBe(true);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 6.5 });
    expect(host.querySelector("[data-testid=pt-ruler-selection]")).not.toBeNull();

    pointer(bars, "pointerup", 650);
    expect(useShell.getState().timeRangeDragging).toBe(false);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 6.5 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("snaps Grid ruler selections while Option temporarily preserves exact placement", () => {
    act(() => {
      useProTools.getState().setEditMode("grid");
      useStore.setState({ snap: true, snapDivision: "bar" });
    });
    const bars = ruler();

    pointer(bars, "pointerdown", 430);
    pointer(bars, "pointermove", 640);
    pointer(bars, "pointerup", 640);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 6 });

    pointer(bars, "pointerdown", 430, 2, true);
    pointer(bars, "pointermove", 640, 2, true);
    pointer(bars, "pointerup", 640, 2, true);
    expect(useShell.getState().timeRange?.start).toBeCloseTo(4.3, 6);
    expect(useShell.getState().timeRange?.end).toBeCloseTo(6.4, 6);
  });

  it("restores the prior selection on pointer cancellation and clears stale project drags", () => {
    const bars = ruler();
    act(() => useShell.setState({ timeRange: { start: 1, end: 2 }, timeRangeDragging: false }));

    pointer(bars, "pointerdown", 400);
    pointer(bars, "pointermove", 650);
    pointer(bars, "pointercancel", 650);
    expect(useShell.getState().timeRange).toEqual({ start: 1, end: 2 });
    expect(useShell.getState().timeRangeDragging).toBe(false);

    pointer(bars, "pointerdown", 400, 3);
    pointer(bars, "pointermove", 650, 3);
    act(() => useStore.setState({ projectEpoch: 61 }));
    expect(useShell.getState().timeRange).toBeNull();
    expect(useShell.getState().timeRangeDragging).toBe(false);
    pointer(bars, "pointerup", 700, 3);
    expect(exec).not.toHaveBeenCalled();
  });

  it("extends a ruler selection from the keyboard and lets a plain click place the playhead", () => {
    const bars = ruler();
    act(() => bars.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));
    expect(useShell.getState().timeRange).toEqual({ start: 1, end: 1.5 });
    expect(exec).not.toHaveBeenCalled();

    act(() => bars.dispatchEvent(new KeyboardEvent("keydown", {
      key: "End",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));
    expect(useShell.getState().timeRange).toEqual({ start: 1, end: 32 });
    act(() => bars.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Home",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));
    expect(useShell.getState().timeRange).toEqual({ start: 0, end: 32 });

    act(() => useShell.setState({ timeRange: { start: 1, end: 2 }, timeRangeDragging: false }));
    pointer(bars, "pointerdown", 400, 4);
    pointer(bars, "pointerup", 400, 4);
    expect(useShell.getState().timeRange).toBeNull();
    expect(exec).toHaveBeenCalledWith("set_transport", { position: 4 });
  });
});
