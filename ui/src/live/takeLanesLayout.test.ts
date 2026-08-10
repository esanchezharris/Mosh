// Unit pins for the pure take-lane layout (takeLanesLayout.ts) — row count and
// per-row bar placement. The render consumes this verbatim.

import { describe, expect, it } from "vitest";
import { takeLanesLayout } from "./takeLanesLayout";

describe("takeLanesLayout", () => {
  it("no takes (or single-take clips) → zero rows, zero visual change", () => {
    expect(takeLanesLayout([])).toEqual({ rows: 0, bars: [] });
    expect(takeLanesLayout([
      { id: "a", start: 0, length: 4 },
      { id: "b", start: 4, length: 4, numTakes: 1 },
    ])).toEqual({ rows: 0, bars: [] });
  });

  it("one clip with N takes → N rows, one bar per row at the clip's extent", () => {
    const { rows, bars } = takeLanesLayout([{ id: "a", start: 2, length: 6, numTakes: 3 }]);
    expect(rows).toBe(3);
    expect(bars.map((row) => row.length)).toEqual([1, 1, 1]);
    bars.forEach((row, i) => {
      expect(row[0]).toEqual({ clipId: "a", takeIndex: i, leftSec: 2, widthSec: 6 });
    });
  });

  it("two clips share rows by take INDEX; the shorter comp leaves gaps", () => {
    const { rows, bars } = takeLanesLayout([
      { id: "a", start: 0, length: 4, numTakes: 2 },
      { id: "b", start: 4, length: 8, numTakes: 3 },
    ]);
    expect(rows).toBe(3);   // max numTakes
    expect(bars[0].map((b) => b.clipId)).toEqual(["a", "b"]);
    expect(bars[1].map((b) => b.clipId)).toEqual(["a", "b"]);
    expect(bars[2].map((b) => b.clipId)).toEqual(["b"]);   // clip a has no take 3
    expect(bars[2][0]).toEqual({ clipId: "b", takeIndex: 2, leftSec: 4, widthSec: 8 });
  });

  it("clips without takes interleaved with comp clips are skipped, order kept", () => {
    const { rows, bars } = takeLanesLayout([
      { id: "x", start: 0, length: 2 },
      { id: "a", start: 2, length: 2, numTakes: 2 },
      { id: "y", start: 4, length: 2, numTakes: 1 },
      { id: "b", start: 6, length: 2, numTakes: 2 },
    ]);
    expect(rows).toBe(2);
    expect(bars[0].map((b) => b.clipId)).toEqual(["a", "b"]);
    expect(bars[1].map((b) => b.takeIndex)).toEqual([1, 1]);
  });
});
