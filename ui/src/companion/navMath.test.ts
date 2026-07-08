import { describe, expect, it } from "vitest";
import {
  barTicks,
  barToSec,
  fracToSec,
  playheadFrac,
  regionRects,
  regionsForTrack,
  secPerBar,
  secToBar,
  songLength,
} from "./navMath";
import type { Snap } from "./types";

describe("bar/second math (4/4)", () => {
  it("secPerBar at 130 bpm ≈ 1.846s", () => {
    expect(secPerBar(130)).toBeCloseTo(1.84615, 4);
  });
  it("barToSec / secToBar are inverses (bar 5 at 130 ≈ 7.385s)", () => {
    expect(barToSec(5, 130)).toBeCloseTo(7.3846, 3);
    expect(secToBar(7.3846, 130)).toBeCloseTo(5, 3);
  });
  it("guards zero/negative tempo", () => {
    expect(secPerBar(0)).toBeGreaterThan(0);
  });
});

describe("songLength", () => {
  it("uses session.length when present", () => {
    expect(songLength({ session: { length: 42 } })).toBe(42);
  });
  it("falls back to the last clip end", () => {
    const s: Snap = { tracks: [{ id: "t", clips: [{ id: "c", start: 10, length: 5 }] }] };
    expect(songLength(s)).toBe(15);
  });
  it("floors at 1", () => {
    expect(songLength({})).toBe(1);
  });
});

describe("regions", () => {
  const s: Snap = {
    tracks: [
      { id: "vox", clips: [{ id: "a", start: 2, length: 3 }, { id: "hid", start: 8, length: 2, hidden: true }] },
      { id: "beat", clips: [{ id: "b", start: 0, length: 20 }] },
    ],
  };
  it("returns non-hidden clips on the chosen track", () => {
    expect(regionsForTrack(s, "vox")).toEqual([{ s: 2, e: 5 }]);
  });
  it("spans all tracks when no trackId given", () => {
    expect(regionsForTrack(s)).toEqual([{ s: 2, e: 5 }, { s: 0, e: 20 }]);
  });
  it("regionRects → fractions with a visible-minimum width", () => {
    const rects = regionRects([{ s: 5, e: 10 }], 20);
    expect(rects[0].left).toBeCloseTo(0.25, 5);
    expect(rects[0].width).toBeCloseTo(0.25, 5);
    expect(regionRects([{ s: 0, e: 0.001 }], 100)[0].width).toBeGreaterThanOrEqual(0.004);
  });
});

describe("playhead / seek", () => {
  it("playheadFrac clamps to 0..1", () => {
    expect(playheadFrac(5, 10)).toBeCloseTo(0.5, 5);
    expect(playheadFrac(99, 10)).toBe(1);
    expect(playheadFrac(-1, 10)).toBe(0);
  });
  it("fracToSec inverts a fraction back to seconds", () => {
    expect(fracToSec(0.5, 40)).toBe(20);
    expect(fracToSec(1.5, 40)).toBe(40); // clamped
  });
});

describe("barTicks", () => {
  it("thins tick density for long songs", () => {
    const short = barTicks(secPerBar(120) * 8, 120); // ~8 bars → step 1 → 7 interior ticks
    expect(short.length).toBe(7);
    const long = barTicks(secPerBar(120) * 100, 120); // 100 bars → step 8
    expect(long.every((f) => f > 0 && f < 1)).toBe(true);
    expect(long.length).toBeLessThan(short.length + 20);
  });
});
