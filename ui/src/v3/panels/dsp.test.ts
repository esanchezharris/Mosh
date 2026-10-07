import { describe, it, expect } from "vitest";
import {
  bandPass, biquadDb, butterworth, butterworthQs, chainDb, firstOrderHighPass, firstOrderLowPass, highPass, highShelf,
  logFreqs, lowPass, lowShelf, notch, peak, plotTopHz,
} from "./dsp";

const FS = 48000;

describe("Butterworth cascade (the slope setting: order N = slope / 6)", () => {
  const SLOPES = [6, 12, 18, 24, 30, 36, 42, 48];
  it("pins the research numbers: HP 180 Hz read at 90 Hz, LP 4 kHz read at 8 kHz", () => {
    const hp = [-6.990, -12.305, -18.130, -24.101, -30.109, -36.126, -42.147, -48.167];
    const lp = [-7.515, -13.532, -20.046, -26.680, -33.341, -40.007, -46.674, -53.342];
    SLOPES.forEach((slope, i) => {
      expect(chainDb(butterworth("highpass", FS, 180, slope / 6), 90, FS)).toBeCloseTo(hp[i]!, 3);
      expect(chainDb(butterworth("lowpass", FS, 4000, slope / 6), 8000, FS)).toBeCloseTo(lp[i]!, 3);
    });
  });
  it("is -3.0103 dB at the cutoff for every order, both modes", () => {
    for (const slope of SLOPES) for (const fc of [80, 180, 1234, 9000]) {
      expect(chainDb(butterworth("lowpass", FS, fc, slope / 6), fc, FS)).toBeCloseTo(-3.0103, 4);
      expect(chainDb(butterworth("highpass", FS, fc, slope / 6), fc, FS)).toBeCloseTo(-3.0103, 4);
    }
  });
  it("matches the bilinear closed form 1/(1 + (W/Wc)^2N) with W = tan(πf/fs)", () => {
    for (let N = 1; N <= 8; N++) for (const f of [30, 300, 2000, 7000, 15000]) {
      const r = Math.tan(Math.PI * f / FS) / Math.tan(Math.PI * 1000 / FS);
      expect(chainDb(butterworth("lowpass", FS, 1000, N), f, FS)).toBeCloseTo(-10 * Math.log10(1 + r ** (2 * N)), 6);
      expect(chainDb(butterworth("highpass", FS, 1000, N), f, FS)).toBeCloseTo(-10 * Math.log10(1 + r ** (-2 * N)), 6);
    }
  });
  it("12 dB/oct is the 2-argument JUCE maker itself (bit-identical today)", () => {
    expect(butterworthQs(2)).toEqual([1 / Math.SQRT2]);
    expect(butterworth("lowpass", FS, 4000, 2)).toEqual([lowPass(FS, 4000)]);
    expect(butterworth("highpass", FS, 180, 2)).toEqual([highPass(FS, 180)]);
  });
  it("has the research's Q table and section counts", () => {
    const Q: Record<number, number[]> = {
      1: [], 3: [1.0], 4: [1.306563, 0.541196], 5: [1.618034, 0.618034], 6: [1.931852, 0.707107, 0.517638],
      7: [2.246980, 0.801938, 0.554958], 8: [2.562915, 0.899976, 0.601345, 0.509796],
    };
    for (const [N, qs] of Object.entries(Q)) {
      const got = butterworthQs(Number(N));
      expect(got).toHaveLength(qs.length);
      got.forEach((q, i) => expect(q).toBeCloseTo(qs[i]!, 5));
      expect(butterworth("lowpass", FS, 1000, Number(N))).toHaveLength(Math.floor(Number(N) / 2) + (Number(N) % 2));
    }
  });
  it("first-order sections are 6 dB/oct and -3.01 dB at fc", () => {
    expect(biquadDb(firstOrderLowPass(FS, 1000), 1000, FS)).toBeCloseTo(-3.0103, 4);
    expect(biquadDb(firstOrderHighPass(FS, 1000), 1000, FS)).toBeCloseTo(-3.0103, 4);
    expect(biquadDb(firstOrderLowPass(FS, 1000), 20, FS)).toBeCloseTo(0, 2);
    expect(biquadDb(firstOrderHighPass(FS, 1000), 20000, FS)).toBeCloseTo(0, 2);
    // a decade above / below a low corner: about -20 dB
    expect(biquadDb(firstOrderLowPass(FS, 100), 1000, FS)).toBeCloseTo(-20.04, 1);
    expect(biquadDb(firstOrderHighPass(FS, 1000), 100, FS)).toBeCloseTo(-20.04, 1);
  });
});

describe("band-pass and notch (JUCE 3-argument makers, 4OSC's filter types)", () => {
  it("band-pass: unity at the centre, falling either side; Q narrows it", () => {
    expect(biquadDb(bandPass(FS, 1000, 0.7071), 1000, FS)).toBeCloseTo(0, 6);
    expect(biquadDb(bandPass(FS, 1000, 0.7071), 100, FS)).toBeLessThan(-15);
    expect(biquadDb(bandPass(FS, 1000, 0.7071), 10000, FS)).toBeLessThan(-15);
    expect(biquadDb(bandPass(FS, 1000, 4), 1500, FS)).toBeLessThan(biquadDb(bandPass(FS, 1000, 0.7071), 1500, FS));
    // the -3 dB edges of a bilinear band-pass sit where |W/W0 − W0/W| = 1/Q
    const w0 = Math.tan(Math.PI * 1000 / FS), Q = 2;
    const wHi = (w0 / (2 * Q)) * (1 + Math.sqrt(1 + 4 * Q * Q));
    expect(biquadDb(bandPass(FS, 1000, Q), Math.atan(wHi) * FS / Math.PI, FS)).toBeCloseTo(-3.0103, 4);
  });
  it("notch: a true zero at the centre, unity far from it", () => {
    expect(biquadDb(notch(FS, 1000, 0.7071), 1000, FS)).toBe(-120);
    expect(biquadDb(notch(FS, 1000, 0.7071), 20, FS)).toBeCloseTo(0, 2);
    expect(biquadDb(notch(FS, 1000, 0.7071), 18000, FS)).toBeCloseTo(0, 1);
  });
  it("matches the JUCE coefficient formulas term by term", () => {
    const fs = 44100, f = 440, q = 3;
    const n = 1 / Math.tan(Math.PI * f / fs), n2 = n * n, c1 = 1 / (1 + n / q + n2);
    const bp = bandPass(fs, f, q);
    expect(bp.b0).toBeCloseTo(c1 * n / q, 15);
    expect(bp.b1).toBe(0);
    expect(bp.b2).toBeCloseTo(-c1 * n / q, 15);
    expect(bp.a1).toBeCloseTo(c1 * 2 * (1 - n2), 15);
    expect(bp.a2).toBeCloseTo(c1 * (1 - n / q + n2), 15);
    const nt = notch(fs, f, q);
    expect(nt.b0).toBeCloseTo(c1 * (1 + n2), 15);
    expect(nt.b1).toBeCloseTo(2 * c1 * (1 - n2), 15);
    expect(nt.a2).toBeCloseTo(c1 * (1 - n / q + n2), 15);
  });
});

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
