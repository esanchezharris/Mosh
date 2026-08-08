// Unit pins for the lane-height clamp (laneGeometry.ts; WIDGETS.md §1's measured range).

import { describe, it, expect } from "vitest";
import { clampLaneHeight, LANE_MIN, LANE_MAX, LANE_DEFAULT } from "./laneGeometry";

describe("clampLaneHeight", () => {
  it("holds the measured range: default 86, min 17, max 443", () => {
    expect(LANE_DEFAULT).toBe(86);
    expect(LANE_MIN).toBe(17);
    expect(LANE_MAX).toBe(443);
  });
  it("clamps and rounds", () => {
    expect(clampLaneHeight(86)).toBe(86);
    expect(clampLaneHeight(4)).toBe(17);
    expect(clampLaneHeight(9999)).toBe(443);
    expect(clampLaneHeight(100.6)).toBe(101);
  });
});
