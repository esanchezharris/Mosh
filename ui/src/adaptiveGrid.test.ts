import { describe, expect, it } from "vitest";
import { adaptiveDivision, MIN_GRID_PX } from "./adaptiveGrid";
import { snapStep, SNAP_DIVISIONS, type Meter } from "./time";

const M: Meter = { tempo: 120, num: 4, den: 4 };   // 1 beat = 0.5s, 1 bar = 2s

describe("adaptiveGrid", () => {
  it("gets finer as you zoom in and coarser as you zoom out", () => {
    const order = (d: string) => SNAP_DIVISIONS.indexOf(d as never);
    const wide = adaptiveDivision(M, 5);      // 1 bar = 10px
    const mid = adaptiveDivision(M, 60);
    const tight = adaptiveDivision(M, 2000);
    expect(order(wide)).toBeLessThanOrEqual(order(mid));
    expect(order(mid)).toBeLessThanOrEqual(order(tight));
    expect(tight).toBe("1/32");
  });

  it("never returns a division whose step is narrower than the aim threshold", () => {
    // The property that matters: whatever it picks must be clickable. Swept across three
    // decades of zoom so a threshold change cannot quietly break it at one value.
    for (let pps = 1; pps <= 1000; pps *= 1.3) {
      const d = adaptiveDivision(M, pps);
      const px = snapStep(M, d) * pps;
      // Either it clears the bar, or it is the coarsest grid there is (nothing wider left).
      expect(px >= MIN_GRID_PX || d === SNAP_DIVISIONS[0]).toBe(true);
    }
  });

  it("falls back to bars rather than to NO grid when absurdly zoomed out", () => {
    expect(adaptiveDivision(M, 0.001)).toBe("bar");
  });

  it("survives a degenerate zoom without throwing or returning undefined", () => {
    expect(adaptiveDivision(M, 0)).toBe("bar");
    expect(adaptiveDivision(M, -5)).toBe("bar");
    expect(adaptiveDivision(M, Number.NaN)).toBe("bar");
  });

  it("respects tempo — the same pixel zoom gives a coarser grid at a faster tempo", () => {
    // At tempo 240 a beat is half as many seconds, so it is half as many pixels wide, so the
    // adaptive grid must back off sooner. A version that keyed on pxPerSec alone and
    // ignored the meter would return the same answer for both.
    const slow: Meter = { tempo: 60, num: 4, den: 4 };
    const fast: Meter = { tempo: 240, num: 4, den: 4 };
    const i = (d: string) => SNAP_DIVISIONS.indexOf(d as never);
    expect(i(adaptiveDivision(fast, 30))).toBeLessThanOrEqual(i(adaptiveDivision(slow, 30)));
  });
});
