import { describe, it, expect } from "vitest";
import {
  meterFrom,
  secPerQuarter,
  beatSeconds,
  barSeconds,
  snapStep,
  snapStepBeats,
  adaptiveGridDivision,
  activeGridDivision,
  secondsToBBS,
  tempoMapFrom,
  segAt,
  meterAt,
  snapTimeMap,
  secondsToBBSMap,
  gridLines,
  SNAP_DIVISIONS,
  type Meter,
} from "./time";

// The canonical musical-time mapping (SES-001). These are the pure derivations every
// view resolves through — ruler, grid, snap, playhead. Lock the arithmetic down so a
// refactor can't silently shift the grid.

const m44: Meter = { tempo: 120, num: 4, den: 4 }; // 0.5s/beat, 2.0s/bar
const m68: Meter = { tempo: 120, num: 6, den: 8 }; // 0.25s/beat, 1.5s/bar

describe("meterFrom", () => {
  it("defaults to 120 bpm 4/4 when unset", () => {
    expect(meterFrom()).toEqual({ tempo: 120, num: 4, den: 4 });
    expect(meterFrom({})).toEqual({ tempo: 120, num: 4, den: 4 });
  });
  it("honors session values", () => {
    expect(meterFrom({ tempo: 90, timeSigNumerator: 3, timeSigDenominator: 4 })).toEqual({
      tempo: 90,
      num: 3,
      den: 4,
    });
  });
  it("guards non-positive tempo", () => {
    expect(meterFrom({ tempo: 0 }).tempo).toBe(120);
    expect(meterFrom({ tempo: -5 }).tempo).toBe(120);
  });
});

describe("seconds-per-unit", () => {
  it("quarter / beat / bar at 120 bpm 4/4", () => {
    expect(secPerQuarter(120)).toBe(0.5);
    expect(beatSeconds(m44)).toBe(0.5);
    expect(barSeconds(m44)).toBe(2.0);
  });
  it("respects the denominator (6/8 beat is an eighth)", () => {
    expect(beatSeconds(m68)).toBe(0.25);
    expect(barSeconds(m68)).toBe(1.5);
  });
  it("clamps tempo floor to avoid div-by-zero", () => {
    expect(secPerQuarter(0)).toBe(60); // Math.max(1, tempo)
  });
});

describe("snapStep / snapStepBeats", () => {
  it("bar step equals one bar", () => {
    expect(snapStep(m44, "bar")).toBe(2.0);
    expect(snapStepBeats(m44, "bar")).toBe(4);
  });
  it("subdivisions in seconds at 120 bpm", () => {
    expect(snapStep(m44, "1/4")).toBeCloseTo(0.5, 9);
    expect(snapStep(m44, "1/8")).toBeCloseTo(0.25, 9);
    expect(snapStep(m44, "1/8T")).toBeCloseTo(1 / 6, 9);
    expect(snapStep(m44, "1/16")).toBeCloseTo(0.125, 9);
    expect(snapStep(m44, "1/16T")).toBeCloseTo(1 / 12, 9);
    expect(snapStep(m44, "1/32")).toBeCloseTo(0.0625, 9);
  });
  it("every division yields a positive step in both meters", () => {
    for (const d of SNAP_DIVISIONS) {
      expect(snapStep(m44, d)).toBeGreaterThan(0);
      expect(snapStep(m68, d)).toBeGreaterThan(0);
    }
  });
});

describe("secondsToBBS (constant tempo)", () => {
  it("bar/beat/sixteenth are 1-based", () => {
    expect(secondsToBBS(0, m44)).toBe("1.1.1");
    expect(secondsToBBS(0.5, m44)).toBe("1.2.1"); // one beat in
    expect(secondsToBBS(2.0, m44)).toBe("2.1.1"); // one bar in
    expect(secondsToBBS(0.25, m44)).toBe("1.1.3"); // half a beat -> 3rd sixteenth
  });
  it("never returns a negative position", () => {
    expect(secondsToBBS(-10, m44)).toBe("1.1.1");
  });
});

