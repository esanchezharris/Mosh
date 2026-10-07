// The 4-band EQ's view model (Tracktion EqualiserPlugin, type "4bandEq"). Pure, so every
// number the panel draws or sends is unit-tested (eq.test.ts).
//
// Engine facts (research 2026-10-05, tracktion_Equaliser.cpp / .h):
// - four RBJ biquads in series: low shelf (params 0-2), peak 1 (3-5), peak 2 (6-8), high
//   shelf (9-11); each band is [freq, gain, Q] (.cpp:71-85, 200-233, 282-290);
// - every parameter maps LINEARLY from its normalised value: Hz 20..20000, dB -20..20,
//   Q 0.1..4 (tracktion_Equaliser.h:44-49);
// - a band whose gain is exactly 0 dB is not processed at all (.cpp:286-289), so its
//   frequency and Q do nothing (the curve agrees: at 0 dB the filter is unity anyway);
// - the "Low-pass"/"High-pass" xml tags are SHELVES, not pass filters.
import type { Plugin } from "../../types";
import { biquadDb, highShelf, logFreqs, lowShelf, peak, plotTopHz, type Biquad } from "./dsp";
import { clamp, fmtDb, fmtFreq, fmtHz, normOf, param, physOf, type Range } from "./params";
import { freqScale, linScale, type Scale } from "./plot";

export const FREQ: Range = { min: 20, max: 20000 };
export const GAIN: Range = { min: -20, max: 20 };
export const Q: Range = { min: 0.1, max: 4 };

export type BandKind = "lowShelf" | "peak" | "highShelf";
export type BandField = "freq" | "gain" | "q";

export type BandSpec = {
  kind: BandKind;
  /** The node's letter on the plot. */
  label: string;
  /** Spoken / tooltip name. */
  name: string;
  /** The word the minimized summary uses for a shelf ("low"/"high"); peaks use their frequency. */
  short?: string;
  /** Parameter indices for [freq, gain, Q]. */
  index: Record<BandField, number>;
  /** The engine's reset values (.cpp:89-103). */
  defaults: { freq: number; gain: number; q: number };
};

const band = (kind: BandKind, label: string, name: string, first: number, freq: number, short?: string): BandSpec => ({
  kind, label, name, short,
  index: { freq: first, gain: first + 1, q: first + 2 },
  defaults: { freq, gain: 0, q: 0.5 },
});

export const BANDS: readonly BandSpec[] = [
  band("lowShelf", "L", "Low shelf", 0, 80, "low"),
  band("peak", "1", "Peak 1", 3, 3000),
  band("peak", "2", "Peak 2", 6, 5000),
  band("highShelf", "H", "High shelf", 9, 17000, "high"),
];

export type BandValues = { freq: number; gain: number; q: number };

export const RANGES: Record<BandField, Range> = { freq: FREQ, gain: GAIN, q: Q };

/** The four bands in physical units, read from the snapshot. */
export function readBands(plugin: Plugin): BandValues[] {
  return BANDS.map((b) => ({
    freq: physOf(param(plugin, b.index.freq), FREQ),
    gain: physOf(param(plugin, b.index.gain), GAIN),
    q: physOf(param(plugin, b.index.q), Q),
  }));
}

/** The engine skips a band at exactly 0 dB. A tolerance far below anything audible absorbs
 *  float noise from the normalised round trip. */
export const isBandOff = (gainDb: number): boolean => Math.abs(gainDb) < 1e-4;

/** The band's JUCE biquad, or null when the engine skips it. */
export function bandBiquad(spec: BandSpec, v: BandValues, fs: number): Biquad | null {
  if (isBandOff(v.gain)) return null;
  if (spec.kind === "lowShelf") return lowShelf(fs, v.freq, v.q, v.gain);
  if (spec.kind === "highShelf") return highShelf(fs, v.freq, v.q, v.gain);
  return peak(fs, v.freq, v.q, v.gain);
}

/** The composite response (dB) at f: the four biquads in series, as the engine runs them. */
export function responseDb(bands: readonly BandValues[], f: number, fs: number): number {
  let sum = 0;
  BANDS.forEach((spec, i) => {
    const c = bandBiquad(spec, bands[i], fs);
    if (c) sum += biquadDb(c, f, fs);
  });
  return sum;
}

