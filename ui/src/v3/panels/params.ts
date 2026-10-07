// Reading and writing native plugin parameters in physical units.
//
// The snapshot carries each parameter's normalised 0-1 value and, for most parameters, the
// physical range it maps onto (JUCE NormalisableRange, non-symmetric):
//   phys = min + (max − min)·v^(1/skew)        v = ((phys − min)/(max − min))^skew
// `skew` is sent only when it is not 1, so every effect built-in (no skew) stays linear:
// phys = min + v·(max − min). 4OSC is the skewed one: its times are skew 0.2 (v = 0.5 is
// 1.876 s, not 30 s), its levels skew 4, its LFO rate skew 0.3. A `step` (the range's
// interval, e.g. 4OSC Tune in whole semitones) snaps physical values to min + k·step, as
// JUCE's snapToLegalValue does. A panel passes the documented range (and skew/step) as the
// fallback for parameters the engine sends without a range (mock or older sessions); when
// the engine DOES send min/max, its skew/step (or their absence) win over the fallback's.
import type { Plugin, PluginParam, PluginStateValue } from "../../types";

/** A physical range. `skew`/`symmetricSkew`/`step` follow JUCE NormalisableRange; absent
 *  means linear and continuous. */
export type Range = { min: number; max: number; skew?: number; symmetricSkew?: boolean; step?: number };

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const param = (plugin: Plugin, index: number): PluginParam | undefined =>
  plugin.params.find((p) => p.index === index);

/** The parameter with engine id `id` (4OSC: "ampAttack", "level1", …). Names repeat inside
 *  one plugin; ids do not. */
export const paramById = (plugin: Plugin, id: string): PluginParam | undefined =>
  plugin.params.find((p) => p.id === id);

/** The mapping a parameter uses: the engine's when it sent a range, else the fallback. */
export function rangeOf(p: PluginParam | undefined, fallback: Range): Range {
  const engine = typeof p?.min === "number" && typeof p?.max === "number" && p.max > p.min;
  if (engine) {
    return {
      min: p!.min!, max: p!.max!,
      ...(typeof p!.skew === "number" && p!.skew > 0 && p!.skew !== 1 ? { skew: p!.skew } : {}),
      ...(p!.symmetricSkew ? { symmetricSkew: true } : {}),
      ...(typeof p!.step === "number" && p!.step > 0 ? { step: p!.step } : {}),
    };
  }
  // A half-sent range (only min, or only max) keeps the engine's end, as before.
  const min = typeof p?.min === "number" ? p.min : fallback.min;
  const max = typeof p?.max === "number" ? p.max : fallback.max;
  return max > min ? { ...fallback, min, max } : fallback;
}

const skewOf = (r: Range): number => (typeof r.skew === "number" && r.skew > 0 && Number.isFinite(r.skew) ? r.skew : 1);

/** JUCE NormalisableRange::convertFrom0to1 (no snapping). */
export function from0to1(r: Range, v: number): number {
  const p = clamp01(v);
  const skew = skewOf(r);
  if (!r.symmetricSkew) {
    const q = skew !== 1 && p > 0 ? Math.exp(Math.log(p) / skew) : p;
    return r.min + (r.max - r.min) * q;
  }
  let d = 2 * p - 1;
  if (skew !== 1 && d !== 0) d = Math.exp(Math.log(Math.abs(d)) / skew) * (d < 0 ? -1 : 1);
  return r.min + ((r.max - r.min) / 2) * (1 + d);
}

/** JUCE NormalisableRange::convertTo0to1 (clamped to 0..1). */
export function to0to1(r: Range, phys: number): number {
  if (!(r.max > r.min) || !Number.isFinite(phys)) return 0;
  const p = clamp01((phys - r.min) / (r.max - r.min));
  const skew = skewOf(r);
  if (skew === 1) return p;
  if (!r.symmetricSkew) return clamp01(p ** skew);
  const d = 2 * p - 1;
  return clamp01((1 + Math.abs(d) ** skew * (d < 0 ? -1 : 1)) / 2);
}

