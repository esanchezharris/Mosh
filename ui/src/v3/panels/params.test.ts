import { describe, it, expect } from "vitest";
import {
  fmtDb, fmtFreq, fmtHz, fmtMs, fmtPct, fmtRatio, from0to1, normOf, paramById, physOf, rangeOf, ratioNorm, ratioOf,
  snapToRange, stateNum, thresholdDb, thresholdNorm, to0to1,
} from "./params";
import type { Plugin, PluginParam } from "../../types";

const EQ_FREQ = { min: 20, max: 20000 };

describe("physOf / normOf (linear, as every effect built-in maps them)", () => {
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
  it("is exactly linear when no skew is sent (existing panels unchanged)", () => {
    for (const v of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      const p = { index: 0, name: "F", value: v, min: -30, max: 0 };
      expect(physOf(p, EQ_FREQ)).toBe(-30 + v * 30);
      expect(normOf(p, -30 + v * 30, EQ_FREQ)).toBeCloseTo(v, 12);
    }
  });
});

// 4OSC's skewed ranges (Tracktion FourOscPlugin: amp/filter/mod times skew 0.2, levels and
// the delay feedback/crossfeed skew 4, LFO rate skew 0.3, Tune interval 1).
const AMP_TIME = { min: 0.001, max: 60, skew: 0.2 };
const LEVEL = { min: -100, max: 0, skew: 4 };
const time = (value: number): PluginParam => ({ index: 40, id: "ampAttack", name: "Amp Attack", value, min: 0.001, max: 60, skew: 0.2 });
const level = (value: number): PluginParam => ({ index: 2, id: "level1", name: "Level 1", value, min: -100, max: 0, skew: 4 });

describe("physOf / normOf with a JUCE skew", () => {
  it("pins the research numbers at v = 0.5", () => {
    expect(physOf(time(0.5), AMP_TIME)).toBeCloseTo(1.87597, 5);          // not 30 s: v^(1/0.2) = v^5
    expect(physOf(level(0.5), LEVEL)).toBeCloseTo(-15.910, 3);            // -100 + 100·0.5^(1/4)
    expect(physOf({ index: 28, name: "Rate 1", value: 0.5, min: 0, max: 500, skew: 0.3 }, EQ_FREQ)).toBeCloseTo(49.606, 3);
  });
  it("reads the engine's skew even when the fallback is linear, and the fallback's when the engine sent no range", () => {
    expect(physOf(time(0.5), { min: 0, max: 1 })).toBeCloseTo(1.87597, 5);
    expect(physOf({ index: 40, name: "Amp Attack", value: 0.5 }, AMP_TIME)).toBeCloseTo(1.87597, 5);
    // an engine range WITHOUT skew is linear, whatever the fallback says
    expect(physOf({ index: 0, name: "X", value: 0.5, min: 0.001, max: 60 }, AMP_TIME)).toBeCloseTo(30.0005, 6);
  });
  it("round-trips physical values exactly enough to draw and drag through", () => {
    for (const s of [0.001, 0.0123, 0.1, 0.5, 1.87597, 10, 59.999]) expect(physOf(time(normOf(time(0), s, AMP_TIME)), AMP_TIME)).toBeCloseTo(s, 9);
    for (const db of [-100, -48, -15.910, -6, -0.5, 0]) expect(physOf(level(normOf(level(0), db, LEVEL)), LEVEL)).toBeCloseTo(db, 9);
    for (const v of [0, 0.01, 0.2777, 0.5, 0.99, 1]) expect(normOf(time(v), physOf(time(v), AMP_TIME), AMP_TIME)).toBeCloseTo(v, 12);
    // the engine's defaults: 0.1 s → 0.2777, 0 dB → 1, -10 dB delay feedback → 0.9^4
    expect(normOf(time(0), 0.1, AMP_TIME)).toBeCloseTo(0.27765, 5);
    expect(normOf(level(0), 0, LEVEL)).toBe(1);
    expect(to0to1({ min: -100, max: 0, skew: 4 }, -10)).toBeCloseTo(0.6561, 12);
  });
  it("v = 0 is the bottom of the range, not NaN (JUCE skips the log at 0)", () => {
    expect(physOf(time(0), AMP_TIME)).toBe(0.001);
    expect(from0to1(AMP_TIME, 0)).toBe(0.001);
    expect(to0to1(AMP_TIME, 0.001)).toBe(0);
  });
  it("supports a symmetric skew (JUCE's centre-out mapping)", () => {
    const r = { min: -1, max: 1, skew: 0.5, symmetricSkew: true };
    expect(from0to1(r, 0.5)).toBeCloseTo(0, 12);
    expect(from0to1(r, 0.75)).toBeCloseTo(0.25, 12);          // d = 0.5 → 0.5^(1/0.5) = 0.25
    expect(from0to1(r, 0.25)).toBeCloseTo(-0.25, 12);
    for (const v of [0, 0.1, 0.4, 0.5, 0.8, 1]) expect(to0to1(r, from0to1(r, v))).toBeCloseTo(v, 12);
  });
});

describe("step snapping (a range's interval)", () => {
  const tune = (value: number): PluginParam => ({ index: 0, id: "tune1", name: "Tune 1", value, min: -36, max: 36, step: 1 });
  it("snaps physical values to whole steps both ways", () => {
    expect(physOf(tune(0.5), { min: -36, max: 36 })).toBe(0);
    expect(physOf(tune(0.5 + 0.4 / 72), { min: -36, max: 36 })).toBe(0);      // 0.4 st → 0
    expect(physOf(tune(0.5 + 0.6 / 72), { min: -36, max: 36 })).toBe(1);      // 0.6 st → 1
    expect(normOf(tune(0), 7.4, { min: -36, max: 36 })).toBeCloseTo(43 / 72, 12);
    expect(normOf(tune(0), -12.5, { min: -36, max: 36 })).toBeCloseTo(24 / 72, 12);   // JUCE: floor(x + 0.5)
    expect(normOf(tune(0), 99, { min: -36, max: 36 })).toBe(1);
  });
  it("snapToRange clamps without a step and snaps from the range's start with one", () => {
    expect(snapToRange({ min: 6, max: 48, step: 6 }, 25)).toBe(24);
    expect(snapToRange({ min: 6, max: 48, step: 6 }, 27)).toBe(30);
    expect(snapToRange({ min: 6, max: 48, step: 6 }, 0)).toBe(6);
    expect(snapToRange({ min: 6, max: 48, step: 6 }, 100)).toBe(48);
    expect(snapToRange({ min: 0, max: 1 }, 1.7)).toBe(1);
  });
  it("rangeOf takes skew/step from the engine param, never a stale fallback", () => {
    expect(rangeOf(tune(0), { min: 0, max: 1, skew: 3 })).toEqual({ min: -36, max: 36, step: 1 });
    expect(rangeOf(undefined, { min: 0, max: 60, skew: 0.2 })).toEqual({ min: 0, max: 60, skew: 0.2 });
  });
  it("paramById binds by the engine id (names repeat)", () => {
    const p = { params: [{ index: 58, id: "reverbMix", name: "Mix", value: 0 }, { index: 61, id: "delayMix", name: "Mix", value: 0.3 }] } as unknown as Plugin;
    expect(paramById(p, "delayMix")?.index).toBe(61);
    expect(paramById(p, "chorusMix")).toBeUndefined();
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