/** A sampler for the composite curve: biquads computed once, evaluated per frequency. */
export function responseFn(bands: readonly BandValues[], fs: number, only?: number): (f: number) => number {
  const chain = BANDS.map((spec, i) => (only === undefined || only === i ? bandBiquad(spec, bands[i], fs) : null))
    .filter((c): c is Biquad => c !== null);
  return (f) => chain.reduce((s, c) => s + biquadDb(c, f, fs), 0);
}

/** The frequencies a curve is sampled at: `n` log-spaced points across the plot, plus the
 *  exact centre frequency of every active band (of band `only`, when given). An RBJ peak's
 *  digital maximum sits exactly at w0, so with f0 in the grid the drawn curve reaches every
 *  peak node however narrow the peak or coarse the grid (the 44 px thumbnail included). */
export function curveFreqs(bands: readonly BandValues[], top: number, n: number, only?: number): number[] {
  const out = logFreqs(Math.max(2, Math.round(n)), FREQ.min, top);
  bands.forEach((v, i) => {
    if (i >= BANDS.length || (only !== undefined && only !== i) || isBandOff(v.gain)) return;
    if (v.freq > FREQ.min && v.freq < top) out.push(v.freq);
  });
  return out.sort((a, b) => a - b);
}

/** The plot's dB half-ranges, smallest first. */
export const RANGE_STEPS = [12, 20, 40] as const;

/** The largest |composite dB| on the curve's own sample grid (the plot width, plus band f0s). */
export function maxAbsDb(bands: readonly BandValues[], fs: number): number {
  const fn = responseFn(bands, fs);
  return curveFreqs(bands, plotTopHz(fs), PLOT_W).reduce((m, f) => Math.max(m, Math.abs(fn(f))), 0);
}

/** The plot's dB half-range: the smallest step that holds the COMPOSITE response (a resonant
 *  shelf overshoots its own gain, and stacked bands add), so the curve is never flattened
 *  against the plot edge while a larger step would show it. Past ±40 it clips, and the panel
 *  says so. */
export function dbRange(bands: readonly BandValues[], fs: number): number {
  const m = maxAbsDb(bands, fs);
  return RANGE_STEPS.find((s) => m <= s + 1e-6) ?? RANGE_STEPS[RANGE_STEPS.length - 1];
}

// ── plot geometry ───────────────────────────────────────────────────────────────────────

/** The plot's coordinate width is the width it is drawn at: the 320 px inspector's 289 px row,
 *  less 2 × 7 px padding and 2 px of border = 273 px. One unit is one CSS pixel, so the 9 px
 *  axis text and the node letters render at their stated size. */
export const PLOT_W = 273;
export const PLOT_H = 84;
/** Vertical inset so a node at ±range is not cut by the card edge. */
export const PLOT_PAD = 6;

export type Geometry = { x: Scale; y: Scale; top: number; range: number; w: number; h: number };

/** The plot's scales: log 20 Hz..min(20k, just under fs/2) across, ±range dB down. */
export function geometry(fs: number, range: number, w = PLOT_W, h = PLOT_H, pad = PLOT_PAD): Geometry {
  const top = plotTopHz(fs);
  const inner = linScale(-range, range, h - 2 * pad);
  return {
    x: freqScale(FREQ.min, top, w),
    y: { to: (db) => pad + inner.to(db), from: (py) => inner.from(py - pad) },
    top, range, w, h,
  };
}

/** Where a band's node sits (clamped to the plot so a 20 kHz shelf at a low rate, or a
 *  gain past the frozen drag range, stays on screen). */
export function nodePos(v: BandValues, g: Geometry): { x: number; y: number } {
  return {
    x: clamp(g.x.to(v.freq), 0, g.w),
    y: clamp(g.y.to(v.gain), PLOT_PAD, g.h - PLOT_PAD),
  };
}

/** The composite curve's path (and, with `only`, one band's own curve), about one point per
 *  pixel by default (research: "about 1 point per px"), plus every active band's f0. */
export function curveD(bands: readonly BandValues[], fs: number, g: Geometry, n = g.w, only?: number): string {
  const fn = responseFn(bands, fs, only);
  return curveFreqs(bands, g.top, n, only).map((f, i) => {
    const px = g.x.to(f), py = clamp(g.y.to(fn(f)), 0, g.h);
    return `${i === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)}`;
  }).join(" ");
}

