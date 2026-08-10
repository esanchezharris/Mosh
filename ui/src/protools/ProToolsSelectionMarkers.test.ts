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
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    editFile: "/tmp/protools-selection-markers.mosh",
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
};

type PointerPhase = "pointerdown" | "pointermove" | "pointerup" | "pointercancel";

describe("Pro Tools Timeline selection markers", () => {
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
      snapTriplet: false,
      projectEpoch: 70,
      exec,
    });
    useProTools.getState().resetForProject();
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      pxPerSec: originalState.pxPerSec,
      snap: originalState.snap,
      snapDivision: originalState.snapDivision,
      snapTriplet: originalState.snapTriplet,
      projectEpoch: originalState.projectEpoch,
      exec: originalState.exec,
    });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  const render = () => act(() => root.render(React.createElement(ProToolsRulers, {
    snapshot: SNAPSHOT,
    rulersVisible: useProTools.getState().rulersVisible,
    contentWidth: 3_200,
    fieldRef: React.createRef<HTMLDivElement>(),
    getScrollLeft: () => 0,
  })));

  const marker = (name: string): HTMLElement => {
    const control = host.querySelector<HTMLElement>(`[role=slider][aria-label="${name}"]`);
    if (!control) throw new Error(`${name} is missing`);
    const field = control.closest<HTMLElement>(".pt-ruler-field");
    if (!field) throw new Error("Timeline ruler field is missing");
    field.getBoundingClientRect = () => new DOMRect(0, 0, 3_200, 90);
    return control;
  };

  const pointer = (element: HTMLElement, phase: PointerPhase, clientX: number, altKey = false) =>
    act(() => element.dispatchEvent(new PointerEvent(phase, {
      bubbles: true,
      cancelable: true,
      button: phase === "pointerdown" ? 0 : -1,
      buttons: phase === "pointermove" ? 1 : 0,
      clientX,
      pointerId: 7,
      altKey,
    })));

  it("drags the linked Timeline Start marker while keeping End fixed", () => {
    // Given a linked Timeline range and the default Smart Tool.
    act(() => useShell.setState({ timeRange: { start: 2, end: 6 }, timeRangeDragging: false }));
    render();
    const start = marker("Timeline selection start");

    // When the Start marker is dragged later with the Time Grabber surface.
    pointer(start, "pointerdown", 200);
    pointer(start, "pointermove", 350);
    expect(useShell.getState().timeRangeDragging).toBe(true);
    pointer(start, "pointerup", 350);

    // Then only Start moves and no project command is issued.
    expect(useShell.getState().timeRange).toEqual({ start: 3.5, end: 6 });
    expect(useShell.getState().timeRangeDragging).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("snaps a marker drag in Grid mode", () => {
    // Given a linked selection and a two-second bar Grid.
    act(() => {
      useShell.setState({ timeRange: { start: 2, end: 8 }, timeRangeDragging: false });
      useProTools.getState().setEditMode("grid");
      useStore.setState({ snap: true, snapDivision: "bar" });
    });
    render();
    const start = marker("Timeline selection start");

    // When Start is dragged to 5.1 seconds.
    pointer(start, "pointerdown", 200);
    pointer(start, "pointermove", 510);
    pointer(start, "pointerup", 510);

    // Then Grid constrains it to the nearest bar at six seconds.
    expect(useShell.getState().timeRange).toEqual({ start: 6, end: 8 });
  });

  it("bypasses Grid when Option is held during a marker drag", () => {
    // Given a linked selection and a two-second bar Grid.
    act(() => {
      useShell.setState({ timeRange: { start: 2, end: 8 }, timeRangeDragging: false });
      useProTools.getState().setEditMode("grid");
      useStore.setState({ snap: true, snapDivision: "bar" });
    });
    render();
    const start = marker("Timeline selection start");

    // When Start is dragged to 5.1 seconds while Option bypasses Grid.
    pointer(start, "pointerdown", 200, true);
    pointer(start, "pointermove", 510, true);
    pointer(start, "pointerup", 510, true);

    // Then the exact pointer time is retained.
    expect(useShell.getState().timeRange?.start).toBeCloseTo(5.1, 6);
    expect(useShell.getState().timeRange?.end).toBe(8);
  });

  it("restores an independent Timeline range when marker dragging is cancelled", () => {
    // Given unlinked Edit and Timeline ranges.
    act(() => {
      useShell.setState({ timeRange: { start: 1, end: 2 }, timeRangeDragging: false });
      useProTools.getState().setTimelineEditLinked(false, useShell.getState().timeRange);
      useProTools.getState().setTimelineSelection({ start: 2, end: 8 });
    });
    render();
    const end = marker("Timeline selection end");

    // When an End-marker drag is cancelled after a visible move.
    pointer(end, "pointerdown", 800);
    pointer(end, "pointermove", 520, true);
    pointer(end, "pointercancel", 520, true);

    // Then Timeline rolls back and Edit remains untouched.
    expect(useProTools.getState().timelineSelection).toEqual({ start: 2, end: 8 });
    expect(useProTools.getState().timelineSelectionDragging).toBe(false);
    expect(useShell.getState().timeRange).toEqual({ start: 1, end: 2 });
  });

  it("moves a focused marker by the visible Nudge value", () => {
    // Given a linked selection and a 250 ms Nudge value.
    act(() => useShell.setState({ timeRange: { start: 2, end: 6 }, timeRangeDragging: false }));
    render();
    const start = marker("Timeline selection start");

    // When the keyboard moves Start one step later.
    act(() => start.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    })));

    // Then the slider value and linked range move by exactly one Nudge unit.
    expect(useShell.getState().timeRange).toEqual({ start: 2.25, end: 6 });
    expect(start.getAttribute("aria-valuenow")).toBe("2.25");
  });

  it("clears an in-flight marker range when the project is replaced", () => {
    // Given a visible linked selection with Start actively moving.
    act(() => useShell.setState({ timeRange: { start: 2, end: 6 }, timeRangeDragging: false }));
    render();
    const start = marker("Timeline selection start");
    pointer(start, "pointerdown", 200);
    pointer(start, "pointermove", 350);

    // When the project epoch changes before pointer release.
    act(() => useStore.setState({ projectEpoch: 71 }));

    // Then stale selection state is cleared and release cannot restore it.
    expect(useShell.getState().timeRange).toBeNull();
    expect(useShell.getState().timeRangeDragging).toBe(false);
    pointer(start, "pointerup", 400);
    expect(useShell.getState().timeRange).toBeNull();
  });
});