describe("tempoMapFrom", () => {
  it("constant session collapses to a single segment", () => {
    const map = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ startSec: 0, tempo: 120, num: 4, den: 4 });
    expect(map[0].startBarF).toBeCloseTo(0, 9); // may be -0 from Math.ceil; mathematically 0
    expect(map[0].barSec).toBe(2.0);
  });
  it("a step tempo change yields a segment per change with a fresh bar", () => {
    const map = tempoMapFrom({
      tempo: 120,
      tempoMap: [
        { time: 0, bpm: 120 },
        { time: 4, bpm: 60 },
      ],
    });
    expect(map.length).toBeGreaterThanOrEqual(2);
    const second = segAt(map, 4);
    expect(second.tempo).toBe(60);
    expect(second.startSec).toBe(4);
    // 4s at 2.0s/bar = exactly bar 2 boundary; explicit change starts a whole bar.
    expect(Number.isInteger(second.startBarF)).toBe(true);
  });
  it("always returns at least one segment", () => {
    expect(tempoMapFrom(undefined).length).toBeGreaterThanOrEqual(1);
  });
});

describe("segAt / meterAt", () => {
  it("returns the governing segment (last starting at or before the time)", () => {
    const map = tempoMapFrom({
      tempo: 120,
      tempoMap: [
        { time: 0, bpm: 120 },
        { time: 4, bpm: 60 },
      ],
    });
    expect(meterAt(map, 1).tempo).toBe(120);
    expect(meterAt(map, 5).tempo).toBe(60);
  });
});

describe("snapTimeMap (constant tempo)", () => {
  const map = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });
  it("snaps to the nearest quarter (0.5s grid)", () => {
    expect(snapTimeMap(map, 0.3, "1/4")).toBeCloseTo(0.5, 9); // closer to 0.5 than 0
    expect(snapTimeMap(map, 0.2, "1/4")).toBeCloseTo(0.0, 9); // closer to 0
    expect(snapTimeMap(map, 0.74, "1/4")).toBeCloseTo(0.5, 9);
    expect(snapTimeMap(map, 0.76, "1/4")).toBeCloseTo(1.0, 9);
  });
  it("snaps to the bar grid (2.0s)", () => {
    expect(snapTimeMap(map, 1.1, "bar")).toBeCloseTo(2.0, 9);
    expect(snapTimeMap(map, 0.9, "bar")).toBeCloseTo(0.0, 9);
  });
  it("handles triplet divisions", () => {
    expect(snapTimeMap(map, 0.13, "1/8T")).toBeCloseTo(1 / 6, 9);
    expect(snapTimeMap(map, 0.20, "1/16T")).toBeCloseTo(1 / 6, 9);
  });
  it("never returns a negative time", () => {
    expect(snapTimeMap(map, -3, "1/4")).toBeGreaterThanOrEqual(0);
  });
});

describe("secondsToBBSMap matches the constant-tempo formula", () => {
  const map = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });
  it("agrees with secondsToBBS on a constant session", () => {
    for (const t of [0, 0.25, 0.5, 1.0, 2.0, 3.7]) {
      expect(secondsToBBSMap(map, t)).toBe(secondsToBBS(t, m44));
    }
  });
});

describe("gridLines", () => {
  const map = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });
  it("emits bar lines on bar boundaries within range", () => {
    const { bars, beats } = gridLines(map, 0, 4); // bar lines at 0s, 2s, 4s (range inclusive)
    expect(bars.map((b) => b.sec)).toEqual([0, 2, 4]);
    expect(bars.map((b) => b.label)).toEqual([1, 2, 3]); // 1-based
    // 3 interior beats in each of bars 1 and 2 (bar 3's first beat is past 4s).
    expect(beats.length).toBe(6);
  });
  it("respects the maxLines cap", () => {
    const { bars, beats, marks } = gridLines(map, 0, 100000, 50);
    expect(bars.length + beats.length).toBeLessThanOrEqual(50);
    expect(Array.isArray(marks)).toBe(true);
  });
});

describe("adaptive grid selection", () => {
  it("chooses the finest readable division", () => {
    expect(adaptiveGridDivision(m44, 400)).toBe("1/32");
    expect(adaptiveGridDivision(m44, 80)).toBe("1/8T");
    expect(adaptiveGridDivision(m44, 30)).toBe("1/4");
  });
  it("resolves fixed versus adaptive modes", () => {
    expect(activeGridDivision(m44, 80, "fixed", "1/16")).toBe("1/16");
    expect(activeGridDivision(m44, 80, "adaptive", "1/16")).toBe("1/8T");
  });
});
