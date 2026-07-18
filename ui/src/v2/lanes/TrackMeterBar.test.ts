// METER-001: the v2 track-header meter widget. TrackMeterBar just wraps the classic
// shell's <Meter> (ui/src/ui/Meter.tsx) in a sizing span — the ballistics/geometry are
// already covered by ui/src/ui/Meter.test.ts + meterGeom.test.ts, so this file focuses
// on what's new here: it reads the RIGHT track's slot out of state.levels.tracks (not
// another track's, not master), renders inertly with no data, and still lights the
// shared clip glow at >=0 dBFS. Same stub-rAF + createRoot/act pattern as Meter.test.ts.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackMeterBar } from "./TrackLaneList";
import { useStore } from "../../store";

describe("v2 TrackMeterBar", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let rafs: FrameRequestCallback[];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rafs = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { rafs.push(cb); return rafs.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) { act(() => root!.unmount()); root = null; }
    host.remove();
    vi.unstubAllGlobals();
  });

  function render(trackId: string) {
    act(() => { root!.render(React.createElement(TrackMeterBar, { trackId })); });
  }
  function tick() {
    act(() => { const cb = rafs.shift(); if (cb) cb(1000); });
  }

  it("renders the compact wrapper around the shared meter, no data yet", () => {
    useStore.setState({ levels: { tracks: {}, master: { l: -100, r: -100 } } });
    render("t1");
    tick();

    const wrap = host.querySelector('[data-testid="v2-track-meter"]');
    expect(wrap).not.toBeNull();
    expect(wrap!.classList.contains("v2-meter")).toBe(true);
    const meter = wrap!.querySelector(".meter");
    expect(meter).not.toBeNull();
    expect(meter!.classList.contains("meter-clip")).toBe(false);
    // No reading for this track -> the mask stays fully closed (an empty bar).
    const mask = meter!.querySelector(".mmask") as HTMLElement | null;
    expect(mask?.style.width).toBe("100%");   // jsdom normalizes "100.0%" -> "100%"
  });

  it("reads its OWN trackId's slot, not another track's and not master", () => {
    useStore.setState({
      levels: {
        tracks: { t1: { l: -100, r: -100 }, t2: { l: 0, r: 0 } },
        master: { l: 0, r: 0 },
      },
    });
    render("t1");
    tick();

    // t1 is silent even though t2 and master are clipping — proves trackId routing.
    const meter = host.querySelector('[data-testid="v2-track-meter"] .meter');
    expect(meter!.classList.contains("meter-clip")).toBe(false);
  });

  it("lights the shared clip glow when its own track peaks at/above 0 dBFS", () => {
    useStore.setState({ levels: { tracks: { t1: { l: 1.5, r: -20 } }, master: { l: -100, r: -100 } } });
    render("t1");
    tick();

    const meter = host.querySelector('[data-testid="v2-track-meter"] .meter');
    expect(meter!.classList.contains("meter-clip")).toBe(true);
  });
});
