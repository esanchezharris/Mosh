// Tracktion ReverbPlugin = juce::Reverb (FreeVerb), unpatched. Pure view maths for the
// reverb panel; every constant below is the engine's (research key "reverb"):
//   feedback  g = frozen ? 1 : 0.7 + 0.28·size          (juce_Reverb.h:214-222)
//   damping   d = frozen ? 0 : 0.4·damping               (juce_Reverb.h:216,221)
//   comb loop: out = buf[n]; lp = out·(1−d) + lp·d; buf[n] = in + lp·g   (:255-266)
//   so one round trip has gain G(f) = g·(1−d) / √(1 − 2d·cos(2πf/fs) + d²)
//   and RT60(f) = −3·τ / log10 G(f), τ = the comb delay in seconds.
//   wet gain = 3·wet (split by width), dry gain = 2·dry   (juce_Reverb.h:83-89)
//   frozen when param 5 ≥ 0.5; the tank input is then cut and the tail sustains.
import type { Plugin } from "../../types";
import { clamp, fmtDb, param } from "./params";

/** The eight comb lengths at 44.1 kHz (L channel; R adds 23). They scale with the sample
 *  rate, so in seconds they do not depend on it. */
export const COMB_SAMPLES_44K = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617] as const;
/** τ: the mean comb delay (1378 samples at 44.1 kHz ≈ 31.25 ms). The tail is eight combs
 *  of 25-37 ms, so every decay time here is approximate (an RT60 estimate; the panel says
 *  "about" in its tooltips and spoken values rather than printing "~"). */
export const COMB_TAU_S = COMB_SAMPLES_44K.reduce((a, b) => a + b, 0) / COMB_SAMPLES_44K.length / 44100;
/** The first wet output arrives after the shortest comb (L): 1116 / 44100 s. No pre-delay. */
export const ONSET_S = COMB_SAMPLES_44K[0] / 44100;
/** The frequency the "highs" decay is quoted at. */
export const HF_HZ = 8000;

export const FREEZE_PARAM = 5;
export const DEFAULTS = { size: 0.3, damping: 0.5, wet: 1 / 3, dry: 0.5, width: 1, freeze: 0 } as const;
/** Where each level is unity gain (0 dB): Wet is 3·v, Dry 2·v. The gain dials draw from here. */
export const UNITY = { wet: 1 / 3, dry: 0.5 } as const;

export const feedbackOf = (size: number, frozen = false): number => (frozen ? 1 : 0.7 + 0.28 * clamp(size, 0, 1));
export const dampCoefOf = (damping: number, frozen = false): number => (frozen ? 0 : 0.4 * clamp(damping, 0, 1));

/** One comb round trip's gain at `hz`. */
export function loopGain(g: number, d: number, hz: number, fs: number): number {
  const w = (2 * Math.PI * Math.min(hz, fs / 2)) / fs;
  return (g * (1 - d)) / Math.sqrt(1 - 2 * d * Math.cos(w) + d * d);
}

/** Seconds for the tail to fall 60 dB at `hz` (Infinity when frozen / G ≥ 1). */
export function rt60(g: number, d: number, hz: number, fs: number, tau = COMB_TAU_S): number {
  const G = loopGain(g, d, hz, fs);
  return G >= 1 ? Infinity : (-3 * tau) / Math.log10(G);
}

/** The Size (0-1) whose low-frequency decay is `seconds` (damping does not change DC). */
export function sizeForRt60(seconds: number, tau = COMB_TAU_S): number {
  if (!(seconds > 0)) return 0;
  const g = 10 ** ((-3 * tau) / seconds);
  return clamp((g - 0.7) / 0.28, 0, 1);
}

/** The Damping (0-1) that gives a high-frequency decay of `seconds` at this Size, solved
 *  by bisection (the HF decay falls monotonically as damping rises). Clamped to what the
 *  engine can reach: 0 when the target is at or above the LF decay, 1 below its shortest. */
export function dampingForHfRt60(seconds: number, size: number, fs: number, hz = HF_HZ): number {
  const g = feedbackOf(size);
  const at = (dm: number) => rt60(g, dampCoefOf(dm), hz, fs);
  if (seconds >= at(0)) return 0;
  if (seconds <= at(1)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) > seconds) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** dB of a linear gain; -Infinity at 0. */
