// Timeline clip-drag TIME-AXIS guard — the arrangement's half of the piano roll's
// invariant-88 rule: an axis you did not move is never rewritten.
//
// A clip drag has only ONE meaningful axis (a clip cannot be dragged between lanes —
// the drag never sends `trackId`), so unlike the piano roll there is no second axis
// to conflate with. The bug it shares is narrower but real: `onMove` re-snapped
// `start` on EVERY pointermove once the gesture engaged, using only `dx`. So a drag
// that engaged (>3px total) but ended up back within a few px of where it started —
// dragging a clip and putting it back, or wobbling downward against a lane boundary
// that does not exist — silently straightened a deliberately off-grid clip.
//
// Needs snap ON and a clip that actually sits off the grid.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipView } from "./ClipView";
import { useStore } from "../../store";
import { FEEL_DEFAULTS } from "../../interaction/feel";
import type { Clip, CommandResult, Snapshot } from "../../types";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const PX_PER_SEC = 80;
// 120bpm 4/4 with a 1/4 snap ⇒ a 0.5s grid, so 1.15s is off-grid and snaps to 1.0.
const OFF_GRID_START = 1.15;
const GRID_SEC = 0.5;

const CLIP: Clip = {
  id: "c1", name: "take", type: "block", start: OFF_GRID_START, length: 4, offset: 0, hasRenderLayer: false,
} as unknown as Clip;

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/clipdrag.tracktionedit",
  },
  tracks: [], transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("v2 timeline clip drag — time-axis guard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = () => {
    useStore.setState({ snapshot: SNAPSHOT, snap: true, snapDivision: "1/4", pxPerSec: PX_PER_SEC, tool: "move", exec });
    act(() => root.render(React.createElement(ClipView, { clip: CLIP, trackType: "audio", snapshot: SNAPSHOT })));
  };

  /**
   * Drag the clip body by (dxPx, dyPx). jsdom reports a zero-size rect, which
   * `classifyClipRegion` would read as "all edge" (⇒ trim, not move), so the clip
   * is given a real width first and the press starts well inside the body.
   */
  const dragClip = (dxPx: number, dyPx: number) => {
    const el = host.querySelector('[data-testid="v2-clip"]') as HTMLElement | null;
    if (!el) throw new Error("v2 clip did not render");
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 60, width: 400, height: 60, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const x0 = 200, y0 = 30; // mid-body: past both edge-grab zones
    // Separate act() blocks on purpose: ClipView keeps its drag preview in REACT
    // STATE (the piano roll uses a ref), so `onUp` reads the closure from the last
    // render. Batching the move and the up together would leave that closure holding
    // a null preview and nothing would ever commit — a green test proving nothing.
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 4, button: 0, clientX: x0, clientY: y0 }));
    });
    act(() => {
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 4, clientX: x0 + dxPx, clientY: y0 + dyPx, buttons: 1 }));
    });
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 4, clientX: x0 + dxPx, clientY: y0 + dyPx }));
    });
    const call = exec.mock.calls.find((c) => c[0] === "move_clip");
    return call ? (call[1] as { start: number }) : undefined;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null, snap: false, selection: new Set<string>() });
    vi.restoreAllMocks();
  });

  it("a drag with no horizontal travel leaves an off-grid clip where it is", () => {
    mount();
    // Well past the engage threshold vertically, but the time axis never moved.
    expect(dragClip(0, 40)).toBeUndefined();
  });

  it("a sub-threshold horizontal wobble does not straighten it either", () => {
    mount();
    expect(dragClip(FEEL_DEFAULTS.dragThreshold, 40)).toBeUndefined();
  });

  it("still snaps once the drag really travels in time", () => {
    mount();
    // One grid cell to the right: 1.15 + 0.5 = 1.65, which the 0.5s grid rounds to 1.5.
    expect(dragClip(GRID_SEC * PX_PER_SEC, 0)?.start).toBeCloseTo(1.5, 6);
  });

  // EDGECASE_SWEEP_V2_2026-07-18 L3 — interrupted drags. A pointercancel (system
  // gesture, alt-tab, palm rejection) or an Escape mid-drag must abandon the gesture:
  // clear the optimistic preview, commit nothing, and leave later gestures clean.
  const startEngagedDrag = (pointerId: number, dxPx: number) => {
    const el = host.querySelector('[data-testid="v2-clip"]') as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 60, width: 400, height: 60, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const x0 = 200, y0 = 30;
    act(() => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId, button: 0, clientX: x0, clientY: y0 })); });
    act(() => { el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, clientX: x0 + dxPx, clientY: y0, buttons: 1 })); });
    return { el, x0, y0 };
  };
  const clipLeft = () =>
    (host.querySelector('[data-testid="v2-clip"]') as HTMLElement).style.left;

  it("pointercancel mid-drag clears the preview and commits nothing", () => {
    mount();
    const origLeft = clipLeft();
    const { el, x0, y0 } = startEngagedDrag(7, GRID_SEC * PX_PER_SEC);
    expect(clipLeft()).not.toBe(origLeft); // preview engaged
    act(() => { el.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 7, clientX: x0 + GRID_SEC * PX_PER_SEC, clientY: y0 })); });
    expect(clipLeft()).toBe(origLeft); // optimistic position abandoned
    // a stray up after the cancel must not resurrect the commit
    act(() => { el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientX: x0 + GRID_SEC * PX_PER_SEC, clientY: y0 })); });
    expect(exec.mock.calls.some((c) => c[0] === "move_clip")).toBe(false);
  });

  it("Escape mid-drag cancels the gesture (preview cleared, nothing committed)", () => {
    mount();
    const origLeft = clipLeft();
    const { el, x0, y0 } = startEngagedDrag(8, GRID_SEC * PX_PER_SEC);
    expect(clipLeft()).not.toBe(origLeft);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(clipLeft()).toBe(origLeft);
    act(() => { el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 8, clientX: x0 + GRID_SEC * PX_PER_SEC, clientY: y0 })); });
    expect(exec.mock.calls.some((c) => c[0] === "move_clip")).toBe(false);
  });

  it("Escape mid-drag is consumed by the drag — an open overlay beneath stays open", async () => {
    const { pushEscapeHandler } = await import("../../hooks/escapeStack");
    mount();
    const overlayClose = vi.fn();
    const dispose = pushEscapeHandler(overlayClose);
    try {
      const { el, x0, y0 } = startEngagedDrag(9, GRID_SEC * PX_PER_SEC);
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(overlayClose).not.toHaveBeenCalled(); // the drag took the key
      act(() => { el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9, clientX: x0, clientY: y0 })); });
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(overlayClose).toHaveBeenCalledTimes(1); // after the drag, the stack works again
    } finally {
      dispose();
    }
  });

  it("dragging a clip out and back to where it started commits nothing", () => {
    mount();
    // Skipping the preview inside the deadzone is not enough — the far-out one has
    // to be cleared, or releasing at the origin commits the trip that was abandoned.
    const el = host.querySelector('[data-testid="v2-clip"]') as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 60, width: 400, height: 60, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const x0 = 200, y0 = 30;
    const at = (type: string, x: number, extra: Record<string, unknown> = {}) =>
      act(() => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 6, clientX: x, clientY: y0, ...extra })); });
    at("pointerdown", x0, { button: 0 });
    at("pointermove", x0 + 3 * GRID_SEC * PX_PER_SEC, { buttons: 1 });
    at("pointermove", x0, { buttons: 1 });
    at("pointerup", x0);
    expect(exec.mock.calls.some((c) => c[0] === "move_clip")).toBe(false);
  });
});
