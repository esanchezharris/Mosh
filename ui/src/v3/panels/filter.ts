// Low-pass / high-pass: the view maths, pure so it is unit-tested.
//
// Both Mosh types are ONE Tracktion class (te::LowPassPlugin), shadowed by Mosh's subclass
// (MoshLowPassPlugin), which adds a slope: a Butterworth of order N = slope/6 (6..48 dB/oct,
// N = 1..8), run as the cascade dsp.ts butterworth() builds: biquads from JUCE's makers at
// the Butterworth Qs, plus one first-order section when N is odd. At 12 dB/oct it is exactly
// Tracktion's own single biquad (the 2-argument makers, Q = 1/√2). Every slope is -3.01 dB
// at the cutoff. The slope lives in plugin.state.slope; an older engine publishes none and
// runs the fixed 12 dB/oct. The one parameter, Frequency, is LINEAR on 10..22000 Hz
// (hz = 10 + v·21990), so a log control must convert through params.ts and never step the
// normalised value directly (one 0.01 step is ~220 Hz). The mode lives in
// plugin.state.mode and is mirrored by plugin.type.
import type { Plugin } from "../../types";
import { butterworth, chainDb, logFreqs, plotTopHz, type Biquad } from "./dsp";
import { clamp, fmtHz, normOf, param, physOf, type Range } from "./params";
import { freqScale, linScale } from "./plot";

export type FilterMode = "lowpass" | "highpass";

/** The Frequency parameter's physical range (tracktion_LowPass.cpp:21). */
export const CUTOFF_RANGE: Range = { min: 10, max: 22000 };
/** The only parameter. */
export const CUTOFF_PARAM = 0;

/** The slope setting (contract §1a): 6..48 dB/oct in steps of 6, one Butterworth order per
 *  step. 12 is Tracktion's own filter, and what an engine without the setting runs. */
export const SLOPE_RANGE = { min: 6, max: 48, step: 6 } as const;
export const DEFAULT_SLOPE = 12;

/** "24 dB/oct". */
export const slopeLabel = (slope: number): string => `${slope} dB/oct`;

/** A slope snapped onto the 6 dB/oct grid and clamped to 6..48 (the engine's own coerce:
 *  25 → 24, 27 → 30, 0 → 6, 100 → 48). Not a number: the default. */
export function snapSlope(slope: number): number {
  if (!Number.isFinite(slope)) return DEFAULT_SLOPE;
  const { min, max, step } = SLOPE_RANGE;
  return clamp(min + step * Math.floor((slope - min) / step + 0.5), min, max);
}

/** Whether this engine has the slope setting: only one that publishes `state.slope` takes
 *  set_plugin_state "slope". Without it the filter is the fixed 12 dB/oct. */
export const canSetSlope = (plugin: Plugin): boolean => plugin.state?.slope !== undefined;

/** The slope the engine runs, in dB/oct: `state.slope` when present, else 12. */
export function slopeOf(plugin: Plugin): number {
  const v = plugin.state?.slope?.value;
  return typeof v === "number" ? snapSlope(v) : DEFAULT_SLOPE;
}

/** The Butterworth order a slope runs at (1..8). */
export const orderOf = (slope: number): number => snapSlope(slope) / SLOPE_RANGE.step;

/** Where a key on the slope stepper goes: arrows one step (6 dB/oct), Home/End the ends.
 *  Null for a key that is not the stepper's. */
export function slopeKeyTarget(key: string, slope: number): number | null {
  const { min, max, step } = SLOPE_RANGE;
  switch (key) {
    case "ArrowUp": case "ArrowRight": return snapSlope(slope + step);
    case "ArrowDown": case "ArrowLeft": return snapSlope(slope - step);
    case "Home": return min;
    case "End": return max;
    default: return null;
  }
}

/** The plot's dB window: +6 at the top, -36 at the bottom. */
export const DB_TOP = 6, DB_BOTTOM = -36;
/** The plot's viewBox size, equal to its drawn size at the 320 px inspector (the 289 px row
 *  less 2 × 7 px padding and 2 px of border = 273 px), so its 9 px axis text renders at 9 px. */
export const PLOT_W = 273, PLOT_H = 54;
export const PLOT_LO_HZ = 20;

/** LP or HP: the `mode` setting when present, else what `type` says (an older engine
 *  publishes no `state`, and its `type` is still right). */
