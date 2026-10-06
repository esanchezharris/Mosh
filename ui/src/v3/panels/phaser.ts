// Tracktion's PhaserPlugin, as numbers the panel draws (tracktion_Phaser.cpp; research key
// "chorus+phaser"). Like the chorus it has NO automatable parameters: depth (octaves), rate
// (Hz) and feedback live in `plugin.state` and are set with set_plugin_state.
//
// DSP, per sample: four first-order allpasses y = c·(y₁ + x) − x₁ with c = (1−swp)/(1+swp),
// so S(z) = (c − z⁻¹)/(1 − c·z⁻¹); the input is t = x + g·w[n−1] (w = the 4th stage's
// output) and the output is y = x + w, with no mix or trim (:71-94). Exact response:
//   H(z) = 1 + S⁴ / (1 − g·z⁻¹·S⁴),  z = e^{j2πf/fs}.
// The sweep: swp runs between minSweep = π·100/fs and maxSweep = π·100·2^depth/fs (:35-36,
// :51, :55-56), multiplied each sample by (2^depth)^(±rate/(fs/2)) (:52-53, :99): a
// triangle in octaves, rising first, period 1/rate s. Break frequency f = (fs/π)·atan(swp).
import type { Plugin } from "../../types";
import { logFreqs, plotTopHz } from "./dsp";
import { firstThatFits, trimNum } from "./chorus";
import { fmtFreq, stateNum, type Range } from "./params";

export const PHASER_BASE_HZ = 100;

export type PhaserKey = "rate" | "depth" | "feedback";
/** The engine's defaults (tracktion_Phaser.cpp:18-20) and the contract's ranges/steps. */
export const PHASER_SPEC: Record<PhaserKey, { def: number; range: Range; step: number }> = {
  rate: { def: 0.4, range: { min: 0.05, max: 10 }, step: 0.01 },
  depth: { def: 5, range: { min: 0, max: 8 }, step: 0.1 },
  feedback: { def: 0.7, range: { min: -0.95, max: 0.95 }, step: 0.01 },
};

export type PhaserSettings = Record<PhaserKey, number>;

export function phaserSettings(plugin: Plugin): PhaserSettings {
  const n = (k: PhaserKey) => stateNum(plugin, k, PHASER_SPEC[k].def);
  return { rate: n("rate"), depth: n("depth"), feedback: n("feedback") };
}

/** The allpass sweep variable's bounds at a sample rate. */
export function sweepBounds(fs: number, depth: number): { min: number; max: number } {
  const min = (Math.PI * PHASER_BASE_HZ) / fs;
  return { min, max: min * 2 ** Math.max(0, depth) };
}

/** The sweep variable `octaves` above its minimum. */
export const sweepAt = (fs: number, octaves: number): number => ((Math.PI * PHASER_BASE_HZ) / fs) * 2 ** octaves;

/** The allpasses' break frequency (Hz) for a sweep value: (fs/π)·atan(swp). */
export const breakHz = (swp: number, fs: number): number => (fs / Math.PI) * Math.atan(swp);

/** The Hz span the sweep travels: about 100 Hz to 100·2^depth Hz, atan-warped near Nyquist. */
export function sweepSpanHz(fs: number, depth: number): [number, number] {
  const b = sweepBounds(fs, depth);
  return [breakHz(b.min, fs), breakHz(b.max, fs)];
}

/** Where the sweep sits (octaves above the minimum) at an LFO position in cycles: a
 *  triangle, rising first (sweepFactor starts at 1.001, tracktion_Phaser.cpp:37). */
export function sweepOctaves(depth: number, cycles: number): number {
  const p = ((cycles % 1) + 1) % 1;
  return Math.max(0, depth) * (p < 0.5 ? 2 * p : 2 - 2 * p);
}

/** |H| (linear) at f for a sweep value and feedback gain: the engine's exact response. */
export function phaserMag(f: number, fs: number, swp: number, g: number): number {
  const w = (2 * Math.PI * f) / fs;
  const zr = Math.cos(w), zi = -Math.sin(w);            // z⁻¹
  const c = (1 - swp) / (1 + swp);
  // S = (c − z⁻¹) / (1 − c·z⁻¹)
  const nr = c - zr, ni = -zi, dr = 1 - c * zr, di = -c * zi;
  const dd = dr * dr + di * di;
  const sr = (nr * dr + ni * di) / dd, si = (ni * dr - nr * di) / dd;
  // S⁴
  const s2r = sr * sr - si * si, s2i = 2 * sr * si;
  const s4r = s2r * s2r - s2i * s2i, s4i = 2 * s2r * s2i;
  // 1 − g·z⁻¹·S⁴
  const qr = 1 - g * (zr * s4r - zi * s4i), qi = -g * (zr * s4i + zi * s4r);
  const qq = qr * qr + qi * qi;
  // H = 1 + S⁴ / q
  const hr = 1 + (s4r * qr + s4i * qi) / qq, hi = (s4i * qr - s4r * qi) / qq;
  return Math.hypot(hr, hi);
}

/** |H| in dB, floored at -120 (a true notch). */
export function phaserDb(f: number, fs: number, swp: number, g: number): number {
  const m = phaserMag(f, fs, swp, g);
  return m > 1e-6 ? 20 * Math.log10(m) : -120;
}

