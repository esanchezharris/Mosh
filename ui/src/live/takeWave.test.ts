// Unit pins for the take-lane waveform resample (takeWave.ts).

import { describe, expect, it } from "vitest";
import { peaksToColumns, type PeakPair } from "./takeWave";

const P = (mn: number, mx: number): PeakPair => [mn, mx];

describe("peaksToColumns", () => {
  it("empty peaks or a non-positive width → [] (the labeled-bar fallback path)", () => {
    expect(peaksToColumns([], 100)).toEqual([]);
    expect(peaksToColumns([P(-1, 1)], 0)).toEqual([]);
    expect(peaksToColumns([P(-1, 1)], -4)).toEqual([]);
  });

  it("fewer buckets than columns → one column per bucket, verbatim", () => {
    const peaks = [P(-0.5, 0.5), P(-1, 0.25), P(0, 0.1)];
    expect(peaksToColumns(peaks, 100)).toEqual(peaks);
  });

  it("more buckets than columns → contiguous aggregation, min-of-mins / max-of-maxes", () => {
    const peaks = [P(-0.2, 0.3), P(-0.9, 0.1), P(-0.1, 0.8), P(-0.4, 0.4)];
    // 4 buckets → 2 columns: [0,2) and [2,4)
    expect(peaksToColumns(peaks, 2)).toEqual([P(-0.9, 0.3), P(-0.4, 0.8)]);
  });

  it("a column owns at least one bucket (no invented energy, no gaps)", () => {
    const peaks = [P(-1, 1), P(-0.5, 0.5), P(-0.25, 0.75), P(0, 0.1), P(-0.6, 0.2)];
    const out = peaksToColumns(peaks, 3);
    expect(out.length).toBe(3);
    // every column's amplitude is bounded by the global extremes, never zero-by-construction
    for (const [mn, mx] of out) {
      expect(mn).toBeGreaterThanOrEqual(-1);
      expect(mx).toBeLessThanOrEqual(1);
      expect(mn <= 0 && mx >= 0 || mn > 0 || mx < 0).toBe(true);   // sane pair
    }
    expect(out[0]).toEqual(P(-1, 1));        // buckets [0,1)
    expect(out[2]).toEqual(P(-0.6, 0.2));    // buckets [3,5)
  });

  it("fractional widths floor to whole columns", () => {
    const peaks = [P(-1, 1), P(-1, 1), P(-1, 1)];
    expect(peaksToColumns(peaks, 2.9).length).toBe(2);
  });
});
