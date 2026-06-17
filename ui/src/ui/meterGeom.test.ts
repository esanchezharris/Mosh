import { describe, it, expect } from "vitest";
import { meterPct, isClip, METER_FLOOR_DB } from "./meterGeom";

// Pure mapping that <Meter> paints with — see takeLanes.test.ts for the same
// "test the pure derivation, not the rendered component" convention.

describe("meterPct", () => {
  it("maps the display floor to 0% and full-scale to 100%", () => {
    expect(meterPct(METER_FLOOR_DB)).toBe(0);
    expect(meterPct(0)).toBe(100);
  });

  it("is linear in dB across the visible range", () => {
    expect(meterPct(METER_FLOOR_DB / 2)).toBeCloseTo(50, 5); // -30 dBFS → 50%
  });

  it("clamps below the floor and above full-scale", () => {
    expect(meterPct(-100)).toBe(0); // engine silence floor is below the visible floor
    expect(meterPct(6)).toBe(100);
  });

  it("treats non-finite readings as silence", () => {
    expect(meterPct(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(meterPct(Number.NaN)).toBe(0);
  });
});

describe("isClip", () => {
  it("flags readings at or above 0 dBFS", () => {
    expect(isClip(0)).toBe(true);
    expect(isClip(1.5)).toBe(true);
  });

  it("does not flag sub-full-scale readings or silence", () => {
    expect(isClip(-0.1)).toBe(false);
    expect(isClip(-100)).toBe(false);
    expect(isClip(Number.NaN)).toBe(false);
  });
});
