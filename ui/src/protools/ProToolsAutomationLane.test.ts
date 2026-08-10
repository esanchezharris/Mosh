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
    useProTools.getState().resetForProject();
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
    expect(lane?.getAttribute("aria-keyshortcuts")).toBe("Enter Space Escape Meta+C Meta+X Meta+V");
    expect(lane?.getAttribute("aria-label")).toBe(
      "Audio automation, Level. Drag the lower area to select, drag the upper area to trim, Control-drag to draw a line, Control-Command-drag to draw freehand, or press Enter or Space to add a breakpoint at the playhead. Plus or Minus nudges selected points.",
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

    expect(point.getAttribute("aria-keyshortcuts")).toBe(
      "Delete Backspace Escape Meta+C Meta+X Meta+V",
    );
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

  it("copies selected automation without touching the clip clipboard", () => {
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 23, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 23, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 23, clientX: 350, clientY: 20 });

    act(() => surface.dispatchEvent(new KeyboardEvent("keydown", {
      key: "c", metaKey: true, bubbles: true, cancelable: true,
    })));

    expect(useProTools.getState().automationClipboard).toEqual({
      duration: 3,
      sourceParamName: "Level",
      points: [{ t: 0.5, v: 0.2 }, { t: 2.5, v: 0.7 }],
    });
    expect(useStore.getState().clipboard).toBeNull();
    expect(execCalls).toEqual([]);
  });

  it("keeps automation clipboard shortcuts when a breakpoint owns focus", () => {
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 31, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 31, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 31, clientX: 350, clientY: 20 });
    const point = host.querySelector<HTMLElement>('[data-testid="pt-automation-point-0"]');
    if (!point) throw new Error("first automation point is missing");
    point.focus();

    act(() => point.dispatchEvent(new KeyboardEvent("keydown", {
      key: "c", metaKey: true, bubbles: true, cancelable: true,
    })));

    expect(point.dataset.moshEditOwner).toBe("protools-automation");
    expect(useProTools.getState().automationClipboard?.points).toEqual([
      { t: 0.5, v: 0.2 }, { t: 2.5, v: 0.7 },
    ]);
    expect(execCalls).toEqual([]);
  });

  it("cuts selected automation in descending index order inside one undo batch", async () => {
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 24, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 24, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 24, clientX: 350, clientY: 20 });

    act(() => surface.dispatchEvent(new KeyboardEvent("keydown", {
      key: "x", metaKey: true, bubbles: true, cancelable: true,
    })));

    await vi.waitFor(() => expect(execCalls).toEqual([
      { command: "batch_begin", args: { name: "cut automation" } },
      { command: "remove_automation_point", args: {
        trackId: "track-1", pluginIndex: 3, paramIndex: 2, pointIndex: 1,
      } },
      { command: "remove_automation_point", args: {
        trackId: "track-1", pluginIndex: 3, paramIndex: 2, pointIndex: 0,
      } },
      { command: "batch_end", args: {} },
    ]));
  });

  it("pastes automation relative to the edit insertion through one curve command", async () => {
    act(() => useProTools.getState().setAutomationClipboard({
      duration: 3,
      sourceParamName: "Level",
      points: [{ t: 0.5, v: 0.2 }, { t: 2.5, v: 0.7 }],
    }));
    const surface = lane();

    act(() => surface.dispatchEvent(new KeyboardEvent("keydown", {
      key: "v", metaKey: true, bubbles: true, cancelable: true,
    })));

    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "write_automation_curve",
      args: {
        trackId: "track-1",
        pluginIndex: 3,
        paramIndex: 2,
        apply: "replace",
        replaceStart: 3,
        replaceEnd: 6,
        points: [{ t: 3.5, v: 0.2 }, { t: 5.5, v: 0.7 }],
      },
    }]));
  });

  it("previews and commits a Control-drag line Pencil only on release", async () => {
    const surface = lane();

    pointer(surface, "pointerdown", {
      pointerId: 25, button: 0, clientX: 100, clientY: 19, ctrlKey: true,
    });
    pointer(surface, "pointermove", {
      pointerId: 25, buttons: 1, clientX: 300, clientY: 9, ctrlKey: true,
    });
    expect(execCalls).toEqual([]);
    expect(host.querySelectorAll(".pt-automation-point")).toHaveLength(3);
    pointer(surface, "pointerup", {
      pointerId: 25, clientX: 300, clientY: 9, ctrlKey: true,
    });

    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "write_automation_curve",
      args: {
        trackId: "track-1", pluginIndex: 3, paramIndex: 2, apply: "replace",
        replaceStart: 1, replaceEnd: 3,
        points: [{ t: 1, v: 0.2 }, { t: 3, v: 0.7 }],
      },
    }]));
  });

  it("commits a Control-Command freehand Pencil as one ordered curve segment", async () => {
    const surface = lane();

    pointer(surface, "pointerdown", {
      pointerId: 26, button: 0, clientX: 100, clientY: 19, ctrlKey: true, metaKey: true,
    });
    pointer(surface, "pointermove", {
      pointerId: 26, buttons: 1, clientX: 200, clientY: 13, ctrlKey: true, metaKey: true,
    });
    pointer(surface, "pointermove", {
      pointerId: 26, buttons: 1, clientX: 300, clientY: 9, ctrlKey: true, metaKey: true,
    });
    expect(execCalls).toEqual([]);
    pointer(surface, "pointerup", {
      pointerId: 26, clientX: 300, clientY: 9, ctrlKey: true, metaKey: true,
    });

    await vi.waitFor(() => expect(execCalls).toEqual([{
      command: "write_automation_curve",
      args: {
        trackId: "track-1", pluginIndex: 3, paramIndex: 2, apply: "replace",
        replaceStart: 1, replaceEnd: 3,
        points: [{ t: 1, v: 0.2 }, { t: 2, v: 0.5 }, { t: 3, v: 0.7 }],
      },
    }]));
  });

  it("does not turn the Mac Control Pencil clutch into a context menu", async () => {
    const surface = lane();
    pointer(surface, "pointerdown", {
      pointerId: 32, button: 0, clientX: 100, clientY: 19, ctrlKey: true, metaKey: true,
    });
    act(() => surface.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 100, clientY: 19,
      ctrlKey: true, metaKey: true,
    })));
    expect(document.body.querySelector('[data-testid="pt-automation-menu"]')).toBeNull();
    pointer(surface, "pointermove", {
      pointerId: 32, buttons: 1, clientX: 200, clientY: 13, ctrlKey: true, metaKey: true,
    });
    pointer(surface, "pointerup", {
      pointerId: 32, clientX: 300, clientY: 9, ctrlKey: true, metaKey: true,
    });

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "write_automation_curve",
      args: {
        trackId: "track-1", pluginIndex: 3, paramIndex: 2, apply: "replace",
        replaceStart: 1, replaceEnd: 2,
        points: [{ t: 1, v: 0.2 }, { t: 2, v: 0.5 }],
      },
    }));
  });

  it("cancels a Pencil preview when the browser cancels its pointer", () => {
    const surface = lane();
    pointer(surface, "pointerdown", {
      pointerId: 28, button: 0, clientX: 100, clientY: 19, ctrlKey: true,
    });
    pointer(surface, "pointermove", {
      pointerId: 28, buttons: 1, clientX: 300, clientY: 5, ctrlKey: true,
    });
    expect(host.querySelector('[data-testid="pt-automation-point-1"]')?.getAttribute("aria-label"))
      .toContain("90 percent");

    pointer(surface, "pointercancel", {
      pointerId: 28, clientX: 300, clientY: 5, ctrlKey: true,
    });
    pointer(surface, "pointerup", {
      pointerId: 28, clientX: 300, clientY: 5, ctrlKey: true,
    });

    expect(host.querySelector('[data-testid="pt-automation-point-1"]')?.getAttribute("aria-label"))
      .toContain("70 percent");
    expect(execCalls).toEqual([]);
  });

  it("does not commit a Pencil gesture into a replacement project", () => {
    const surface = lane();
    pointer(surface, "pointerdown", {
      pointerId: 29, button: 0, clientX: 100, clientY: 19, ctrlKey: true,
    });
    pointer(surface, "pointermove", {
      pointerId: 29, buttons: 1, clientX: 300, clientY: 5, ctrlKey: true,
    });

    act(() => useStore.setState({ projectEpoch: 51 }));
    pointer(surface, "pointerup", {
      pointerId: 29, clientX: 300, clientY: 5, ctrlKey: true,
    });

    expect(execCalls).toEqual([]);
  });

  it("rolls back a Pencil preview when its curve command fails", async () => {
    act(() => useStore.setState({
      exec: vi.fn(async (command: string): Promise<CommandResult> => ({
        ok: false, command, error: "pencil curve rejected",
      })),
    }));
    const surface = lane();
    pointer(surface, "pointerdown", {
      pointerId: 30, button: 0, clientX: 100, clientY: 19, ctrlKey: true,
    });
    pointer(surface, "pointermove", {
      pointerId: 30, buttons: 1, clientX: 300, clientY: 5, ctrlKey: true,
    });
    expect(host.querySelector('[data-testid="pt-automation-point-1"]')?.getAttribute("aria-label"))
      .toContain("90 percent");
    pointer(surface, "pointerup", {
      pointerId: 30, clientX: 300, clientY: 5, ctrlKey: true,
    });

    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="pt-automation-point-1"]')?.getAttribute("aria-label"))
      .toContain("70 percent");
  });

  it("offers Cut, Copy, and Paste from an accessible right-click menu", async () => {
    const surface = lane();
    pointer(surface, "pointerdown", { pointerId: 27, button: 0, clientX: 50, clientY: 20 });
    pointer(surface, "pointermove", { pointerId: 27, buttons: 1, clientX: 350, clientY: 20 });
    pointer(surface, "pointerup", { pointerId: 27, clientX: 350, clientY: 20 });

    act(() => surface.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 200, clientY: 20,
    })));
    const menu = document.body.querySelector<HTMLElement>('[data-testid="pt-automation-menu"]');
    const copy = document.body.querySelector<HTMLButtonElement>('[data-testid="pt-automation-copy"]');
    const paste = document.body.querySelector<HTMLButtonElement>('[data-testid="pt-automation-paste"]');
    expect(menu?.getAttribute("role")).toBe("menu");
    expect(menu?.getAttribute("aria-label")).toBe("Level automation edit actions");
    expect(copy?.disabled).toBe(false);
    expect(paste?.disabled).toBe(true);

    act(() => copy?.click());
    expect(document.body.querySelector('[data-testid="pt-automation-menu"]')).toBeNull();
    expect(useProTools.getState().automationClipboard?.sourceParamName).toBe("Level");
    expect(document.activeElement).toBe(surface);

    act(() => surface.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 200, clientY: 20,
    })));
    const enabledPaste = document.body.querySelector<HTMLButtonElement>('[data-testid="pt-automation-paste"]');
    expect(enabledPaste?.disabled).toBe(false);
    act(() => enabledPaste?.click());

    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "write_automation_curve",
      args: {
        trackId: "track-1", pluginIndex: 3, paramIndex: 2, apply: "replace",
        replaceStart: 3, replaceEnd: 6,
        points: [{ t: 3.5, v: 0.2 }, { t: 5.5, v: 0.7 }],
      },
    }));
  });

  it("closes the automation context menu with Escape and restores lane focus", () => {
    const surface = lane();
    surface.focus();
    act(() => surface.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 200, clientY: 20,
    })));
    expect(document.body.querySelector('[data-testid="pt-automation-menu"]')).not.toBeNull();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));

    expect(document.body.querySelector('[data-testid="pt-automation-menu"]')).toBeNull();
    expect(document.activeElement).toBe(surface);
  });
});
