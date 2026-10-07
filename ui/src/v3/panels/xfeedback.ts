// Mosh X-FDBK: the view maths for its panel, pure so it is unit-tested.
//
// The engine (src/plugins/moshfx/MoshXFeedbackDsp.cpp) scores 128 log-spaced bins between
// 250 Hz and min(0.48·fs, 10 kHz) for how tonal they are (|Goertzel|/N over the block RMS:
// a ratio, about 0..0.71 for a real sinusoid, not a level), keeps the ones above
// threshold = 0.06 + 0.36·(1 − Sensitivity), and, with Auto Suppress on, cuts each with a
// fixed Q = 30 RBJ notch blended by depth and Mix. Every parameter is linear.
import type { FeedbackMeter, Plugin, PluginMeterReading } from "../../types";
import { clamp, fmtDb, fmtFreq, fmtMs, param, physOf, type Range } from "./params";

export const XF_RANGES = {
  sensitivity: { min: 0, max: 1 },
  maxCuts: { min: 1, max: 4 },
  maxDepth: { min: 3, max: 36 },
  release: { min: 50, max: 3000 },
  auto: { min: 0, max: 1 },
  mix: { min: 0, max: 1 },
  output: { min: -18, max: 6 },
} satisfies Record<string, Range>;

/** Param indices (MoshXFeedbackPlugin.cpp:118-124). */
export const XF_PARAM = { sensitivity: 0, maxCuts: 1, maxDepth: 2, release: 3, auto: 4, mix: 5, output: 6 } as const;

/** Native defaults in physical units (MoshXFeedbackPlugin.cpp:11-17). */
export const XF_DEFAULTS = { sensitivity: 0.65, maxCuts: 2, maxDepth: 18, release: 500, auto: 0, mix: 1, output: 0 } as const;

/** The detector's fixed band (MoshFxDsp.h:54-55; top capped at 0.48·fs, Dsp.cpp:119). */
export const XF_BAND_HZ = { lo: 250, hi: 10000 } as const;
export const xfTopHz = (sampleRate: number): number =>
  Math.min(XF_BAND_HZ.hi, (Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000) * 0.48);

/** The notches' fixed Q (MoshXFeedbackDsp.cpp:51). */
export const XF_NOTCH_Q = 30;
/** The score axis the strip draws (a real sinusoid scores at most about 0.71). */
export const XF_SCORE_MAX = 0.75;
/** The dB axis the hanging notches use, top = 0 dB. */
export const XF_DEPTH_AXIS_DB = 30;
/** The ring strip's coordinates, in CSS px at the 320 px inspector: the plot is drawn 273 px
 *  wide (the 289 px row less its padding), so the viewBox is 1:1 and the 9 px axis text
 *  renders at 9 px. The top `lane` px carry the status line alone; candidates, the threshold
 *  and the hanging notches live in the band below it, so no marker is drawn through the text. */
export const XF_STRIP = { w: 273, h: 38, lane: 13 } as const;
/** The detector returns nothing for blocks shorter than this (MoshXFeedbackDsp.cpp:106). */
export const XF_MIN_BLOCK = 128;

/** The detection threshold on the score for a Sensitivity (0-1). */
export const xfThreshold = (sensitivity: number): number => 0.06 + 0.36 * (1 - clamp(sensitivity, 0, 1));
/** JUCE roundToInt: adds 1.5·2^52 to the double, so an exact .5 rounds to the even
 *  neighbour (2.5 → 2, 3.5 → 4), unlike Math.round (juce_MathsFunctions.h:597-611). */