// ── input maths ─────────────────────────────────────────────────────────────────────────

/** Rounds what a drag produces to the precision the read-out shows (whole Hz, 0.1 dB, 0.01 Q),
 *  and lets a gain within 0.15 dB of zero land ON zero, so "off" is reachable by hand. */
export const roundFreq = (hz: number): number => clamp(Math.round(hz), FREQ.min, FREQ.max);
export function roundGain(db: number): number {
  const c = clamp(db, GAIN.min, GAIN.max);
  if (Math.abs(c) < 0.15) return 0;
  return Math.round(c * 10) / 10;
}
export const roundQ = (q: number): number => clamp(Math.round(q * 100) / 100, Q.min, Q.max);

/** A node drag: the point (in plot coordinates, already offset by where the node was
 *  grabbed) becomes a frequency on the log axis and a gain on the dB axis. */
export function dragTarget(pt: { x: number; y: number }, g: Geometry): { freq: number; gain: number } {
  return { freq: roundFreq(g.x.from(clamp(pt.x, 0, g.w))), gain: roundGain(g.y.from(pt.y)) };
}

/** Alt-drag on a node: Q follows vertical movement on a log scale, one octave of Q per
 *  48 px (up narrows). */
export const Q_PX_PER_OCTAVE = 48;
export const qFromDrag = (q0: number, dyUp: number): number => roundQ(q0 * 2 ** (dyUp / Q_PX_PER_OCTAVE));

/** A discrete Q step of `octaves`. Below Q 0.18 a fine step (1/24 octave) is smaller than
 *  the 0.01 grid and would round back to where it started; then it moves one grid unit, so
 *  every key press does something until the range end. */
export function stepQ(v: number, octaves: number): number {
  const cur = roundQ(v);
  const next = roundQ(v * 2 ** octaves);
  if (next !== cur || octaves === 0) return next;
  return roundQ(cur + Math.sign(octaves) * 0.01);
}

/** Wheel on a node: Q moves in proportion to how far the wheel travelled, one octave per
 *  600 px (a sixth of an octave per 100 px, about one mouse notch; Shift: a quarter of that),
 *  so a trackpad's stream of small deltas moves Q smoothly instead of a step per event. */
export const WHEEL_PX_PER_OCTAVE = 600;
const LINE_PX = 16;

/** The octaves of Q one wheel event asks for (positive narrows). Wheel up (negative delta)
 *  narrows. `deltaMode` 1 is lines, 2 is pages (`pagePx` tall). On macOS a Shift+wheel mouse
 *  arrives as deltaX with deltaY 0, so the caller passes deltaX then. */
export function wheelOctaves(delta: number, deltaMode: number, pagePx: number, fine: boolean): number {
  const px = delta * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? pagePx : 1);
  return -px / WHEEL_PX_PER_OCTAVE / (fine ? 4 : 1);
}

/** Q after a wheel gesture that has accumulated `octaves` from `q0`, and the octaves clamped
 *  so that scrolling past a range end does not have to be unwound before Q moves back. */
export function wheelQ(q0: number, octaves: number): { q: number; octaves: number } {
  const lo = Math.log2(Q.min / q0), hi = Math.log2(Q.max / q0);
  const o = clamp(octaves, Math.min(lo, hi), Math.max(lo, hi));
  return { q: roundQ(q0 * 2 ** o), octaves: o };
}

export type StepKind = "small" | "fine" | "page" | "home" | "end";

/** A key step for one field. Frequency moves in semitones (fine: quarter-semitones, page:
 *  octaves), gain in 0.5 dB (fine 0.1, page 3), Q in sixth-octaves (fine 1/24, page ×2). */
export function stepField(field: BandField, v: number, dir: 1 | -1, kind: StepKind): number {
  const r = RANGES[field];
  if (kind === "home") return r.min;
  if (kind === "end") return r.max;
  if (field === "gain") {
    const d = kind === "fine" ? 0.1 : kind === "page" ? 3 : 0.5;
    return clamp(Math.round((v + dir * d) * 100) / 100, r.min, r.max);
  }
  const oct = field === "freq"
    ? (kind === "fine" ? 1 / 48 : kind === "page" ? 1 : 1 / 12)
    : (kind === "fine" ? 1 / 24 : kind === "page" ? 1 : 1 / 6);
  if (field === "q") return stepQ(v, dir * oct);
  return clamp(Math.round(v * 2 ** (dir * oct) * 10) / 10, r.min, r.max);
}

