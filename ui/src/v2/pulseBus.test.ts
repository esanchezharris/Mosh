import { describe, it, expect, beforeEach } from "vitest";
import { markPulse, pulseLevel, clearPulses, __PULSE_MS } from "./pulseBus";

describe("pulseBus", () => {
  beforeEach(() => clearPulses());

  it("an unmarked track has no pulse", () => {
    expect(pulseLevel("t1", 1000)).toBe(0);
  });

  it("marking a track flashes ~1 immediately, then decays to 0 over PULSE_MS", () => {
    markPulse("t1", 1000);
    expect(pulseLevel("t1", 1000)).toBeCloseTo(1, 5);
    const mid = pulseLevel("t1", 1000 + __PULSE_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(pulseLevel("t1", 1000 + __PULSE_MS)).toBe(0); // expired
    expect(pulseLevel("t1", 1000 + __PULSE_MS * 2)).toBe(0);
  });

  it("decay is monotonic (ease-out)", () => {
    markPulse("t1", 0);
    const a = pulseLevel("t1", 100);
    const b = pulseLevel("t1", 200);
    const c = pulseLevel("t1", 300);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("a later mark re-arms the flash", () => {
    markPulse("t1", 0);
    expect(pulseLevel("t1", __PULSE_MS)).toBe(0); // expired
    markPulse("t1", __PULSE_MS); // re-mark
    expect(pulseLevel("t1", __PULSE_MS)).toBeCloseTo(1, 5);
  });

  it("tracks are independent", () => {
    markPulse("a", 0);
    expect(pulseLevel("a", 0)).toBeCloseTo(1, 5);
    expect(pulseLevel("b", 0)).toBe(0);
  });

  it("a negative dt (clock skew) reads as 0, never NaN/negative", () => {
    markPulse("t1", 1000);
    expect(pulseLevel("t1", 900)).toBe(0);
  });

  it("ignores an empty track id", () => {
    markPulse("", 0);
    expect(pulseLevel("", 0)).toBe(0);
  });
});