export function filterMode(plugin: Plugin): FilterMode {
  const v = plugin.state?.mode?.value;
  if (v === "lowpass" || v === "highpass") return v;
  return plugin.type === "highpass" ? "highpass" : "lowpass";
}

/** Whether this engine can switch LP/HP: only one that publishes `state.mode` takes
 *  set_plugin_state (an older engine answers "unknown command"). */
export const canSetMode = (plugin: Plugin): boolean => plugin.state?.mode !== undefined;

/** What a reset returns to: the engine's default for a low-pass (4 kHz), and the value
 *  load_builtin gives a high-pass (180 Hz). The engine's own getDefaultValue() says 4 kHz
 *  for both, which is wrong for a high-pass. */
export const defaultCutoff = (mode: FilterMode): number => (mode === "highpass" ? 180 : 4000);

/** The highest cutoff the UI sends: 22 kHz, but never at or above Nyquist (JUCE asserts
 *  fc <= fs/2 and tan() wraps past it; at 44.1/48 kHz this stays 22 kHz). */
export const maxCutoff = (fs: number): number => Math.min(CUTOFF_RANGE.max, (fs > 0 ? fs : 48000) * 0.499);

export const clampCutoff = (hz: number, fs: number): number =>
  clamp(Number.isFinite(hz) ? hz : CUTOFF_RANGE.min, CUTOFF_RANGE.min, maxCutoff(fs));

/** The cutoff the snapshot carries, in Hz. */
export const cutoffHz = (plugin: Plugin): number => physOf(param(plugin, CUTOFF_PARAM), CUTOFF_RANGE);

/** The normalised value set_plugin_param takes for a cutoff in Hz (clamped first). */
export const cutoffNorm = (plugin: Plugin, hz: number, fs: number): number =>
  normOf(param(plugin, CUTOFF_PARAM), clampCutoff(hz, fs), CUTOFF_RANGE);

/** `steps` twelfths of an octave up (or down) from `hz`, clamped to what can be sent. */
export const stepCutoff = (hz: number, steps: number, fs: number): number => clampCutoff(hz * 2 ** (steps / 12), fs);

/** True when the stored cutoff is above Nyquist at this rate. The engine does NOT clamp
 *  (LowPassPlugin::updateFilters passes the value straight to makeLowPass/makeHighPass):
 *  past fs/2, tan() turns negative, |a2| > 1, a pole leaves the unit circle and the filter
 *  diverges into the ±3.0 output clamp. A value saved at 48 kHz (22 kHz is legal there)
 *  replayed at 32 kHz lands here. There is no frequency response to draw for it. */
export const isUnstable = (fc: number, fs: number): boolean => fc > (fs > 0 ? fs : 48000) / 2;

/** The engine's filter sections at a cutoff, rate and slope: the Butterworth cascade of
 *  order slope/6 (at 12 dB/oct the one 2-argument-maker biquad Tracktion runs). The cutoff
 *  is clamped to just under Nyquist only as a numeric guard for drawing; the panel never
 *  draws a curve for an unstable cutoff (see isUnstable). Build it once per drawing and
 *  read it with dsp.ts chainDb. */
export function filterChain(mode: FilterMode, fc: number, fs: number, slope = DEFAULT_SLOPE): Biquad[] {
  const rate = fs > 0 ? fs : 48000;
  return butterworth(mode, rate, Math.min(fc, rate * 0.499), orderOf(slope));
}

/** The filter's exact gain in dB at frequency f: the sum of the engine's sections. */
export function responseDb(mode: FilterMode, fc: number, f: number, fs: number, slope = DEFAULT_SLOPE): number {
  return chainDb(filterChain(mode, fc, fs, slope), f, fs > 0 ? fs : 48000);
}

/** The same response in closed form, for checking the cascade: the bilinear-transformed
 *  Butterworth, |H|² = 1 / (1 + (T/Tc)^2N) for a low-pass (Tc/T for a high-pass), with
 *  T = tan(πf/fs). Exactly -10·log10(2) = -3.0103 dB at the cutoff for every order. */
export function closedFormDb(mode: FilterMode, fc: number, f: number, fs: number, slope = DEFAULT_SLOPE): number {
  const rate = fs > 0 ? fs : 48000;
  const T = Math.tan((Math.PI * f) / rate), Tc = Math.tan((Math.PI * Math.min(fc, rate * 0.499)) / rate);
  const r = mode === "highpass" ? Tc / T : T / Tc;
  return -10 * Math.log10(1 + r ** (2 * orderOf(slope)));
}