export const gainDb = (gain: number): number => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
/** Wet Level's gain in dB (engine: gainToDbString(3·v); 1/3 is unity). */
export const wetDb = (v: number): number => gainDb(3 * clamp(v, 0, 1));
/** Dry Level's gain in dB (engine: gainToDbString(2·v); 0.5 is unity). */
export const dryDb = (v: number): number => gainDb(2 * clamp(v, 0, 1));

/** A level dial's read-out: one decimal below 10 dB ("+9.5 dB", "-6.0 dB"), whole dB from
 *  there ("-30 dB"), so the widest value still fits a dial column. */
export const fmtLevel = (db: number): string => fmtDb(db, Math.abs(db) < 9.95 ? 1 : 0);

/** A summary's level: whole dB unless that hides a tenth ("-6 dB", "-0.3 dB"); "off" at -∞. */
export function fmtLevelShort(db: number): string {
  if (!Number.isFinite(db)) return "off";
  const tenth = Math.round(db * 10) / 10;
  return fmtDb(tenth, Number.isInteger(tenth) || Math.abs(tenth) >= 10 ? 0 : 1);
}

/** "0.89 s", "2.7 s", "11 s", "∞". */
export function fmtSec(s: number): string {
  if (!Number.isFinite(s)) return "∞";
  if (s < 1) return `${s.toFixed(2)} s`;
  if (s < 10) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}

export type ReverbModel = {
  size: number; damping: number; wet: number; dry: number; width: number;
  frozen: boolean;
  /** Decay at low frequencies (DC) and at HF_HZ, in seconds, as the engine runs now. */
  rtLow: number; rtHigh: number;
  /** The same two decays with Freeze off (what Size and Damping are set to). */
  rtLowSet: number; rtHighSet: number;
  wetDb: number; dryDb: number;
};

const val = (plugin: Plugin, i: number, fallback: number) => {
  const v = param(plugin, i)?.value;
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, 0, 1) : fallback;
};

/** Everything the panel shows, from the snapshot's six parameters (all 0..1). */
export function reverbModel(plugin: Plugin, fs: number, over: Partial<Record<number, number>> = {}): ReverbModel {
  const get = (i: number, fb: number) => (over[i] !== undefined ? clamp(over[i]!, 0, 1) : val(plugin, i, fb));
  const size = get(0, DEFAULTS.size), damping = get(1, DEFAULTS.damping);
  const wet = get(2, DEFAULTS.wet), dry = get(3, DEFAULTS.dry), width = get(4, DEFAULTS.width);
  const frozen = get(FREEZE_PARAM, DEFAULTS.freeze) >= 0.5;   // the engine's own threshold
  const rate = fs > 0 ? fs : 48000;
  const gSet = feedbackOf(size), dSet = dampCoefOf(damping);
  const rtLowSet = rt60(gSet, dSet, 0, rate), rtHighSet = rt60(gSet, dSet, HF_HZ, rate);
  return {
    size, damping, wet, dry, width, frozen,
    rtLow: frozen ? Infinity : rtLowSet, rtHigh: frozen ? Infinity : rtHighSet,
    rtLowSet, rtHighSet, wetDb: wetDb(wet), dryDb: dryDb(dry),
  };
}

/** The decay plot's time span: 1.25 × the LF decay, kept within 0.5..12 s. */
export const plotSpan = (rtLowSet: number): number => clamp(1.25 * rtLowSet, 0.5, 12);

// ── decay plot geometry (SVG viewBox units) ────────────────────────────────────────────
// The tail is drawn as a SHAPE normalised to 0 dB at its onset: one straight dB-vs-time
// line for the low-frequency decay and one for 8 kHz. The wedge between them is damping.
// Its height is not the wet level (that depends on the input), so Wet/Dry are read-outs.
// The plot is drawn 273 px wide at the 320 px inspector (the 289 px row less 2 × 7 px padding
// and the 2 px frame), so one viewBox unit is one CSS pixel and its text renders at true size.
export const PLOT = { w: 273, h: 48, padX: 3, padT: 3, padB: 3, floorDb: -60 } as const;
export type Pt = { x: number; y: number };

