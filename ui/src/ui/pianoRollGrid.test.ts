import { describe, expect, it } from "vitest";
import { adaptiveDivision, effectiveStepBeats, gridLabel, GRID_DEFAULT, type EditorGrid } from "./pianoRollGrid";
import type { Meter } from "../time";

const M: Meter = { tempo: 120, num: 4, den: 4 };
const fixed = (division: EditorGrid["division"], triplet = false): EditorGrid =>
  ({ division, triplet, adaptive: false });

describe("effectiveStepBeats", () => {
  it("converts a fixed division to beats", () => {
    expect(effectiveStepBeats(M, fixed("1/4"), 42)).toBeCloseTo(1, 6);
    expect(effectiveStepBeats(M, fixed("1/8"), 42)).toBeCloseTo(0.5, 6);
    expect(effectiveStepBeats(M, fixed("1/16"), 42)).toBeCloseTo(0.25, 6);
  });

  it("a triplet fits three in the space of two", () => {
    expect(effectiveStepBeats(M, fixed("1/8", true), 42)).toBeCloseTo(1 / 3, 6);
  });
});

describe("adaptiveDivision", () => {
  it("gets FINER as you zoom in and COARSER as you zoom out", () => {
    const order = ["bar", "1/4", "1/8", "1/16", "1/32"];
    const at = (beatPx: number) => order.indexOf(adaptiveDivision(M, beatPx));
    const zooms = [4, 12, 42, 120, 400, 2000];
    // Monotonic across the whole sweep — it saturates at both ends (there is nothing
    // finer than 1/32 or coarser than a bar), so only non-decreasing is guaranteed…
    for (let i = 1; i < zooms.length; i++) expect(at(zooms[i])).toBeGreaterThanOrEqual(at(zooms[i - 1]));
    // …but it must genuinely MOVE somewhere in between, or "adaptive" is a lie.
    expect(at(2000)).toBeGreaterThan(at(4));
  });

  it("never picks a division whose lines would be too close to aim at", () => {
    const MIN = 14;
    for (const beatPx of [4, 12, 42, 120, 400, 2000]) {
      const px = effectiveStepBeats(M, { division: adaptiveDivision(M, beatPx), triplet: false, adaptive: false }, beatPx) * beatPx;
      // The coarsest option (a bar) is the floor — below that there is nothing left to pick.
      if (adaptiveDivision(M, beatPx) !== "bar") expect(px).toBeGreaterThanOrEqual(MIN);
    }
  });

  it("never returns finer than the finest division on offer", () => {
    expect(effectiveStepBeats(M, { ...GRID_DEFAULT, adaptive: true }, 100000))
      .toBeGreaterThanOrEqual(effectiveStepBeats(M, fixed("1/32"), 1));
  });
});

describe("gridLabel", () => {
  it("names the fixed division, marking triplets", () => {
    expect(gridLabel(M, fixed("1/16"), 42)).toBe("1/16");
    expect(gridLabel(M, fixed("1/16", true), 42)).toBe("1/16T");
  });

  it("says which division adaptive actually resolved to, not just 'auto'", () => {
    // A label that only said "auto" would leave the producer unable to tell what snapping
    // is about to do.
    const label = gridLabel(M, { ...GRID_DEFAULT, adaptive: true }, 42);
    expect(label).toMatch(/\(auto\)$/);
    expect(label).toMatch(/^(bar|1\/\d+)/);
  });
});
