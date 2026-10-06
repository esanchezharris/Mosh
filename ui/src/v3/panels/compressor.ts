// The compressor panel's maths: Tracktion's CompressorPlugin, exactly.
//
// Static curve (tracktion_Compressor.cpp:137-143, research key "compressor"): the knee is
// in LINEAR AMPLITUDE, not in dB. With T the threshold gain and rho the stored slope (1/N),
// a detector level L above T comes out at T + rho·(L − T), then the makeup gain applies
// (always, below the threshold too). So the labelled N:1 holds only AT the knee, and the
// gain reduction is bounded: it tends to 20·log10(1/rho) (2:1 → 6.02 dB) however hard the
// input. A textbook dB-domain line would overstate it (-24 dB, 2.5:1 at -6 dBFS: 6.5 dB, not
// 10.8 dB), so the panel draws this curve and nothing else.
//
// Pure functions only: the panel and the tests share them.
import type { DynamicsMeter, Plugin, PluginMeterReading } from "../../types";
import { clamp, fmtRatio, param, physOf, ratioNorm, ratioOf, thresholdDb, thresholdNorm, type Range } from "./params";

/** Physical ranges the engine publishes for params 2-5 (MoshOps pluginParameterPhysicalRange);
 *  the fallback for a session or mock that omits them. Threshold and ratio carry none. */
export const ATTACK: Range = { min: 0.3, max: 200 };
export const RELEASE: Range = { min: 10, max: 300 };
export const MAKEUP: Range = { min: -10, max: 24 };
export const SIDECHAIN: Range = { min: -24, max: 24 };
/** The threshold's reach in dB: its linear gain runs 0.01..1. */
export const THR_MIN_DB = -40;
export const THR_MAX_DB = 0;
/** Tracktion's defaults (tracktion_Compressor.cpp:16-45). */
export const DEFAULTS = { thrDb: -6, ratio: 2, attackMs: 100, releaseMs: 100, makeupDb: 0, sidechainDb: 0 } as const;

export type CompSettings = {
  thrDb: number;
  /** The threshold as a linear gain, 0.01..1. */
  thrLin: number;
  /** The stored slope: 1/N, 0 for ∞:1. */
  rho: number;
  /** N in N:1 (Infinity for ∞:1). */
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  sidechainDb: number;
};

/** Every compressor setting in physical units, read from the snapshot's params. */
export function compSettings(plugin: Plugin): CompSettings {
  const thrDb = thresholdDb(param(plugin, 0)?.value ?? thresholdNorm(DEFAULTS.thrDb));
  const ratio = ratioOf(param(plugin, 1)?.value ?? ratioNorm(DEFAULTS.ratio));
  return {
    thrDb,
    thrLin: 10 ** (thrDb / 20),
    rho: Number.isFinite(ratio) ? 1 / ratio : 0,
    ratio,
    attackMs: physOf(param(plugin, 2), ATTACK),
    releaseMs: physOf(param(plugin, 3), RELEASE),
    makeupDb: physOf(param(plugin, 4), MAKEUP),
    sidechainDb: physOf(param(plugin, 5), SIDECHAIN),
  };
}

/** The steady-state output (dBFS) for a detector level `xDb`: the linear-amplitude knee,
 *  then the makeup gain. */
export function compOutDb(xDb: number, s: Pick<CompSettings, "thrLin" | "rho" | "makeupDb">): number {
  const L = 10 ** (xDb / 20);
  const y = L <= s.thrLin ? L : s.thrLin + s.rho * (L - s.thrLin);
  return 20 * Math.log10(Math.max(y, 1e-12)) + s.makeupDb;
}

/** Gain reduction (dB, ≥ 0) at detector level `xDb`, relative to the makeup gain. */
export function compGrDb(xDb: number, thrLin: number, rho: number): number {
  const L = 10 ** (xDb / 20);
  if (L <= thrLin) return 0;
  return 20 * Math.log10(L / (thrLin + rho * (L - thrLin)));
}

/** The most this compressor can ever reduce: 20·log10(1/rho) (∞ for ∞:1). */
export const grBoundDb = (rho: number): number => (rho > 0 ? 20 * Math.log10(1 / rho) : Infinity);

/** The reduction a full-scale (0 dBFS) detector level gets. */
export const grAtFullScaleDb = (thrLin: number, rho: number): number => -20 * Math.log10(thrLin + rho * (1 - thrLin));

const GAUGE_SCALES = [6, 12, 24, 48] as const;
/** The gauge's full-scale reduction: the smallest of 6/12/24/48 dB that holds what a
 *  full-scale input would get, so a gentle setting still moves the needle visibly. */
export function grScale(thrLin: number, rho: number): number {
  const fs = grAtFullScaleDb(thrLin, rho);
  return GAUGE_SCALES.find((s) => fs <= s) ?? 48;
}

/** Half the gauge's sweep (degrees): a ±50° meter face, so the needle at rest leans right
 *  like a VU needle instead of lying flat along the baseline. */
