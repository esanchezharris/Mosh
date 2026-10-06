import { describe, it, expect } from "vitest";
import {
  fmtDb, fmtFreq, fmtHz, fmtMs, fmtPct, fmtRatio, normOf, physOf, ratioNorm, ratioOf, stateNum, thresholdDb, thresholdNorm,
} from "./params";
import type { Plugin } from "../../types";

const EQ_FREQ = { min: 20, max: 20000 };

describe("physOf / normOf (linear, as every built-in maps them)", () => {
  it("uses the engine's min/max when present, else the fallback", () => {
    expect(physOf({ index: 0, name: "F", value: 0.5, min: 10, max: 22000 }, EQ_FREQ)).toBeCloseTo(11005, 6);
    expect(physOf({ index: 0, name: "F", value: 0.003003 }, EQ_FREQ)).toBeCloseTo(80, 1);   // EQ low-shelf default
    expect(normOf({ index: 0, name: "F", value: 0 }, 80, EQ_FREQ)).toBeCloseTo(0.003003, 6);
  });
  it("clamps out-of-range values both ways", () => {
    expect(physOf({ index: 0, name: "F", value: 7 }, EQ_FREQ)).toBe(20000);
    expect(normOf(undefined, 5, EQ_FREQ)).toBe(0);
    expect(normOf(undefined, 1e9, EQ_FREQ)).toBe(1);
  });
});

describe("compressor encodings (TrackPreset.h)", () => {
  it("threshold: -40 dB at 0, -6 dB near the middle, 0 dB at 1; round-trips", () => {
    expect(thresholdDb(0)).toBeCloseTo(-40, 6);
    expect(thresholdDb(1)).toBeCloseTo(0, 6);
    expect(thresholdDb(0.4961)).toBeCloseTo(-6.0, 1);
    for (const db of [-40, -24, -12, -3, 0]) expect(thresholdDb(thresholdNorm(db))).toBeCloseTo(db, 6);
  });
  it("ratio: the stored value is 1/N, so 0 is ∞:1 and higher values compress less", () => {
    expect(ratioOf(0)).toBe(Infinity);
    expect(ratioOf(0.5263)).toBeCloseTo(2, 2);
    expect(ratioOf(1)).toBeCloseTo(1.0526, 3);
    expect(ratioNorm(2.5)).toBeCloseTo(0.4211, 3);
    expect(ratioNorm(Infinity)).toBe(0);
    for (const n of [1.2, 2, 4, 8, 20]) expect(ratioOf(ratioNorm(n))).toBeCloseTo(n, 6);
  });
});

describe("formatters", () => {
  it("formats compactly and never prints -0", () => {
    expect(fmtHz(80)).toBe("80 Hz");
    expect(fmtHz(1234)).toBe("1.2k");
    expect(fmtHz(17000)).toBe("17k");
    expect(fmtFreq(80)).toBe("80 Hz");
    expect(fmtFreq(1234)).toBe("1.23 kHz");
    expect(fmtFreq(12345)).toBe("12.3 kHz");
    // the form follows the ROUNDED value
    expect(fmtHz(999.7)).toBe("1.0k");
    expect(fmtHz(9960)).toBe("10k");
    expect(fmtHz(9949)).toBe("9.9k");
    expect(fmtFreq(999.7)).toBe("1.00 kHz");
    expect(fmtFreq(9999)).toBe("10.0 kHz");
    expect(fmtDb(3)).toBe("+3.0 dB");
    expect(fmtDb(-0.04)).toBe("0.0 dB");
    expect(fmtDb(-2.46)).toBe("-2.5 dB");
    expect(fmtMs(4.5)).toBe("4.5 ms");
    expect(fmtMs(150.4)).toBe("150 ms");
    expect(fmtMs(1200)).toBe("1.20 s");
    expect(fmtPct(0.305)).toBe("31%");
    expect(fmtRatio(2.5)).toBe("2.5:1");
    expect(fmtRatio(Infinity)).toBe("∞:1");
    expect(fmtRatio(12.4)).toBe("12:1");
  });
});

describe("stateNum", () => {
  it("reads a numeric state value, with a fallback", () => {
    const p = { state: { lengthMs: { value: 375 }, mode: { value: "highpass" } } } as unknown as Plugin;
    expect(stateNum(p, "lengthMs", 150)).toBe(375);
    expect(stateNum(p, "mode", 7)).toBe(7);
    expect(stateNum(p, "missing", 150)).toBe(150);
  });
});