/** How far either side of the cutoff the curve is sampled densely, in octaves, and how
 *  finely (points per octave). Inside it the steepest slope (48 dB/oct falls 33 dB in the
 *  0.75 octave past the cutoff) moves about 2 dB between points, so the knee and the cliff
 *  have no corners; outside it any slope is gentle enough for the log grid. */
export const DENSE_OCTAVES = 1;
export const DENSE_PER_OCTAVE = 24;

/** The frequencies a curve is drawn through: `n` log-spaced points across the plot
 *  (20 Hz .. its top at this rate), with the stretch within DENSE_OCTAVES of the cutoff
 *  replaced by `perOctave` points per octave. Ascending, both plot ends included, the
 *  cutoff itself included when it is on the plot. */
export function curveFreqs(fc: number, fs: number, n = 96, perOctave = DENSE_PER_OCTAVE): number[] {
  const lo = PLOT_LO_HZ, top = plotTopHz(fs);
  const c = Number.isFinite(fc) && fc > 0 ? fc : lo;
  const wLo = c * 2 ** -DENSE_OCTAVES, wHi = c * 2 ** DENSE_OCTAVES;
  // The grid's interior points outside the window (its ends are added exactly below:
  // logFreqs' first point is exp(log 20), a hair under 20).
  const base = logFreqs(n, lo, top).slice(1, -1).filter((f) => f < wLo || f > wHi);
  // The window's points, none closer than half a step to a plot end (a sliver segment
  // there would only be a rounding error's worth of line).
  const k = Math.round(DENSE_OCTAVES * perOctave), half = 2 ** (0.5 / perOctave);
  const dense = Array.from({ length: 2 * k + 1 }, (_, i) => c * 2 ** ((i - k) / perOctave))
    .filter((f) => f > lo * half && f < top / half);
  const all = [lo, ...base, ...dense, top].sort((a, b) => a - b);
  // A dense point can land on a grid point: keep one of each.
  return all.filter((f, i) => i === 0 || f / all[i - 1] > 1 + 1e-9);
}

/** Reads what a person types for a cutoff: "180", "180 Hz", "1.2k", "1.2 kHz", "4,000". */
export function parseHz(text: string): number | null {
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?|[0-9]{1,3}(?:,[0-9]{3})+)\s*(k|khz|hz)?\s*$/i.exec(text);
  if (!m) return null;
  const raw = m[1];
  // "4,000" is a thousands separator; "1,5" is a decimal comma.
  const n = /^[0-9]{1,3}(,[0-9]{3})+$/.test(raw) ? Number(raw.replace(/,/g, "")) : Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return unit === "k" || unit === "khz" ? n * 1000 : n;
}

/** The minimized line, words not letters: the type, then the cutoff ("high-pass 180 Hz",
 *  "low-pass 4.0k"). At most 16 characters, inside the row's 17-character summary slot, so
 *  two Filter rows read apart without their thumbnails. Bypass is the header's own on/off
 *  LED (and the thumbnail goes flat), so it is not repeated here. The slope does not fit
 *  the slot ("high-pass 180 Hz" is already 16): the thumbnail beside it is drawn at the
 *  real slope, so a steep filter reads as a cliff there. */
export function filterSummary(plugin: Plugin): string {
  return `${filterMode(plugin) === "highpass" ? "high-pass" : "low-pass"} ${fmtHz(cutoffHz(plugin))}`;
}

/** The plot's axes at a sample rate: 20 Hz to min(20 kHz, just under Nyquist). */
export function plotScales(fs: number, w = PLOT_W, h = PLOT_H) {
  return { x: freqScale(PLOT_LO_HZ, plotTopHz(fs), w), y: linScale(DB_BOTTOM, DB_TOP, h), top: plotTopHz(fs) };
}

/** Where the handle sits horizontally: the cutoff on the plot's axis, kept inside it
 *  (the parameter reaches 10 Hz and 22 kHz, past both ends of the drawn range). */
export function handleX(fc: number, fs: number, w = PLOT_W): number {
  return clamp(plotScales(fs, w).x.to(fc), 0, w);
}

/** The cutoff a pointer at plot x asks for (the axis extends past its ends, then clamps). */
export const cutoffAtX = (x: number, fs: number, w = PLOT_W): number => clampCutoff(plotScales(fs, w).x.from(x), fs);
