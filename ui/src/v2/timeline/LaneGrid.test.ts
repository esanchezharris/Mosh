// The lane background under a variable tempo.
//
// A lane's stripes are a CSS repeating-linear-gradient at one `--beat-px` interval. That is
// exactly right while every beat is the same width, and structurally incapable of being
// right when they aren't — a repeating gradient has one period. So the moment a project
// holds a tempo change, the stripes drift from BarRuler above them, which reads the
// piecewise map. These pin the swap: gradient while flat, real lines once it isn't.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaneGrid, hasTempoChanges } from "./LaneGrid";
import { barSeconds, meterFrom } from "../../time";
import type { Snapshot } from "../../types";

const PX = 100;
const snap = (tempoMap?: { time: number; bpm: number; curve?: number }[]): Snapshot =>
  ({
    schemaVersion: 1,
    session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, length: 12, ...(tempoMap ? { tempoMap } : {}) },
    tracks: [], sections: [],
  }) as unknown as Snapshot;

describe("hasTempoChanges — the gate", () => {
  it("is false for a project with no map and for one with only a base point", () => {
    expect(hasTempoChanges(snap().session)).toBe(false);
    expect(hasTempoChanges(snap([{ time: 0, bpm: 120, curve: 1 }]).session)).toBe(false);
  });
  it("is true as soon as a real change exists", () => {
    expect(hasTempoChanges(snap([{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 90, curve: 1 }]).session)).toBe(true);
  });
});

describe("LaneGrid", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const barsAt = (s: Snapshot) => {
    act(() => root.render(React.createElement(LaneGrid, { snapshot: s, pxPerSec: PX })));
    return [...host.querySelectorAll(".v2-gl.bar")].map((e) => Number((e as HTMLElement).style.left.replace("px", "")) / PX);
  };

  it("spaces bars UNEVENLY across a tempo change — the thing a gradient cannot do", () => {
    // 120bpm 4/4 → 2s bars; from t=4 at 240bpm → 1s bars.
    const s = snap([{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 240, curve: 1 }]);
    const bars = barsAt(s);
    expect(bars.slice(0, 3)).toEqual([0, 2, 4]);        // before the change: 2s apart
    expect(bars.slice(3, 5)).toEqual([5, 6]);           // after: 1s apart

    // And prove that is genuinely different from what the flat path would draw, so this
    // test fails if someone "simplifies" LaneGrid back onto session.tempo.
    const flatBar = barSeconds(meterFrom(s.session));
    const flat = bars.map((_, i) => i * flatBar);
    expect(bars, "grid is evenly spaced — it ignored the tempo change").not.toEqual(flat);
  });

  it("agrees with a constant-tempo gradient when the tempo never changes", () => {
    // Not vacuous filler: it pins that the piecewise path degrades exactly onto the simple
    // one, which is why gating the swap on hasTempoChanges is safe for every project today.
    const s = snap();
    const bars = barsAt(s);
    const bar = barSeconds(meterFrom(s.session));
    expect(bars.slice(0, 4)).toEqual([0, bar, 2 * bar, 3 * bar]);
  });
});
