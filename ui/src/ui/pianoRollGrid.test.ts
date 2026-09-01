import { describe, expect, it } from "vitest";
import { adaptiveDivision, editorGridProjection, effectiveStepBeats, gridLabel, GRID_DEFAULT, type EditorGrid } from "./pianoRollGrid";
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

describe("editorGridProjection", () => {
  it("renders every adaptive snap point at the default zoom", () => {
    const projection = editorGridProjection(M, GRID_DEFAULT, 42, 4);

    expect(projection.stepBeats).toBe(0.5);
    expect(projection.lines.map(({ beat, kind }) => [beat, kind])).toEqual([
      [0, "bar"],
      [0.5, "subdivision"],
      [1, "beat"],
      [1.5, "subdivision"],
      [2, "beat"],
      [2.5, "subdivision"],
      [3, "beat"],
      [3.5, "subdivision"],
      [4, "bar"],
    ]);
  });

  it("projects triplet snap points without losing the bar and beat hierarchy", () => {
    const projection = editorGridProjection(M, fixed("1/8", true), 42, 4);

    expect(projection.stepBeats).toBeCloseTo(1 / 3, 8);
    expect(projection.lines).toHaveLength(13);
    expect(projection.lines[0]).toEqual({ beat: 0, kind: "bar" });
    expect(projection.lines[1]).toMatchObject({ kind: "subdivision" });
    expect(projection.lines[3]).toEqual({ beat: 1, kind: "beat" });
    expect(projection.lines[12]).toEqual({ beat: 4, kind: "bar" });
  });
});