export function decayAxes(span: number) {
  const inner = PLOT.w - 2 * PLOT.padX, tall = PLOT.h - PLOT.padT - PLOT.padB;
  return {
    tx: (t: number) => PLOT.padX + (clamp(t, 0, span) / span) * inner,
    xt: (x: number) => ((x - PLOT.padX) / inner) * span,
    dy: (db: number) => PLOT.padT + (clamp(db, PLOT.floorDb, 0) / PLOT.floorDb) * tall,
    yd: (y: number) => ((y - PLOT.padT) / tall) * PLOT.floorDb,
    bottom: PLOT.h - PLOT.padB, right: PLOT.w - PLOT.padX,
  };
}

/** Where a decay of `rt` seconds (starting at the onset) leaves the plot: at the -60 dB
 *  floor, or at the right edge when it is longer than the span. */
export function decayEnd(rt: number, span: number): Pt {
  const a = decayAxes(span);
  if (!Number.isFinite(rt)) return { x: a.right, y: a.dy(0) };
  const tEnd = ONSET_S + rt;
  if (tEnd <= span) return { x: a.tx(tEnd), y: a.bottom };
  return { x: a.right, y: a.dy((PLOT.floorDb * (span - ONSET_S)) / rt) };
}

export type DecayGeometry = { onsetX: number; low: Pt; high: Pt; highMid: Pt; wedge: string };

export function decayGeometry(rtLow: number, rtHigh: number, span: number): DecayGeometry {
  const a = decayAxes(span);
  const onsetX = a.tx(ONSET_S), top = a.dy(0);
  const low = decayEnd(rtLow, span), high = decayEnd(rtHigh, span);
  const highMid = Number.isFinite(rtHigh) ? { x: a.tx(ONSET_S + rtHigh / 2), y: a.dy(PLOT.floorDb / 2) } : high;
  const f = (p: Pt) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  const corner = low.y < a.bottom - 0.01 ? ` L${f({ x: a.right, y: a.bottom })}` : "";
  const wedge = `M${f({ x: onsetX, y: top })} L${f(low)}${corner} L${f(high)} Z`;
  return { onsetX, low, high, highMid, wedge };
}

/** The minimized row's summary slot is 97 px at the 320 px inspector: 16 monospace
 *  characters at 10 px (about 6.04 px each). Measured, not estimated: 17 characters clip. */
export const SUMMARY_CHARS = 16;

/** The minimized line, at most SUMMARY_CHARS, most telling first: the low-frequency decay
 *  ("0.89 s decay", or "frozen ∞"), then whatever is away from neutral, in order Wet, Dry,
 *  Width ("2.7 s · wet off", "0.89 s · dry -6"). As in the EQ's summary, the first form that
 *  fits wins: the word "decay", full units, bare dB, then tight separators; if the changes
 *  still do not fit, the least telling are left to the panel. Every decay time is
 *  approximate (eight combs of 25-37 ms). */
export function reverbSummary(plugin: Plugin, fs = 48000): string {
  const m = reverbModel(plugin, fs);
  const head = m.frozen ? "frozen ∞" : fmtSec(m.rtLow);
  // [full, short] forms of each change; the short one drops " dB" (and "width" for "wide").
  const extras: [string, string][] = [];
  const lvl = (name: string, db: number) => {
    const t = fmtLevelShort(db);
    extras.push([`${name} ${t}`, `${name} ${t.replace(/ dB$/, "")}`]);
  };
  if (!(Math.abs(m.wetDb) < 0.05)) lvl("wet", m.wetDb);
  if (!(Math.abs(m.dryDb) < 0.05)) lvl("dry", m.dryDb);
  if (m.width < 0.995) extras.push([`width ${Math.round(m.width * 100)}%`, `${Math.round(m.width * 100)}% wide`]);
  for (let keep = extras.length; keep >= 0; keep -= 1) {
    const full = extras.slice(0, keep).map((e) => e[0]), short = extras.slice(0, keep).map((e) => e[1]);
    const forms = [
      ...(m.frozen ? [] : [[`${head} decay`, ...full].join(" · ")]),
      [head, ...full].join(" · "),
      [head, ...short].join(" · "),
      [head, ...short].join("·"),
    ];
    const fit = forms.find((t) => t.length <= SUMMARY_CHARS);
    if (fit) return fit;
  }
  return head;
}