/** A scrub drag on a read-out field: position space is log for freq and Q, linear for gain,
 *  and `dyUp` px moves `dyUp / span` of the whole range. */
export function scrubField(field: BandField, v0: number, dyUp: number, span: number): number {
  const r = RANGES[field];
  if (field === "gain") return roundGain(v0 + (dyUp / span) * (r.max - r.min));
  const k = Math.log(r.max / r.min);
  const next = v0 * Math.exp((dyUp / span) * k);
  return field === "freq" ? roundFreq(next) : roundQ(next);
}

/** The units each field accepts when typed; anything else is refused rather than guessed. */
const FIELD_UNITS: Record<BandField, readonly string[]> = { freq: ["hz", "k", "khz"], gain: ["db"], q: [] };

/** Parses a typed value: "3k", "3.2 kHz", "12,000", "800", "-3", "+2.5 dB", "2,5", "0.7".
 *  A comma before exactly three digits is a thousands separator, otherwise a decimal comma.
 *  A unit that does not belong to the field ("-3 dB" as a frequency) gives NaN. */
export function parseField(field: BandField, text: string): number {
  const t = text.trim().toLowerCase().replace(/,(?=\d{3}(?!\d))/g, "").replace(/,/g, ".");
  const m = t.match(/^([+-]?\d*\.?\d+)\s*([a-z]*)$/);
  if (!m) return NaN;
  const unit = m[2];
  if (unit && !FIELD_UNITS[field].includes(unit)) return NaN;
  let v = Number(m[1]);
  if (unit === "k" || unit === "khz") v *= 1000;
  if (!Number.isFinite(v)) return NaN;
  const r = RANGES[field];
  return clamp(v, r.min, r.max);
}

// ── what gets sent ──────────────────────────────────────────────────────────────────────

export type BandEdit = { band: number } & Partial<BandValues>;

/** The (paramIndex, normalised value) pairs set_plugin_param receives for an edit, in
 *  freq, gain, Q order. Normalisation goes through params.ts (linear, the engine's range
 *  when published). */
export function editToParams(plugin: Plugin, edit: BandEdit): { paramIndex: number; norm: number }[] {
  const spec = BANDS[edit.band];
  if (!spec) return [];
  const out: { paramIndex: number; norm: number }[] = [];
  for (const field of ["freq", "gain", "q"] as const) {
    const v = edit[field];
    if (v === undefined || !Number.isFinite(v)) continue;
    const i = spec.index[field];
    out.push({ paramIndex: i, norm: normOf(param(plugin, i), v, RANGES[field]) });
  }
  return out;
}

/** The fields of `edit` that would actually change the parameter, compared, in normalised
 *  terms, with `base` (the value last sent in this burst, or the snapshot). A key at a range
 *  end, or a reset of a band already at its defaults, sends nothing (each send would be an
 *  empty undo step). */
export function changedFields(plugin: Plugin, edit: BandEdit, base: (field: BandField) => number): BandEdit | null {
  const spec = BANDS[edit.band];
  if (!spec) return null;
  const out: BandEdit = { band: edit.band };
  let any = false;
  for (const field of ["freq", "gain", "q"] as const) {
    const v = edit[field];
    if (v === undefined || !Number.isFinite(v)) continue;
    const p = param(plugin, spec.index[field]);
    if (Math.abs(normOf(p, v, RANGES[field]) - normOf(p, base(field), RANGES[field])) < 1e-6) continue;
    out[field] = v;
    any = true;
  }
  return any ? out : null;
}

/** Applies an in-flight edit over the snapshot's bands (for drawing while dragging). */
export function withEdit(bands: readonly BandValues[], edit: BandEdit | null): BandValues[] {
  if (!edit || !bands[edit.band]) return bands.slice();
  return bands.map((b, i) => (i === edit.band ? {
    freq: edit.freq ?? b.freq, gain: edit.gain ?? b.gain, q: edit.q ?? b.q,
  } : b));
}

