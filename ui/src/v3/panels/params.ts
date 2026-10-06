// Reading and writing native plugin parameters in physical units.
//
// The snapshot carries each parameter's normalised 0-1 value; every Tracktion and Mosh
// built-in maps it LINEARLY onto its physical range (no skew), so
// physical = min + value·(max − min). The engine publishes min/max for most parameters;
// a panel passes the documented range as the fallback for the ones it does not (and for
// mock or older sessions).
import type { Plugin, PluginParam, PluginStateValue } from "../../types";

export type Range = { min: number; max: number };

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const param = (plugin: Plugin, index: number): PluginParam | undefined =>
  plugin.params.find((p) => p.index === index);

function rangeOf(p: PluginParam | undefined, fallback: Range): Range {
  const min = typeof p?.min === "number" ? p.min : fallback.min;
  const max = typeof p?.max === "number" ? p.max : fallback.max;
  return max > min ? { min, max } : fallback;
}

/** The parameter's value in physical units. */
export function physOf(p: PluginParam | undefined, fallback: Range): number {
  const r = rangeOf(p, fallback);
  return r.min + clamp01(p?.value ?? 0) * (r.max - r.min);
}

/** The normalised value set_plugin_param takes for a physical value (clamped to the range). */
export function normOf(p: PluginParam | undefined, phys: number, fallback: Range): number {
  const r = rangeOf(p, fallback);
  return clamp01((phys - r.min) / (r.max - r.min));
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
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  if (hz < 10000) return `${(Math.round(hz / 100) / 10).toFixed(1)}k`;
  return `${Math.round(hz / 1000)}k`;
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
