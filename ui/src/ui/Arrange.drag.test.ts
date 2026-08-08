// Classic-shell clip-drag TIME-AXIS guard — the Arrange half of the fix PR #430
// shipped across three files (PianoRoll, ClipView, Arrange). The first two got
// dedicated tests; this one did not. Arrange.test.ts next door only exercises
// double-click open-routing and never touches onClipMove, so until this file the
// classic shell's half of that fix carried no regression signal — a refactor of
// Arrange's drag logic could reintroduce the bug while ClipView's mirror-image
// test stayed green.
//
// Same bug, same shape as the v2 shell's: `onClipMove` re-snapped `start` on
// EVERY pointermove once the gesture engaged, using only `dx`. A clip drag has
// just ONE meaningful axis (a clip cannot be dragged between lanes — the commit
// never sends trackId), so a drag that engaged (>3px euclidean, trivially reached
// with vertical travel alone) but never really moved in TIME silently straightened
// a deliberately off-grid clip onto the grid: a pushed hit, a hand-placed sample.
//
// ClipBlock is module-private, so this mounts the real `Arrange` and drives the
// clip it renders. That is the truer test anyway — it exercises the actual
// `snapWithFeel` (magnetic-snap-aware) wrapper Arrange hands the block, not a
// stand-in for it. Needs snap ON and a clip that actually sits off the grid.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Arrange } from "./Arrange";
import { useStore } from "../store";
import { liveFeel } from "../interaction/config";
import type { Clip, CommandResult, Snapshot, Track } from "../types";
import { useSettings } from "../settings/store";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const PX_PER_SEC = 80;
// 120bpm 4/4 with a 1/4 snap ⇒ a 0.5s grid, so 1.15s is off-grid and snaps to 1.0.
const OFF_GRID_START = 1.15;
const GRID_SEC = 0.5;

// A plain block clip: no wave peaks and no MIDI preview to render, so the drag is
// the only thing under test.
const CLIP: Clip = {
  id: "c1", name: "take", type: "clip", start: OFF_GRID_START, length: 4, offset: 0, hasRenderLayer: false,
};

const TRACK: Track = { id: "t1", index: 0, name: "Audio", type: "audio", clips: [CLIP] };

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/arrange-drag.tracktionedit",
  },
  tracks: [TRACK],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("Arrange clip drag — time-axis guard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  // The store's snapTime reads the snapshot from the STORE (not the prop), so both
  // have to be set or snap:true would resolve against a missing tempo map.
  const mount = () => {
    useStore.setState({
      snapshot: SNAPSHOT, snap: true, snapDivision: "1/4", pxPerSec: PX_PER_SEC, tool: "move",
      selection: new Set<string>(), timeRange: null, expandedTracks: new Set<string>(),
      levels: { tracks: {}, master: { l: -100, r: -100 } }, exec,
    });
    act(() => root.render(React.createElement(Arrange, { snapshot: SNAPSHOT })));
  };

  /**
   * jsdom reports a zero-size rect, which `classifyClipRegion` reads as "all edge"
   * (⇒ TRIM, not MOVE), so the clip is given a real box before the press.
   */
  const clipEl = (): HTMLElement => {
    const el = host.querySelector('[data-clip-id="c1"]') as HTMLElement | null;
    if (!el) throw new Error("clip did not render");
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 60, width: 400, height: 60, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return el;
  };

  const X0 = 200, Y0 = 30; // mid-body: past both edge-grab zones and below the header band

  // Separate act() blocks on purpose: ClipBlock keeps its drag preview in REACT
  // STATE, so `onClipUp` reads the closure from the last render. Batching the move
  // and the up together would leave that closure holding a null preview and nothing
  // would ever commit — a green test proving nothing.
  const at = (el: HTMLElement, type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    act(() => {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 4, clientX: x, clientY: y, ...extra }));
    });

  /** Drag the clip body by (dxPx, dyPx); returns the move_clip args, if any. */
  const dragClip = (dxPx: number, dyPx: number) => {
    const el = clipEl();
    at(el, "pointerdown", X0, Y0, { button: 0 });
    at(el, "pointermove", X0 + dxPx, Y0 + dyPx, { buttons: 1 });
    at(el, "pointerup", X0 + dxPx, Y0 + dyPx);
    const call = exec.mock.calls.find((c) => c[0] === "move_clip");
    return call ? (call[1] as { start: number }) : undefined;
  };

  beforeEach(() => {
    // These tests pin MOSH-bundle behavior; the live shell's default bundle
    // (ableton under uiShell "live") would otherwise change every gesture/feel result.
    useSettings.setState({ values: { gestureTable: "mosh", keymap: "mosh" } });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      scale: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), globalAlpha: 1, fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
  });

  afterEach(() => {
    useSettings.setState({ values: {} });
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null, snap: false, selection: new Set<string>(), editingClipId: null });
    vi.restoreAllMocks();
  });

  it("a drag with no horizontal travel leaves an off-grid clip where it is", () => {
    mount();
    // Well past the engage threshold vertically, but the time axis never moved —
    // and vertical travel means nothing to a clip, which cannot change lane.
    expect(dragClip(0, 40)).toBeUndefined();
  });

  it("a sub-threshold horizontal wobble does not straighten it either", () => {
    mount();
    // Exactly AT the threshold: the guard is `<=`, so this is still frozen.
    expect(dragClip(liveFeel().dragThreshold, 40)).toBeUndefined();
  });

  it("still snaps once the drag really travels in time", () => {
    mount();
    // One grid cell to the right: 1.15 + 0.5 = 1.65, which the 0.5s grid rounds to 1.5.
    expect(dragClip(GRID_SEC * PX_PER_SEC, 0)?.start).toBeCloseTo(1.5, 6);
  });

  it("dragging a clip out and back to where it started commits nothing", () => {
    mount();
    // Skipping the preview inside the deadzone is not enough — the far-out one has
    // to be cleared, or releasing at the origin commits the trip that was abandoned.
    const el = clipEl();
    at(el, "pointerdown", X0, Y0, { button: 0 });
    at(el, "pointermove", X0 + 3 * GRID_SEC * PX_PER_SEC, Y0, { buttons: 1 });
    at(el, "pointermove", X0, Y0, { buttons: 1 });
    at(el, "pointerup", X0, Y0);
    expect(exec.mock.calls.some((c) => c[0] === "move_clip")).toBe(false);
  });
});
