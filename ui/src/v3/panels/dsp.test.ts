import { describe, it, expect } from "vitest";
import { biquadDb, chainDb, highPass, highShelf, logFreqs, lowPass, lowShelf, peak, plotTopHz } from "./dsp";

const FS = 48000;

describe("Butterworth low/high-pass (JUCE 2-argument makers)", () => {
  it("is -3.01 dB at the cutoff and falls 12 dB/oct beyond it", () => {
    const hp = highPass(FS, 180);
    expect(biquadDb(hp, 180, FS)).toBeCloseTo(-3.0103, 3);
    // Numbers from the research (bilinear Butterworth closed form at 48 kHz).
    expect(biquadDb(hp, 90, FS)).toBeCloseTo(-12.30, 1);
    expect(biquadDb(hp, 45, FS)).toBeCloseTo(-24.1, 0);
    expect(biquadDb(hp, 5000, FS)).toBeCloseTo(0, 2);

    const lp = lowPass(FS, 4000);
    expect(biquadDb(lp, 4000, FS)).toBeCloseTo(-3.0103, 3);
    expect(biquadDb(lp, 8000, FS)).toBeCloseTo(-13.53, 1);
    expect(biquadDb(lp, 100, FS)).toBeCloseTo(0, 2);
  });

  it("matches the closed form |H|² = 1/(1 + (W/Wc)^4) with W = tan(πf/fs)", () => {
    const fc = 1234, lp = lowPass(FS, fc);
    for (const f of [50, 400, 2000, 9000, 17000]) {
      const r = Math.tan(Math.PI * f / FS) / Math.tan(Math.PI * fc / FS);
      expect(biquadDb(lp, f, FS)).toBeCloseTo(10 * Math.log10(1 / (1 + r ** 4)), 6);
    }
  });

  it("has a true zero: the low-pass at Nyquist floors instead of going to -Infinity", () => {
    expect(biquadDb(lowPass(FS, 4000), FS / 2, FS)).toBe(-120);
  });
});

describe("RBJ shelves and peak (Tracktion's 4-band EQ)", () => {
  it("a peak reaches its full gain exactly at its frequency", () => {
    for (const g of [-12, -3, 6, 18]) expect(biquadDb(peak(FS, 1000, 0.5, g), 1000, FS)).toBeCloseTo(g, 6);
    expect(biquadDb(peak(FS, 1000, 0.5, 6), 20, FS)).toBeCloseTo(0, 1);
  });

  it("is unity at 0 dB (the engine skips the band, and the curve agrees)", () => {
    for (const make of [lowShelf, highShelf, peak]) {
      for (const f of [30, 1000, 15000]) expect(biquadDb(make(FS, 1000, 0.5, 0), f, FS)).toBeCloseTo(0, 9);
    }
  });

  it("a low shelf reaches its gain well below the corner and is unity well above; a high shelf the reverse", () => {
    const ls = lowShelf(FS, 200, 0.5, 6);
    expect(biquadDb(ls, 20, FS)).toBeCloseTo(6, 0);
    expect(biquadDb(ls, 10000, FS)).toBeCloseTo(0, 1);
    const hs = highShelf(FS, 5000, 0.5, -9);
    expect(biquadDb(hs, 20000, FS)).toBeCloseTo(-9, 0);
    expect(biquadDb(hs, 50, FS)).toBeCloseTo(0, 1);
    // RBJ shelves pass half their gain (in dB) at the corner frequency.
    expect(biquadDb(lowShelf(FS, 300, 0.707, 12), 300, FS)).toBeCloseTo(6, 1);
  });

  it("a chain sums its bands in dB", () => {
    const chain = [peak(FS, 500, 1, 6), peak(FS, 500, 1, 6)];
    expect(chainDb(chain, 500, FS)).toBeCloseTo(12, 6);
  });
});

describe("logFreqs / plotTopHz", () => {
  it("spans the range log-evenly", () => {
    const f = logFreqs(4, 20, 20000);
    expect(f[0]).toBeCloseTo(20, 9);
    expect(f[3]).toBeCloseTo(20000, 6);
    expect(f[1] / f[0]).toBeCloseTo(f[2] / f[1], 9);
  });
  it("stops under Nyquist", () => {
    expect(plotTopHz(48000)).toBe(20000);
    expect(plotTopHz(22050)).toBeCloseTo(11002.95, 2);
    expect(plotTopHz(0)).toBe(20000);
  });
});