/** Snap a physical value to the range's step and clamp it into the range (JUCE
 *  snapToLegalValue: start + step·floor((v − start)/step + 0.5)). No step: only clamped. */
export function snapToRange(r: Range, phys: number): number {
  let v = phys;
  if (typeof r.step === "number" && r.step > 0) v = r.min + r.step * Math.floor((v - r.min) / r.step + 0.5);
  return clamp(v, r.min, r.max);
}

/** The parameter's value in physical units (snapped to its step, when it has one). */
export function physOf(p: PluginParam | undefined, fallback: Range): number {
  const r = rangeOf(p, fallback);
  const phys = from0to1(r, p?.value ?? 0);
  return r.step ? snapToRange(r, phys) : phys;
}

/** The normalised value set_plugin_param takes for a physical value (snapped to the step,
 *  clamped to the range). */
export function normOf(p: PluginParam | undefined, phys: number, fallback: Range): number {
  const r = rangeOf(p, fallback);
  return to0to1(r, r.step ? snapToRange(r, phys) : phys);
}

export const stateOf = (plugin: Plugin, key: string): PluginStateValue | undefined => plugin.state?.[key];

/** A numeric state value, or `fallback` when absent or not a number. */
export function stateNum(plugin: Plugin, key: string, fallback: number): number {
  const v = plugin.state?.[key]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ── formatting (compact, for 286 px rows) ──────────────────────────────────────────────

/** "80 Hz", "950 Hz", "1.2k", "17k". */
export function fmtHz(hz: number): string {
  if (!Number.isFinite(hz)) return "–";
  // Decide the form from the ROUNDED value, so 999.7 Hz is "1.0k" (not "1000 Hz") and
  // 9960 Hz is "10k" (not "10.0k").
  if (Math.round(hz) < 1000) return `${Math.round(hz)} Hz`;
  const tenths = Math.round(hz / 100) / 10;
  if (tenths < 10) return `${tenths.toFixed(1)}k`;
  return `${Math.round(hz / 1000)}k`;
}

/** In-panel frequency read-out: "80 Hz", "950 Hz", "1.20 kHz", "12.0 kHz" (fmtHz is the
 *  shorter form for one-line summaries). */
export function fmtFreq(hz: number): string {
  if (!Number.isFinite(hz)) return "–";
  if (Math.round(hz) < 1000) return `${Math.round(hz)} Hz`;
  const k = hz / 1000;
  return Number(k.toFixed(2)) < 10 ? `${k.toFixed(2)} kHz` : `${k.toFixed(1)} kHz`;
}

/** "+3.0 dB", "-2.5 dB", "0.0 dB" (never "-0.0"). */
export function fmtDb(db: number, decimals = 1): string {
  if (!Number.isFinite(db)) return db < 0 ? "-∞ dB" : "∞ dB";
  const r = Number(db.toFixed(decimals));
  const v = Object.is(r, -0) || r === 0 ? 0 : r;
  return `${v > 0 ? "+" : ""}${v.toFixed(decimals)} dB`;
}

/** "4.5 ms", "150 ms", "1.20 s". */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/** 0.3 → "30%". */
export const fmtPct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

// ── the compressor's two non-linear encodings (src/moshops/TrackPreset.h kCompressorParams)

/** Threshold is a LINEAR GAIN 0.01..1 (-40..0 dB), linear in the normalised value. */
export const thresholdDb = (norm: number): number => 20 * Math.log10(0.01 + 0.99 * clamp01(norm));
export const thresholdNorm = (db: number): number => clamp01((10 ** (db / 20) - 0.01) / 0.99);

/** Ratio is stored as the reciprocal slope 0..0.95 (higher compresses LESS); N in N:1. */
export function ratioOf(norm: number): number {
  const slope = 0.95 * clamp01(norm);
  return slope > 0 ? 1 / slope : Infinity;
}
export const ratioNorm = (n: number): number => (n === Infinity || n <= 0 ? 0 : clamp01(1 / (0.95 * n)));
/** "2.5:1", "4:1", "∞:1". */
export function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return "∞:1";
  const r = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${r}:1`;
}