export function juceRoundToInt(x: number): number {
  const f = Math.floor(x);
  if (x - f === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}
/** The engine's effective cut count for Max Cuts' physical value (jlimit(1,4,roundToInt)). */
export const xfMaxCuts = (phys: number): number => clamp(juceRoundToInt(phys), 1, 4);
/** The normalised value that sets Max Cuts to `n` (1..4). */
export const xfCutsNorm = (n: number): number => (clamp(Math.round(n), 1, 4) - 1) / 3;
/** Auto Suppress is on iff its physical value is at least 0.5. */
export const xfAutoOn = (phys: number): boolean => phys >= 0.5;

export type XfSettings = {
  sensitivity: number; maxCuts: number; maxDepth: number; release: number; auto: boolean; mix: number; output: number;
};

export function xfSettings(plugin: Plugin): XfSettings {
  const p = (i: number, r: Range) => physOf(param(plugin, i), r);
  return {
    sensitivity: p(XF_PARAM.sensitivity, XF_RANGES.sensitivity),
    maxCuts: xfMaxCuts(p(XF_PARAM.maxCuts, XF_RANGES.maxCuts)),
    maxDepth: p(XF_PARAM.maxDepth, XF_RANGES.maxDepth),
    release: p(XF_PARAM.release, XF_RANGES.release),
    auto: xfAutoOn(p(XF_PARAM.auto, XF_RANGES.auto)),
    mix: p(XF_PARAM.mix, XF_RANGES.mix),
    output: p(XF_PARAM.output, XF_RANGES.output),
  };
}

/** This plugin's frame, or undefined when the entry at its key belongs to another plugin
 *  (frames are keyed by track and index, so a delete or reorder can briefly leave another
 *  plugin's frame there) or is malformed. */
export function xfMeterOf(m: PluginMeterReading | undefined, itemId?: string): FeedbackMeter | undefined {
  if (!m || m.type !== "moshXFeedback") return undefined;
  if (itemId && m.itemId && m.itemId !== itemId) return undefined;
  const f = m as FeedbackMeter;
  return Array.isArray(f.candidates) && Array.isArray(f.cuts) ? f : undefined;
}

// ── the notch the engine cuts with ─────────────────────────────────────────────────────

export type Notch = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** The RBJ notch of MoshXFeedbackDsp.cpp applyNotch (Q = 30), normalised by a0. */
export function xfNotch(hz: number, sampleRate: number): Notch {
  const w0 = 2 * Math.PI * clamp(hz / sampleRate, 0, 0.49);
  const alpha = Math.sin(w0) / (2 * XF_NOTCH_Q);
  const c = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: 1 / a0, b1: -2 * c / a0, b2: 1 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0 };
}

/** How much of the notched signal each cut blends in: (1 − 10^(−|depth|/20))·mix. */
export const xfBlend = (depthDb: number, mix: number): number =>
  clamp(1 - 10 ** (-Math.abs(depthDb) / 20), 0, 1) * clamp(mix, 0, 1);

/** The magnitude (dB) of the active cuts in series at `hz`: Π |(1 − m) + m·N(e^jω)|. Output
 *  gain is not included (it lifts or lowers everything equally). */
export function xfCutsDb(hz: number, cuts: readonly { hz: number; depthDb: number }[], mix: number, sampleRate: number): number {
  const w = 2 * Math.PI * hz / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let mag = 1;
  for (const cut of cuts) {
    const n = xfNotch(cut.hz, sampleRate);
    const m = xfBlend(cut.depthDb, mix);
    // N = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
    const nr = n.b0 + n.b1 * c1 + n.b2 * c2, ni = -(n.b1 * s1 + n.b2 * s2);
    const dr = 1 + n.a1 * c1 + n.a2 * c2, di = -(n.a1 * s1 + n.a2 * s2);
    const dd = dr * dr + di * di;
    const hr = (nr * dr + ni * di) / dd, hi = (ni * dr - nr * di) / dd;
    const br = 1 - m + m * hr, bi = m * hi;
    mag *= Math.hypot(br, bi);
  }
  return 20 * Math.log10(Math.max(mag, 1e-9));
}

/** Where to sample the cuts' curve: a log grid across the strip plus a fine cluster around
 *  each notch (its -3 dB width is only about f/30), so the drawn dip reaches the real depth. */
export function xfCurveFreqs(cuts: readonly { hz: number }[], lo: number, hi: number, n = 120): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo * (hi / lo) ** (i / (n - 1)));
  for (const c of cuts) {
    if (!(c.hz > lo && c.hz < hi)) continue;
    for (let k = -8; k <= 8; k++) out.push(c.hz * 2 ** (k * 0.004));
  }
  return out.filter((f) => f >= lo && f <= hi).sort((a, b) => a - b);
}

// ── read-outs ──────────────────────────────────────────────────────────────────────────

/** "1.26 kHz", "850 Hz": the shared in-panel frequency read-out. */
export const fmtRingHz = fmtFreq;

/** The attenuation a cut actually applies at its centre (dB, ≤ 0): the notch is exactly
 *  zero there, so the blend leaves 1 − m, with m = (1 − 10^(−depth/20))·Mix. At Mix 1 this
 *  is −depth; at Mix 0.5 a 12.7 dB cut applies −4.2 dB. */
