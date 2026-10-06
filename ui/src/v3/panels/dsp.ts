// Filter maths for the native plugin panels, matching the engine exactly.
//
// Tracktion's EQ and low/high-pass run JUCE's IIRCoefficients makers
// (juce_audio_basics/utilities/juce_IIRFilter.cpp). Those formulas are reproduced here,
// line for line, so a drawn curve is the curve the audio goes through, not an
// approximation of it. Every coefficient set is normalised by a0, as JUCE does.

/** A normalised biquad: y = b0·x + b1·x₋₁ + b2·x₋₂ − a1·y₋₁ − a2·y₋₂. */
export type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function normalise(c1: number, c2: number, c3: number, c4: number, c5: number, c6: number): Biquad {
  const a = 1 / c4;
  return { b0: c1 * a, b1: c2 * a, b2: c3 * a, a1: c5 * a, a2: c6 * a };
}

const SQRT1_2 = 1 / Math.SQRT2;

/** JUCE IIRCoefficients::makeLowPass (Q defaults to 1/√2: a 12 dB/oct Butterworth). */
export function lowPass(fs: number, fc: number, q = SQRT1_2): Biquad {
  const n = 1 / Math.tan(Math.PI * fc / fs);
  const n2 = n * n;
  const c1 = 1 / (1 + (1 / q) * n + n2);
  return normalise(c1, c1 * 2, c1, 1, c1 * 2 * (1 - n2), c1 * (1 - (1 / q) * n + n2));
}

/** JUCE IIRCoefficients::makeHighPass (Q defaults to 1/√2). */
export function highPass(fs: number, fc: number, q = SQRT1_2): Biquad {
  const n = Math.tan(Math.PI * fc / fs);
  const n2 = n * n;
  const c1 = 1 / (1 + (1 / q) * n + n2);
  return normalise(c1, c1 * -2, c1, 1, c1 * 2 * (n2 - 1), c1 * (1 - (1 / q) * n + n2));
}

/** JUCE Decibels::gainWithLowerBound(gain, -100 dB), as the shelf/peak makers apply it. */
function gainWithLowerBound(gain: number): number {
  return gain <= 1e-5 ? 0 : gain;
}

/** dB to the linear gain factor Tracktion's EQ passes to the makers. */
export const dbToGain = (db: number): number => 10 ** (db / 20);

/** JUCE IIRCoefficients::makeLowShelf(fs, cutoff, Q, gainFactor). */
export function lowShelf(fs: number, cutoff: number, q: number, gainDb: number): Biquad {
  const A = Math.sqrt(gainWithLowerBound(dbToGain(gainDb)));
  const am1 = A - 1, ap1 = A + 1;
  const omega = (2 * Math.PI * Math.max(cutoff, 2)) / fs;
  const coso = Math.cos(omega);
  const beta = (Math.sin(omega) * Math.sqrt(A)) / q;
  const am1c = am1 * coso;
  return normalise(
    A * (ap1 - am1c + beta), A * 2 * (am1 - ap1 * coso), A * (ap1 - am1c - beta),
    ap1 + am1c + beta, -2 * (am1 + ap1 * coso), ap1 + am1c - beta);
}

/** JUCE IIRCoefficients::makeHighShelf(fs, cutoff, Q, gainFactor). */
export function highShelf(fs: number, cutoff: number, q: number, gainDb: number): Biquad {
  const A = Math.sqrt(gainWithLowerBound(dbToGain(gainDb)));
  const am1 = A - 1, ap1 = A + 1;
  const omega = (2 * Math.PI * Math.max(cutoff, 2)) / fs;
  const coso = Math.cos(omega);
  const beta = (Math.sin(omega) * Math.sqrt(A)) / q;
  const am1c = am1 * coso;
  return normalise(
    A * (ap1 + am1c + beta), A * -2 * (am1 + ap1 * coso), A * (ap1 + am1c - beta),
    ap1 - am1c + beta, 2 * (am1 - ap1 * coso), ap1 - am1c - beta);
}

/** JUCE IIRCoefficients::makePeakFilter(fs, freq, Q, gainFactor). */
export function peak(fs: number, freq: number, q: number, gainDb: number): Biquad {
  const A = Math.sqrt(gainWithLowerBound(dbToGain(gainDb)));
  const omega = (2 * Math.PI * Math.max(freq, 2)) / fs;
  const alpha = (0.5 * Math.sin(omega)) / q;
  const c2 = -2 * Math.cos(omega);
  const aA = alpha * A, aOverA = alpha / A;
  return normalise(1 + aA, c2, 1 - aA, 1 + aOverA, c2, 1 - aOverA);
}

/** |H(f)|² of a biquad at frequency f (Hz) and sample rate fs. */
export function biquadMagSq(c: Biquad, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w), sw = Math.sin(w), c2w = Math.cos(2 * w), s2w = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2w, ni = -(c.b1 * sw + c.b2 * s2w);
  const dr = 1 + c.a1 * cw + c.a2 * c2w, di = -(c.a1 * sw + c.a2 * s2w);
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}

/** The biquad's gain in dB at f, floored at -120 dB (a true zero, e.g. at Nyquist). */
export function biquadDb(c: Biquad, f: number, fs: number): number {
  const m = biquadMagSq(c, f, fs);
  return m > 1e-12 ? 10 * Math.log10(m) : -120;
}

/** The summed dB of several biquads in series at f. */
export function chainDb(chain: readonly Biquad[], f: number, fs: number): number {
  return chain.reduce((sum, c) => sum + biquadDb(c, f, fs), 0);
}

/** `n` log-spaced frequencies from lo to hi inclusive. */
export function logFreqs(n: number, lo = 20, hi = 20000): number[] {
  if (n < 2) return [lo];
  const a = Math.log(lo), b = Math.log(hi);
  return Array.from({ length: n }, (_, i) => Math.exp(a + ((b - a) * i) / (n - 1)));
}

/** The highest frequency worth drawing at a sample rate: just under Nyquist, at most 20 kHz. */
export const plotTopHz = (fs: number): number => Math.min(20000, (fs > 0 ? fs : 48000) * 0.499);
