import { describe, it, expect } from "vitest";
import { curvePath, fillPath, freqScale, linScale } from "./plot";
import { arcPath, dialAngle } from "./Dial";

describe("freqScale", () => {
  it("puts each decade the same distance apart and round-trips", () => {
    const s = freqScale(20, 20000, 300);
    expect(s.to(20)).toBeCloseTo(0, 9);
    expect(s.to(20000)).toBeCloseTo(300, 9);
    expect(s.to(2000) - s.to(200)).toBeCloseTo(s.to(200) - s.to(20), 9);
    for (const hz of [31, 440, 9999]) expect(s.from(s.to(hz))).toBeCloseTo(hz, 6);
  });
});

describe("linScale", () => {
  it("maps the top value to y = 0", () => {
    const s = linScale(-12, 12, 80);
    expect(s.to(12)).toBe(0);
    expect(s.to(-12)).toBe(80);
    expect(s.to(0)).toBe(40);
    expect(s.from(20)).toBe(6);
  });
});

describe("curvePath / fillPath", () => {
  it("samples the function and clamps y to the plot", () => {
    const x = linScale(1, 0, 10), y = linScale(0, 10, 10);   // x: 0→10 px over v 0..1 (inverted helper)
    const d = curvePath((v) => v * 100, [0, 1], { to: (v) => v * 10, from: (p) => p / 10 }, y, 0, 10);
    expect(d).toBe("M0.00 10.00 L10.00 0.00");
    expect(fillPath(d, 0, 10, 5)).toBe("M0.00 10.00 L10.00 0.00 L10.00 5.00 L0.00 5.00 Z");
    expect(fillPath("", 0, 10, 5)).toBe("");
    void x;
  });
});

describe("dial geometry", () => {
  it("spans 270 degrees from -135 to +135", () => {
    expect(dialAngle(0)).toBe(-135);
    expect(dialAngle(0.5)).toBe(0);
    expect(dialAngle(1)).toBe(135);
    expect(dialAngle(2)).toBe(135);
  });
  it("draws nothing for an empty arc and a large-arc flag past 180 degrees", () => {
    expect(arcPath(20, 20, 16, 0, 0)).toBe("");
    expect(arcPath(20, 20, 16, -135, 135)).toContain(" 0 1 1 ");
    expect(arcPath(20, 20, 16, -135, 0)).toContain(" 0 0 1 ");
  });
});