// ── text ────────────────────────────────────────────────────────────────────────────────

export const fmtQ = (q: number): string => (Number.isFinite(q) ? q.toFixed(2) : "–");

/** What the type-in box starts with: the value without its unit ("80", "3.00k", "-2.5", "0.71"). */
export function editText(field: BandField, v: number): string {
  if (field === "freq") return v < 1000 ? `${Math.round(v)}` : `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}k`;
  return field === "gain" ? v.toFixed(1) : v.toFixed(2);
}

/** The longest summary the minimized header is given. Measured at the 320 px inspector, the
 *  text slot is 97 px (row 289 px: chevron 16, name 76, thumbnail 44 + 6 gap, on/off LED 16,
 *  gaps and padding), and 10 px monospace is 6.0 px a character: 16 characters fit whole.
 *  Whatever does not fit must be the least informative part, hence the ordering in eqSummary. */
export const SUMMARY_CHARS = 16;

/** "+3", "-2.5", "+0.4": a gain without its unit, ".0" dropped. `whole` rounds to whole dB
 *  (but never to a misleading "0"). */
function gainShort(db: number, whole: boolean): string {
  let r = Math.round(db * 10) / 10;
  if (whole && Math.abs(r) >= 1) r = Math.round(r);
  return `${r > 0 ? "+" : ""}${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}`;
}

/** fmtHz, except that 9950..9999 Hz reads "10k" like 10 kHz does (fmtHz rounds it up to
 *  "10.0k", a character longer than any other frequency it gives). */
const hzShort = (hz: number): string => (hz >= 9950 && hz < 10000 ? "10k" : fmtHz(hz));

/** What the minimized header says: only the bands that are doing something, biggest move
 *  first (ties in band order), or "flat". The first form that fits SUMMARY_CHARS wins:
 *  "low -3.0 dB", then "low -3 dB · high +3 dB", then without the dB ("low -3 · high +3"),
 *  then with tight separators and bare peak numbers ("low -3·3.0k +2.5"), then in whole dB;
 *  bands that still do not fit are counted, not shown ("low -3 · 2 more"). */
export function eqSummary(plugin: Plugin): string {
  const active = readBands(plugin)
    .flatMap((v, i) => (isBandOff(v.gain) ? [] : [{ v, spec: BANDS[i], i }]))
    // Compared at the 0.1 dB the text shows, so float noise never reorders equal moves.
    .sort((a, b) => Math.round(Math.abs(b.v.gain) * 10) - Math.round(Math.abs(a.v.gain) * 10) || a.i - b.i);
  if (!active.length) return "flat";
  const name = (v: BandValues, spec: BandSpec, bare: boolean) =>
    spec.short ?? (bare && v.freq < 1000 ? `${Math.round(v.freq)}` : hzShort(v.freq));
  const parts = (gain: (db: number) => string, bare = false) => active.map(({ v, spec }) => `${name(v, spec, bare)} ${gain(v.gain)}`);
  const forms = [
    parts(fmtDb).join(" · "),
    parts((db) => `${gainShort(db, false)} dB`).join(" · "),
    parts((db) => gainShort(db, false)).join(" · "),
    parts((db) => gainShort(db, false), true).join("·"),
    parts((db) => gainShort(db, true), true).join("·"),
  ];
  const fit = forms.find((t) => t.length <= SUMMARY_CHARS);
  if (fit) return fit;
  const whole = parts((db) => gainShort(db, true), true);
  for (let keep = whole.length - 1; keep >= 1; keep--) {
    const t = `${whole.slice(0, keep).join("·")} · ${whole.length - keep} more`;
    if (t.length <= SUMMARY_CHARS) return t;
  }
  // The longest single part is 9 characters ("high -0.4"), so this (at most 16) always fits.
  return `${whole[0]}·${whole.length - 1} more`;
}

/** What a screen reader hears for a band's node. */
export function bandValueText(v: BandValues): string {
  const off = isBandOff(v.gain) ? ", off (at 0 dB the engine skips this band)" : "";
  return `${fmtFreq(v.freq)}, ${fmtDb(v.gain)}, Q ${fmtQ(v.q)}${off}`;
}
