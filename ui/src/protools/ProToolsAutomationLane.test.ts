import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Track } from "../types";
import { ProToolsAutomationLane } from "./ProToolsAutomationLane";
import { useProTools } from "./proToolsState";

const TRACK: Track = {
  id: "track-1",
  index: 0,
  name: "Audio",
  type: "audio",
  clips: [],
  plugins: [{
    index: 3,
    name: "Gain",
    type: "builtin",
    enabled: true,
    external: false,
    isInstrument: false,
    params: [{
      index: 2,
      name: "Level",
      value: 0.5,
      points: [{ t: 1, v: 0.2 }, { t: 3, v: 0.7 }, { t: 5, v: 0.4 }],
    }],
  }],
};

describe("ProToolsAutomationLane", () => {
  let host: HTMLDivElement;
  let root: Root;
  let execCalls: { readonly command: string; readonly args?: Record<string, unknown> }[];
  const originalExec = useStore.getState().exec;

  const lane = () => {
    const element = host.querySelector<HTMLButtonElement>("[data-testid=protools-automation-lane]");
    if (!element) throw new Error("automation lane is missing");
    element.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 28 });
    return element;
  };

  const pointer = (element: HTMLElement, type: string, init: PointerEventInit) => {
    act(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })));
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    execCalls = [];
    useStore.setState({
      pxPerSec: 100,
      transport: { ...useStore.getState().transport, position: 3 },
      projectEpoch: 50,
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
    useProTools.getState().setNudgeValue(0.25);
    act(() => root.render(React.createElement(ProToolsAutomationLane, { track: TRACK, width: 800 })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ exec: originalExec });
    vi.restoreAllMocks();
  });

  it("adds a breakpoint at the playhead through store.exec when Enter is pressed", async () => {
    const surface = lane();
    surface.focus();

    act(() => surface.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    })));

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "add_automation_point",
      args: { trackId: "track-1", pluginIndex: 3, paramIndex: 2, time: 3, value: 0.5 },
    }));
  });

  it("exposes a keyboard-operable breakpoint control", () => {
    const lane = host.querySelector<HTMLElement>("[data-testid=protools-automation-lane]");

    expect(lane?.tagName).toBe("BUTTON");
    expect(lane?.getAttribute("type")).toBe("button");
    expect(lane?.getAttribute("aria-keyshortcuts")).toBe("Enter Space Escape");
    expect(lane?.getAttribute("aria-label")).toBe(
      "Audio automation, Level. Drag the lower area to select, drag the upper area to trim, or press Enter or Space to add a breakpoint at the playhead. Plus or Minus nudges selected points.",
    );
  });

  it("removes an automation lane without a target from keyboard focus", () => {
    act(() => root.render(React.createElement(ProToolsAutomationLane, {
      track: { ...TRACK, plugins: [] }, width: 800,
    })));
    const lane = host.querySelector<HTMLButtonElement>("[data-testid=protools-automation-lane]");

    expect(lane?.disabled).toBe(true);
    expect(lane?.getAttribute("aria-label")).toBe("Audio automation, no target");
  });

  it("shows a persistent range after a lower-band Selector drag", () => {
    // Given: Smart Tool is active over a lane with points at 1, 3, and 5 seconds.
    const surface = lane();

    // When: the producer drags from 0.5 to 3.5 seconds in the lower Selector band.
    pointer(surface, "pointerdown", { pointerId: 10, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 10, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 10, clientX: 350, clientY: 20 });

    // Then: the selection remains visible and identifies only its two enclosed nodes.
    const selection = host.querySelector<HTMLElement>("[data-testid=pt-automation-selection]");
    expect(selection?.style.left).toBe("50px");
    expect(selection?.style.width).toBe("300px");
    expect(host.querySelector('[data-testid="pt-automation-point-0"]')?.getAttribute("data-selected")).toBe("true");
    expect(host.querySelector('[data-testid="pt-automation-point-1"]')?.getAttribute("data-selected")).toBe("true");
    expect(host.querySelector('[data-testid="pt-automation-point-2"]')?.getAttribute("data-selected")).toBe("false");
    expect(execCalls).toEqual([]);
  });

  it("trims the selected range as one undoable curve command", async () => {
    // Given: a lower-band drag selects the first two automation points.
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 11, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 11, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 11, clientX: 350, clientY: 20 });

    // When: the producer drags two pixels upward in the top Trim band.
    pointer(surface, "pointerdown", { pointerId: 12, button: 0, clientX: 200, clientY: 4 });
    pointer(surface, "pointermove", { pointerId: 12, buttons: 1, clientX: 200, clientY: 2 });
    expect(execCalls).toEqual([]);
    pointer(surface, "pointerup", { pointerId: 12, clientX: 200, clientY: 2 });

    // Then: one batch command raises the selected values and preserves the third point.
    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "write_automation_curve",
      args: {
        trackId: "track-1",
        pluginIndex: 3,
        paramIndex: 2,
        apply: "replace",
        replaceStart: 1,
        replaceEnd: 5,
        points: [{ t: 1, v: 0.3 }, { t: 3, v: 0.8 }, { t: 5, v: 0.4 }],
      },
    }]));
  });

  it("moves one breakpoint after pointer release through set_automation_point", async () => {
    // Given: the first rendered automation node is available as a focusable control.
    lane();
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-0"]');
    if (!point) throw new Error("first automation point is missing");

    // When: the producer drags it right by 0.5 seconds and up by 0.1.
    pointer(point, "pointerdown", { pointerId: 13, button: 0, clientX: 100, clientY: 19 });
    pointer(point, "pointermove", { pointerId: 13, buttons: 1, clientX: 150, clientY: 17 });
    expect(execCalls).toEqual([]);
    pointer(point, "pointerup", { pointerId: 13, clientX: 150, clientY: 17 });

    // Then: the point mutation commits once with its original engine index.
    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "set_automation_point",
      args: { trackId: "track-1", pluginIndex: 3, paramIndex: 2, pointIndex: 0, time: 1.5, value: 0.3 },
    }]));
  });

  it("removes one breakpoint when Option or Alt is held", async () => {
    // Given: the middle automation node is rendered with its original engine index.
    lane();
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-1"]');
    if (!point) throw new Error("middle automation point is missing");

    // When: the producer Option-clicks the node.
    pointer(point, "pointerdown", { pointerId: 14, button: 0, clientX: 300, clientY: 9, altKey: true });
    pointer(point, "pointerup", { pointerId: 14, clientX: 300, clientY: 9, altKey: true });

    // Then: the matching point index is removed through the command seam.
    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "remove_automation_point",
      args: { trackId: "track-1", pluginIndex: 3, paramIndex: 2, pointIndex: 1 },
    }]));
  });

  it("nudges every selected breakpoint by the current Nudge value", async () => {
    // Given: the first two nodes are selected and the lane keeps keyboard focus.
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 15, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 15, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 15, clientX: 350, clientY: 20 });

    // When: Plus is pressed with a 250 ms Nudge value.
    act(() => surface.dispatchEvent(new KeyboardEvent("keydown", {
      key: "+", code: "NumpadAdd", bubbles: true, cancelable: true,
    })));

    // Then: one undoable curve write shifts only the selected nodes in time.
    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "write_automation_curve",
      args: {
        trackId: "track-1",
        pluginIndex: 3,
        paramIndex: 2,
        apply: "replace",
        replaceStart: 1,
        replaceEnd: 5,
        points: [{ t: 1.25, v: 0.2 }, { t: 3.25, v: 0.7 }, { t: 5, v: 0.4 }],
      },
    }]));
    expect(surface.getAttribute("aria-label")).toContain("Plus or Minus nudges selected points");
  });

  it("removes a focused breakpoint with Delete", async () => {
    lane();
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-1"]');
    if (!point) throw new Error("middle automation point is missing");

    act(() => point.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Delete", bubbles: true, cancelable: true,
    })));

    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "remove_automation_point",
      args: { trackId: "track-1", pluginIndex: 3, paramIndex: 2, pointIndex: 1 },
    }]));
  });

  it("rolls back a Trim preview when pointer cancellation interrupts the gesture", () => {
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 16, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 16, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 16, clientX: 350, clientY: 20 });
    pointer(surface, "pointerdown", { pointerId: 17, button: 0, clientX: 200, clientY: 4 });
    pointer(surface, "pointermove", { pointerId: 17, buttons: 1, clientX: 200, clientY: 2 });

    expect(host.querySelector(".pt-automation-trim-readout")).not.toBeNull();
    pointer(surface, "pointercancel", { pointerId: 17, clientX: 200, clientY: 2 });
    pointer(surface, "pointerup", { pointerId: 17, clientX: 200, clientY: 2 });

    expect(host.querySelector(".pt-automation-trim-readout")).toBeNull();
    expect(execCalls).toEqual([]);
  });

  it("does not move a breakpoint after project replacement invalidates its drag", () => {
    lane();
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-0"]');
    if (!point) throw new Error("first automation point is missing");
    pointer(point, "pointerdown", { pointerId: 18, button: 0, clientX: 100, clientY: 19 });
    pointer(point, "pointermove", { pointerId: 18, buttons: 1, clientX: 150, clientY: 17 });

    act(() => useStore.setState({ projectEpoch: 51 }));
    pointer(point, "pointerup", { pointerId: 18, clientX: 150, clientY: 17 });

    expect(execCalls).toEqual([]);
  });

  it("cancels a focused breakpoint drag when Escape is pressed", () => {
    lane();
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-0"]');
    if (!point) throw new Error("first automation point is missing");
    pointer(point, "pointerdown", { pointerId: 19, button: 0, clientX: 100, clientY: 19 });
    pointer(point, "pointermove", { pointerId: 19, buttons: 1, clientX: 150, clientY: 17 });

    act(() => point.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));
    pointer(point, "pointerup", { pointerId: 19, clientX: 150, clientY: 17 });

    expect(point.getAttribute("aria-keyshortcuts")).toBe("Delete Backspace Escape");
    expect(execCalls).toEqual([]);
  });

  it("rolls back a breakpoint preview when its command fails", async () => {
    act(() => useStore.setState({
      exec: vi.fn(async (command: string): Promise<CommandResult> => ({
        ok: false,
        command,
        error: "automation point rejected",
      })),
    }));
    lane();
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-0"]');
    if (!point) throw new Error("first automation point is missing");

    pointer(point, "pointerdown", { pointerId: 20, button: 0, clientX: 100, clientY: 19 });
    pointer(point, "pointermove", { pointerId: 20, buttons: 1, clientX: 150, clientY: 17 });
    expect(point.style.left).toBe("150px");
    pointer(point, "pointerup", { pointerId: 20, clientX: 150, clientY: 17 });

    await act(async () => { await Promise.resolve(); });
    expect(point.style.left).toBe("100px");
  });

  it("rolls back a Trim preview when its curve command fails", async () => {
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 21, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 21, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 21, clientX: 350, clientY: 20 });
    act(() => useStore.setState({
      exec: vi.fn(async (command: string): Promise<CommandResult> => ({
        ok: false,
        command,
        error: "automation curve rejected",
      })),
    }));

    pointer(surface, "pointerdown", { pointerId: 22, button: 0, clientX: 200, clientY: 4 });
    pointer(surface, "pointermove", { pointerId: 22, buttons: 1, clientX: 200, clientY: 2 });
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-0"]');
    expect(point?.getAttribute("aria-label")).toContain("30 percent");
    pointer(surface, "pointerup", { pointerId: 22, clientX: 200, clientY: 2 });

    await act(async () => { await Promise.resolve(); });
    expect(point?.getAttribute("aria-label")).toContain("20 percent");
  });
});
