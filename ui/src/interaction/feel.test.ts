import { describe, it, expect } from "vitest";
import {
  FEEL_DEFAULTS,
  passedDragThreshold,
  isDoubleClick,
  magneticSnap,
  type Feel,
} from "./feel";

// The continuous "feel" values and the pure helpers the pointer handlers read live.

describe("FEEL_DEFAULTS", () => {
  it("is the Mosh-native baseline", () => {
    const f: Feel = FEEL_DEFAULTS;
    expect(f.dragThreshold).toBeGreaterThanOrEqual(0);
    expect(f.edgeGrabPx).toBe(7); // matches the historical 7px trim zone
    expect(f.doubleClickMs).toBeGreaterThan(0);
    expect(f.snapStrength).toBe(1);
    expect(f.zoomSensitivity).toBe(1);
    expect(f.scrollSensitivity).toBe(1);
  });
});

describe("passedDragThreshold", () => {
  it("is false within the threshold and true once exceeded (Euclidean)", () => {
    expect(passedDragThreshold(2, 0, 5)).toBe(false);
    expect(passedDragThreshold(5, 0, 5)).toBe(false); // exactly at the edge is not past
    expect(passedDragThreshold(6, 0, 5)).toBe(true);
    expect(passedDragThreshold(3, 4, 5)).toBe(false); // |(3,4)| = 5
    expect(passedDragThreshold(3, 4.1, 5)).toBe(true);
  });

  it("a zero threshold makes any movement a drag", () => {
    expect(passedDragThreshold(0.01, 0, 0)).toBe(true);
    expect(passedDragThreshold(0, 0, 0)).toBe(false);
  });
});

describe("isDoubleClick", () => {
  it("is true only within the window", () => {
    expect(isDoubleClick(1000, 1200, 300)).toBe(true);
    expect(isDoubleClick(1000, 1301, 300)).toBe(false);
    expect(isDoubleClick(null, 1200, 300)).toBe(false); // no prior click
  });
});

describe("magneticSnap", () => {
  const grid = 0.5; // half-second cells
  it("full strength always snaps to the grid value", () => {
    expect(magneticSnap(1.24, 1.25, grid, 1)).toBe(1.25);
    expect(magneticSnap(1.0, 1.25, grid, 1)).toBe(1.25); // even a far raw value
  });

  it("zero strength never snaps (returns the raw value)", () => {
    expect(magneticSnap(1.24, 1.25, grid, 0)).toBe(1.24);
  });

  it("partial strength snaps only inside the magnetic zone", () => {
    // zone = strength * grid * 0.5 = 0.5 * 0.5 * 0.5 = 0.125s
    expect(magneticSnap(1.20, 1.25, grid, 0.5)).toBe(1.25); // |Δ|=0.05 ≤ 0.125 → snap
    expect(magneticSnap(1.05, 1.25, grid, 0.5)).toBe(1.05); // |Δ|=0.20 > 0.125 → raw
  });
});
