import { describe, expect, it } from "vitest";
import { nextTabPosition } from "./tabNavigation";

describe("Pro Tools Tab navigation", () => {
  it("chooses the next transient when Tab to Transients is enabled", () => {
    expect(nextTabPosition({
      position: 2,
      tabToTransient: true,
      transientCandidates: [5, 1, 3],
      clipBoundaries: [4, 8],
    })).toBe(3);
  });

  it("falls back to the next clip boundary when transient data is unavailable", () => {
    expect(nextTabPosition({
      position: 2,
      tabToTransient: true,
      transientCandidates: [],
      clipBoundaries: [8, 4],
    })).toBe(4);
  });

  it("falls back when there is no later finite transient and skips the current boundary", () => {
    expect(nextTabPosition({
      position: 4,
      tabToTransient: true,
      transientCandidates: [Number.NaN, Number.POSITIVE_INFINITY, 2, 4],
      clipBoundaries: [4, Number.NEGATIVE_INFINITY, 7],
    })).toBe(7);
  });

  it("ignores transients when the option is disabled and returns null at the end", () => {
    expect(nextTabPosition({
      position: 2,
      tabToTransient: false,
      transientCandidates: [3],
      clipBoundaries: [4],
    })).toBe(4);
    expect(nextTabPosition({
      position: 9,
      tabToTransient: false,
      transientCandidates: [10],
      clipBoundaries: [4, 9],
    })).toBeNull();
  });

  it("returns null when the playhead is not finite", () => {
    expect(nextTabPosition({
      position: Number.NaN,
      tabToTransient: true,
      transientCandidates: [3],
      clipBoundaries: [4],
    })).toBeNull();
  });
});