export const xfAppliedDb = (depthDb: number, mix: number): number =>
  20 * Math.log10(Math.max(1e-9, 1 - xfBlend(depthDb, mix)));

/** An active cut's chip, at the depth actually applied: "1.26 kHz -12.7 dB". */
export const xfCutChip = (cut: { hz: number; depthDb: number }, mix = 1): string =>
  `${fmtRingHz(cut.hz)} ${fmtDb(xfAppliedDb(cut.depthDb, mix))}`;

/** How many chips the status line (the strip's own lane, 267 px of 9 px monospace) shows in
 *  full before the rest fold into "+N": a cut chip ("1.26 kHz -12.7 dB") is about 92 px, so
 *  two fit beside "cutting" and a "+N"; a ringing chip ("2.61 kHz") is about 44 px, so all
 *  four the engine can report fit beside "would cut". */
export const XF_STATUS_CHIPS = { cutting: 2, ringing: 4 } as const;

export type XfStatus =
  | { kind: "bypassed" | "idle" | "quiet"; text: string; chips: [] }
  | { kind: "ringing" | "cutting"; text: string; chips: string[] };

/** The chips the status line shows: up to `max` in full, the rest folded into one "+N"
 *  chip whose `rest` lists them (for its title), so nothing is clipped mid-text. */
export function xfVisibleChips(chips: readonly string[], max: number): { shown: string[]; more: string | null; rest: string[] } {
  if (chips.length <= max) return { shown: [...chips], more: null, rest: [] };
  const rest = chips.slice(max);
  return { shown: chips.slice(0, max), more: `+${rest.length}`, rest };
}

/** The status line in the strip: what the detector hears right now, from the meter. With
 *  no frame (transport stopped, or an engine without the meter rail) it is "no signal".
 *  Cut chips read the depth actually applied at Mix (xfAppliedDb). */
export function xfStatus(meter: FeedbackMeter | undefined, enabled: boolean, auto: boolean, mix = 1): XfStatus {
  if (!enabled) return { kind: "bypassed", text: "bypassed", chips: [] };
  if (!meter) return { kind: "idle", text: "no signal", chips: [] };
  const cuts = meter.cuts ?? [], cands = meter.candidates ?? [];
  if (cuts.length) return { kind: "cutting", text: "cutting", chips: cuts.map((c) => xfCutChip(c, mix)) };
  if (cands.length) {
    return { kind: "ringing", text: auto ? "ringing" : "would cut", chips: cands.map((c) => fmtRingHz(c.hz)) };
  }
  return { kind: "quiet", text: "nothing ringing", chips: [] };
}

/** The minimized row's summary budget: its slot measures 97 px at the 320 px inspector, and
 *  10 px monospace is about 6.02 px a character, so 16 fit whole. */
export const XF_SUMMARY_CHARS = 16;

/** The minimized line, most telling first, within XF_SUMMARY_CHARS: Detect says so and its
 *  Sensitivity ("detect sens 65%"); Suppress gives its two ceilings ("≤2 cuts · ≤18 dB":
 *  a cut's depth is Max Depth × its score, at most about 0.71 × Max Depth for a pure tone),
 *  then whatever else still fits whole (Release, Mix below 100%, Output). Lowercase words,
 *  no single-letter abbreviations. */
export function xfSummary(plugin: Plugin): string {
  const s = xfSettings(plugin);
  const out = Math.abs(s.output) >= 0.05 ? `out ${fmtDb(s.output)}` : "";
  const sens = `sens ${Math.round(s.sensitivity * 100)}%`;
  // One phrase ("detect · sens 65%" would be one over the budget).
  if (!s.auto) return fitSummary([`detect ${sens}`, out]);
  return fitSummary([
    `≤${s.maxCuts} ${s.maxCuts === 1 ? "cut" : "cuts"}`,
    `≤${Math.round(s.maxDepth)} dB`,
    fmtMs(s.release),
    s.mix < 0.995 ? `mix ${Math.round(s.mix * 100)}%` : "",
    out,
  ]);
}

/** Joins `parts` with " · " in order, keeping each one only if the line still fits
 *  XF_SUMMARY_CHARS whole (a later short part may still fit after a long one is dropped).
 *  The first part always stays. */
function fitSummary(parts: string[]): string {
  const [first, ...rest] = parts.filter(Boolean);
  return rest.reduce((line, p) => (`${line} · ${p}`.length <= XF_SUMMARY_CHARS ? `${line} · ${p}` : line), first);
}
