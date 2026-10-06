// Low-pass / high-pass: the view maths, pure so it is unit-tested.
//
// Both Mosh types are ONE Tracktion class (te::LowPassPlugin): a single 2nd-order
// Butterworth biquad (JUCE IIRCoefficients::makeLowPass / makeHighPass, the 2-argument
// makers, Q = 1/√2), 12 dB/oct, -3.01 dB at the cutoff. Its one parameter, Frequency, is
// LINEAR on 10..22000 Hz (hz = 10 + v·21990), so a log control must convert through
// params.ts and never step the normalised value directly (one 0.01 step is ~220 Hz).
// The mode lives in plugin.state.mode and is mirrored by plugin.type.
import type { Plugin } from "../../types";
import { biquadDb, highPass, lowPass, plotTopHz } from "./dsp";
import { clamp, fmtHz, normOf, param, physOf, type Range } from "./params";
import { freqScale, linScale } from "./plot";

export type FilterMode = "lowpass" | "highpass";

/** The Frequency parameter's physical range (tracktion_LowPass.cpp:21). */
export const CUTOFF_RANGE: Range = { min: 10, max: 22000 };
/** The only parameter. */
export const CUTOFF_PARAM = 0;
/** The slope and Q are fixed in the engine: nothing to read or set. */
export const FILTER_FACTS = "12 dB/oct";

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

/** What a reset returns to: the engine's default for a low-pass (4 kHz), and the value
 *  load_builtin gives a high-pass (180 Hz). The engine's own getDefaultValue() says 4 kHz
 *  for both, which is wrong for a high-pass. */
/** Whether this engine can switch LP/HP: only one that publishes `state.mode` takes
 *  set_plugin_state (an older engine answers "unknown command"). */
export const canSetMode = (plugin: Plugin): boolean => plugin.state?.mode !== undefined;

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

/** The filter's exact gain in dB at frequency f: the engine's JUCE biquad. The cutoff is
 *  clamped to just under Nyquist only as a numeric guard for drawing; the panel never
 *  draws a curve for an unstable cutoff (see isUnstable). */
export function responseDb(mode: FilterMode, fc: number, f: number, fs: number): number {
  const rate = fs > 0 ? fs : 48000;
  const c = Math.min(fc, rate * 0.499);
  return biquadDb(mode === "highpass" ? highPass(rate, c) : lowPass(rate, c), f, rate);
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
 *  LED (and the thumbnail goes flat), so it is not repeated here. */
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
