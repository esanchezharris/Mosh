// UIREACH-TIMERANGE — BarRuler's shift-drag time-range gesture.
//
// The guard that matters most here mirrors TempoRibbon.test.ts's own: positions must
// come from the PIECEWISE tempo map (time.ts), never geom.ts's flat session.tempo-only
// helpers. geom.ts is only correct while the tempo never changes — exactly the
// assumption a tempo-map project breaks. Building the range edges on the flat helpers
// would look identical on a constant-tempo project (every project until someone adds a
// change) and only misplace itself once one exists.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarRuler, snappedSecAt } from "./BarRuler";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import { tempoMapFrom, snapTimeMap, meterFrom, barSeconds } from "../../time";
import type { Snapshot } from "../../types";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});

const PX = 100; // px per second — keeps clientX <-> seconds arithmetic readable

const snap = (tempoMap?: { time: number; bpm: number; curve?: number }[]): Snapshot =>
  ({
    schemaVersion: 1,
    session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, length: 32, ...(tempoMap ? { tempoMap } : {}) },
    tracks: [], sections: [],
  }) as unknown as Snapshot;

describe("BarRuler helpers — snappedSecAt", () => {
  it("snaps using the PIECEWISE map, not the tempo at bar 1", () => {
    // 120bpm 4/4 -> 2s bars. After the change at t=4 the tempo doubles -> 1s bars. A raw
    // position of 5.4s snaps to 5.0 piecewise, but to 6.0 under the flat (geom.ts) assumption.
    const map = [{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 240, curve: 1 }];
    const s = snap(map);
    const tm = tempoMapFrom(s.session);
    const piecewise = snapTimeMap(tm, 5.4, "bar");
    const flatBar = barSeconds(meterFrom(s.session));
    const flat = Math.round(5.4 / flatBar) * flatBar;
    // Guard against a fixture where the two happen to agree — that would make the rest
    // of this test vacuous.
    expect(piecewise, "fixture does not discriminate piecewise from flat").not.toBeCloseTo(flat, 6);

    const got = snappedSecAt(tm, PX, 5.4 * PX, 0);
    expect(got).toBeCloseTo(piecewise, 6);
    expect(got, "regressed onto the flat (session.tempo-only) grid").not.toBeCloseTo(flat, 6);
  });

  it("folds in the ruler's own rect.left offset", () => {
    const tm = tempoMapFrom(snap().session);
    expect(snappedSecAt(tm, PX, 400 + 4 * PX, 400)).toBeCloseTo(4, 6);
  });
});

describe("BarRuler — shift-drag time-range gesture", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  let frames: Array<{ id: number; cb: FrameRequestCallback }>;
  let nextFrameId: number;

  const render = (s: Snapshot) => act(() => root.render(React.createElement(BarRuler, { snapshot: s, width: 3200 })));
  const ruler = () => host.querySelector('[data-testid="v2-ruler"]') as HTMLElement;

  // clientX in PX-per-second units; rect.left is 0 under jsdom's default zero DOMRect.
  const down = (sec: number, shiftKey: boolean) => act(() => {
    ruler().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: sec * PX, shiftKey, buttons: 1 }));
  });
  const move = (sec: number) => act(() => {
    ruler().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: sec * PX, buttons: 1 }));
  });
  const up = (sec: number) => act(() => {
    ruler().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: sec * PX }));
  });
  const cancel = (sec: number) => act(() => {
    ruler().dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, clientX: sec * PX }));
  });
  const flushFrame = () => act(() => {
    const pending = frames.splice(0);
    for (const frame of pending) frame.cb(16);
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.push({ id, cb });
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      frames = frames.filter((frame) => frame.id !== id);
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    useStore.setState({ exec, pxPerSec: PX, snapshot: snap() } as never);
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    render(snap());
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("a plain press (no Shift) seeks immediately and draws no range", () => {
    down(4, false);
    up(4);
    expect(exec).toHaveBeenCalledWith("set_transport", { position: 4 });
    expect(useShell.getState().timeRange).toBeNull();
  });

  it("a plain drag seeks at most once per frame and commits the pointer-up position", () => {
    const capture = vi.fn();
    const release = vi.fn();
    Object.defineProperties(ruler(), {
      setPointerCapture: { configurable: true, value: capture },
      releasePointerCapture: { configurable: true, value: release },
    });

    down(2, false);
    move(4);
    move(6);
    expect(exec).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenLastCalledWith("set_transport", { position: 6 });

    up(7);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenLastCalledWith("set_transport", { position: 7 });
    expect(capture).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledWith(1);
  });

  it("pointer cancellation discards a queued plain scrub and ends the gesture", () => {
    down(2, false);
    move(6);
    cancel(6);
    flushFrame();
    move(8);
    flushFrame();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenLastCalledWith("set_transport", { position: 2 });
  });

  it("shift-drag draws a bar-snapped span, live, and clears the drag flag on release", () => {
    down(4, true);
    expect(useShell.getState().timeRangeDragging).toBe(true);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 4 }); // anchor drawn immediately
    move(6);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 6 });
    up(6);
    expect(useShell.getState().timeRangeDragging).toBe(false);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 6 }); // survives release
    expect(exec, "a shift-drag must never also fire a seek").not.toHaveBeenCalled();
  });

  it("dragging backwards (end before start chronologically) still yields start <= end", () => {
    down(6, true);
    move(4);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 6 });
  });

  it("a shift-press with no real movement leaves no selection behind", () => {
    down(4, true);
    up(4);
    expect(useShell.getState().timeRange).toBeNull();
  });

  it("snaps drag edges through a real tempo change, not the flat grid", () => {
    // Same fixture as the piecewise-vs-flat helper test above, driven through the full
    // gesture this time: post-change bars are 1s, so a drag ending near 5.4s must land
    // on 5, never on 6 (the flat 2s-bar answer).
    const mapped = snap([{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 240, curve: 1 }]);
    render(mapped);
    down(0.1, true);   // anchor near the start; snaps to bar 0
    move(5.4);
    const r = useShell.getState().timeRange!;
    expect(r.start).toBeCloseTo(0, 6);
    expect(r.end).toBeCloseTo(5, 6);
    up(5.4);
  });
});