/** Gain at DC: 1 + 1/(1−g), the low-end boost (+12.7 dB at the default 0.7). */
export const dcBoostDb = (g: number): number => 20 * Math.log10(1 + 1 / (1 - g));
/** Gain at Nyquist: 1 + 1/(1+g). */
export const nyquistBoostDb = (g: number): number => 20 * Math.log10(1 + 1 / (1 + g));
/** The largest gain anywhere: 1 + 1/(1−|g|) (DC for g ≥ 0, Nyquist for g < 0). */
export const peakBoostDb = (g: number): number => 20 * Math.log10(1 + 1 / (1 - Math.abs(g)));

/** Where the response can go over a whole sweep, on the plot's frequencies: at each
 *  frequency the highest and lowest |H| (dB) for the sweep anywhere from 0 to `depth`
 *  octaves (sixteenth-octave steps: coarser steps scallop the envelope with ripples the
 *  real sweep does not have), and the highest point of all, in the drawn band
 *  (20 Hz to plotTopHz). This is static truth; only where the sweep is NOW is unknown. */
export type SweepEnvelope = { freqs: number[]; maxDb: number[]; minDb: number[]; peakDb: number; peakHz: number };
const ENV_CACHE = new Map<string, SweepEnvelope>();
export function sweepEnvelope(fs: number, depth: number, g: number, n = 128, lo = 20): SweepEnvelope {
  const key = `${fs}|${depth}|${g}|${n}|${lo}`;
  const hit = ENV_CACHE.get(key);
  if (hit) return hit;
  const freqs = logFreqs(n, lo, plotTopHz(fs));
  const d = Math.max(0, depth);
  const steps = Math.max(1, Math.ceil(d * 16));
  const swps = Array.from({ length: steps + 1 }, (_, i) => sweepAt(fs, (d * i) / steps));
  let peakDb = -Infinity, peakHz = lo;
  const maxDb: number[] = [], minDb: number[] = [];
  let bestOct = 0;
  for (const f of freqs) {
    let hi = -Infinity, low = Infinity;
    swps.forEach((swp, j) => {
      const db = phaserDb(f, fs, swp, g);
      if (db > hi) hi = db;
      if (db < low) low = db;
      if (db > peakDb) { peakDb = db; peakHz = f; bestOct = (d * j) / steps; }
    });
    maxDb.push(hi);
    minDb.push(low);
  }
  // The grid can fall between a resonance's samples: climb from the best grid point (in
  // log-frequency and sweep octaves, halving the step) to the true in-band maximum.
  const top = plotTopHz(fs);
  let lf = Math.log(peakHz), o = bestOct;
  let dl = Math.log(top / lo) / (n - 1), dOct = d / steps;
  for (let it = 0; it < 24; it++) {
    let moved = false;
    for (const [a, b] of [[dl, 0], [-dl, 0], [0, dOct], [0, -dOct]] as const) {
      const f2 = Math.exp(lf + a), o2 = o + b;
      if (f2 < lo || f2 > top || o2 < 0 || o2 > d) continue;
      const db = phaserDb(f2, fs, sweepAt(fs, o2), g);
      if (db > peakDb) { peakDb = db; lf += a; o = o2; moved = true; }
    }
    if (!moved) { dl /= 2; dOct /= 2; }
  }
  peakHz = Math.exp(lf);
  const env = { freqs, maxDb, minDb, peakDb, peakHz };
  if (ENV_CACHE.size > 24) ENV_CACHE.delete(ENV_CACHE.keys().next().value!);
  ENV_CACHE.set(key, env);
  return env;
}

/** The envelope's upper edge as drawn: a 3-point running max. The sweep is sampled every
 *  sixteenth of an octave, so a resonance passing between two samples leaves a small dip
 *  the real sweep does not have; the neighbour's maximum is the closer truth. */
export function smoothUpper(maxDb: readonly number[]): number[] {
  return maxDb.map((v, i) => Math.max(v, maxDb[i - 1] ?? v, maxDb[i + 1] ?? v));
}

/** With no feedback, the two notches: (fs/π)·atan(swp·tan(π/8)) and (fs/π)·atan(swp·tan(3π/8)). */
export function notchesHz(swp: number, fs: number): [number, number] {
  return [breakHz(swp * Math.tan(Math.PI / 8), fs), breakHz(swp * Math.tan((3 * Math.PI) / 8), fs)];
}

/** "100 Hz–3.15 kHz". */
export function fmtSpan(fs: number, depth: number): string {
  const [lo, hi] = sweepSpanHz(fs, depth);
  return `${fmtFreq(lo)}–${fmtFreq(hi)}`;
}

export const fmtOct = (oct: number): string => `${oct.toFixed(1)} oct`;
/** Feedback is bipolar: "+70%", "-40%", "0%". */
export function fmtFeedback(g: number): string {
  const n = Math.round(g * 100);
  return `${n > 0 ? "+" : ""}${Object.is(n, -0) ? 0 : n}%`;
}

/** One short line for the minimized header, most telling first: rate and depth,
 *  "0.40 Hz · 5 oct" (the Hz span depends on the sample rate, which summary() is not
 *  given, and feedback is left to the panel). Where the exact figures are too long for the
 *  row, trailing zeros go ("2.5 Hz · 3.2 oct"), then the depth is rounded and marked
 *  ("0.45 Hz · ~3 oct"). */
export function phaserSummary(plugin: Plugin): string {
  const s = phaserSettings(plugin);
  const rate = `${s.rate >= 10 ? s.rate.toFixed(1) : s.rate.toFixed(2)} Hz`;
  const short = `${trimNum(s.rate, s.rate >= 10 ? 1 : 2)} Hz`;
  const oct = `${trimNum(s.depth, 1)} oct`;
  return firstThatFits([`${rate} · ${oct}`, `${short} · ${oct}`, `${short} · ~${Math.round(s.depth)} oct`]);
}