export const GAUGE_HALF_SWEEP = 50;
/** The gauge needle's angle (degrees clockwise from 12 o'clock): 0 dB of reduction points
 *  right (+50°), the full scale points left (-50°). */
export const gaugeAngle = (grDb: number, scale: number): number =>
  GAUGE_HALF_SWEEP - 2 * GAUGE_HALF_SWEEP * clamp(Number.isFinite(grDb) ? grDb / scale : 0, 0, 1);

/** A point on a circle at a gauge angle. */
export function gaugePoint(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** The ratio dial's position: right means HARDER, though the stored value runs the other
 *  way (higher stores compress less). Position = 1 − stored, which is exact and linear in
 *  1/N: 0 → 1.05:1, 0.47 → 2:1, 0.74 → 4:1, 1 → ∞:1. */
export const ratioDialPos = (norm: number): number => 1 - clamp(norm, 0, 1);
export const ratioNormFromDial = (pos: number): number => 1 - clamp(pos, 0, 1);

/** The x samples the curve is drawn through: evenly spaced, plus the knee itself so the
 *  corner is drawn exactly where it is. */
export function curveSamples(lo: number, hi: number, n: number, kneeDb: number): number[] {
  const xs = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  if (kneeDb > lo && kneeDb < hi) xs.push(kneeDb);
  return xs.sort((a, b) => a - b);
}

/** The plot's input (detector level) axis, dB. */
export const X_LO = -48, X_HI = 0;

/** The plot's output range: the input's -48..0 dB span, lifted in 6 dB steps when the
 *  makeup pushes the curve above 0 dBFS, and extended down in 6 dB steps when a negative
 *  makeup pushes its low end under -48 dB, so the whole curve stays on the plot (no false
 *  floor along the bottom edge). */
export function outRange(makeupDb: number): { lo: number; hi: number } {
  const hi = makeupDb > 0 ? 6 * Math.ceil(makeupDb / 6 - 1e-9) : 0;
  const lo = Math.min(hi - 48, 6 * Math.floor((X_LO + makeupDb) / 6 + 1e-9));
  return { lo, hi };
}

/** The unity line (out = in) clipped to what the plot shows: its ends in dB, or null when
 *  it misses the plot. A positive makeup lifts the output range above the input's, so the
 *  line enters the plot partway along. */
export function unitySpan(yLo: number, yHi: number): [number, number] | null {
  const a = Math.max(X_LO, yLo), b = Math.min(X_HI, yHi);
  return a < b ? [a, b] : null;
}

/** A live frame for this plugin, or undefined when the frame is missing or belongs to
 *  another plugin type (a reorder moves what sits at an index). */
export function dynamicsFrame(m: PluginMeterReading | undefined, type: string): DynamicsMeter | undefined {
  if (!m || m.type !== type || !("grDb" in m)) return undefined;
  return Number.isFinite(m.grDb) ? m : undefined;
}

// ── read-outs ──────────────────────────────────────────────────────────────────────────

/** "-24 dB", "-5.9 dB", "+3 dB": tenths, without a trailing ".0". */
export function shortDb(db: number): string {
  const r = Math.round(db * 10) / 10;
  const v = Object.is(r, -0) ? 0 : r;
  const txt = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${v > 0 ? "+" : ""}${txt} dB`;
}

/** "0.3", "4.5", "20", "150": a time without its unit. */
export const msNum = (ms: number): string => (ms < 10 ? (Math.round(ms * 10) / 10).toString() : String(Math.round(ms)));

/** The minimized row's summary budget. Its slot measures 97 px at the 320 px inspector,
 *  and 10 px mono is about 6.04 px a character: 16 fit whole. */
export const SUMMARY_CHARS = 16;

/** The minimized line: the ratio at the threshold, "2.5:1 at -24 dB" (at most
 *  SUMMARY_CHARS: the slot shows no more). A long ratio with a fractional threshold
 *  ("1.1:1 at -18.3 dB") drops the "at" rather than lose a figure. Times and makeup are
 *  one click away in the panel. */
export function compSummary(plugin: Plugin): string {
  const s = compSettings(plugin);
  const full = `${fmtRatio(s.ratio)} at ${shortDb(s.thrDb)}`;
  return full.length <= SUMMARY_CHARS ? full : `${fmtRatio(s.ratio)} ${shortDb(s.thrDb)}`;
}

/** A measured sample peak: "-45.5 dBFS". */
export const fmtPeak = (db: number): string => `${(Math.round(db * 10) / 10 || 0).toFixed(1)} dBFS`;

/** The threshold read-out under the plot: "-24.0 dB". */
export const fmtThr = (db: number): string => `${(Math.round(db * 10) / 10 || 0).toFixed(1)} dB`;

/** Gain reduction as the gauge prints it: "-3.1 dB", "0.0 dB". */
export const fmtGr = (grDb: number): string => (grDb < 0.05 ? "0.0 dB" : `-${grDb.toFixed(1)} dB`);
