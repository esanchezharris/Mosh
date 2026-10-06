// The 4OSC panel's pure model: which parameter is which (by engine id, never by name), the
// physical units, the amp envelope's exact shape, the filter's exact response, the
// minimized summary. Everything here is unit-tested (fourosc.test.ts).
//
// Sources (Tracktion, read only): plugins/effects/tracktion_FourOscPlugin.cpp (the addParam
// ranges, referTo defaults, FourOscVoice::updateParams / renderNextBlock, applyEffects) and
// utilities/tracktion_Envelope.{h,cpp} (ExpEnvelope). Research: instrument-research.json
// `4osc-engine` (table A) and the critic's 4OSC notes.
import type { Biquad } from "./dsp";
import { bandPass, chainDb, highPass, lowPass, notch } from "./dsp";
import { clamp, fmtDb, fmtFreq, fmtHz, fmtMs, from0to1, param, paramById, rangeOf, snapToRange, to0to1, type Range } from "./params";
import type { Plugin, PluginParam, PluginStateValue } from "../../types";

const f32 = Math.fround;

// ── parameters ─────────────────────────────────────────────────────────────────────────

/** A 4OSC parameter: its engine index, its NormalisableRange (the fallback when the engine
 *  sends none) and its default in physical units. */
export type ParamSpec = { index: number; range: Range; def: number };

const TIME: Range = { min: 0.001, max: 60, skew: 0.2 };
const ENV_TIME: Range = { min: 0, max: 60, skew: 0.2 };      // the filter and mod envelopes start at 0
const LEVEL: Range = { min: -100, max: 0, skew: 4 };
const PCT100: Range = { min: 0, max: 100 };
const UNIT: Range = { min: 0, max: 1 };

function buildSpecs(): Record<string, ParamSpec> {
  const s: Record<string, ParamSpec> = {};
  for (let n = 1; n <= 4; n++) {
    const b = 7 * (n - 1);
    s[`tune${n}`] = { index: b, range: { min: -36, max: 36, step: 1 }, def: 0 };
    s[`fineTune${n}`] = { index: b + 1, range: { min: -100, max: 100 }, def: 0 };
    s[`level${n}`] = { index: b + 2, range: LEVEL, def: 0 };
    s[`pulseWidth${n}`] = { index: b + 3, range: { min: 0.01, max: 0.99 }, def: 0.5 };
    s[`detune${n}`] = { index: b + 4, range: { min: 0, max: 0.5 }, def: 0 };
    s[`spread${n}`] = { index: b + 5, range: { min: -100, max: 100 }, def: 0 };
    s[`pan${n}`] = { index: b + 6, range: { min: -1, max: 1 }, def: 0 };
  }
  s.lfoRate1 = { index: 28, range: { min: 0, max: 500, skew: 0.3 }, def: 1 };
  s.lfoDepth1 = { index: 29, range: UNIT, def: 1 };
  s.lfoRate2 = { index: 30, range: { min: 0, max: 500, skew: 0.3 }, def: 1 };
  s.lfoDepth2 = { index: 31, range: UNIT, def: 1 };
  for (let n = 1; n <= 2; n++) {
    const b = 32 + 4 * (n - 1);
    s[`modAttack${n}`] = { index: b, range: ENV_TIME, def: 0.1 };
    s[`modDecay${n}`] = { index: b + 1, range: ENV_TIME, def: 0.1 };
    s[`modSustain${n}`] = { index: b + 2, range: PCT100, def: 80 };
    s[`modRelease${n}`] = { index: b + 3, range: TIME, def: 0.1 };
  }
  Object.assign(s, {
    ampAttack: { index: 40, range: TIME, def: 0.1 },
    ampDecay: { index: 41, range: TIME, def: 0.1 },
    ampSustain: { index: 42, range: PCT100, def: 80 },
    ampRelease: { index: 43, range: TIME, def: 0.1 },
    ampVelocity: { index: 44, range: PCT100, def: 100 },
    filterAttack: { index: 45, range: ENV_TIME, def: 0.1 },
    filterDecay: { index: 46, range: ENV_TIME, def: 0.1 },
    filterSustain: { index: 47, range: PCT100, def: 80 },
    filterRelease: { index: 48, range: ENV_TIME, def: 0.1 },
    filterFreq: { index: 49, range: { min: 0, max: 135.076232 }, def: 69 },   // a MIDI note number
    filterResonance: { index: 50, range: PCT100, def: 0.5 },
    filterAmount: { index: 51, range: { min: -1, max: 1 }, def: 0 },
    filterKey: { index: 52, range: PCT100, def: 0 },
    filterVelocity: { index: 53, range: PCT100, def: 0 },
    distortion: { index: 54, range: UNIT, def: 0 },
    reverbSize: { index: 55, range: UNIT, def: 0 },
    reverbDamping: { index: 56, range: UNIT, def: 0 },
    reverbWidth: { index: 57, range: UNIT, def: 0 },
    reverbMix: { index: 58, range: UNIT, def: 0 },
    delayFeedback: { index: 59, range: LEVEL, def: -10 },
    delayCrossfeed: { index: 60, range: LEVEL, def: -100 },
    delayMix: { index: 61, range: UNIT, def: 0 },
    chorusSpeed: { index: 62, range: { min: 0.1, max: 10 }, def: 1 },
    chorusDepth: { index: 63, range: { min: 0.1, max: 20 }, def: 3 },
    chorusWidth: { index: 64, range: UNIT, def: 0.5 },
    chorusMix: { index: 65, range: UNIT, def: 0 },
    legato: { index: 66, range: { min: 0, max: 500 }, def: 0 },
    masterLevel: { index: 67, range: LEVEL, def: 0 },
  } satisfies Record<string, ParamSpec>);
  return s;
}

/** Every 4OSC parameter by its engine id ("ampAttack", "level1", …): 68 of them. */
export const SPECS: Readonly<Record<string, ParamSpec>> = buildSpecs();

/** The parameter with engine id `id`, found by id when the engine sends ids, else by its
 *  index (an engine without ids). Never by name: names repeat (three "Mix"). */
export function paramFor(plugin: Plugin, id: string): PluginParam | undefined {
  const byId = paramById(plugin, id);
  if (byId) return byId;
  const spec = SPECS[id];
  if (!spec) return undefined;
  const p = param(plugin, spec.index);
  return p && (p.id === undefined || p.id === id) ? p : undefined;
}

/** One control's reading: where to send it (`index`), its mapping, and its value. `present`
 *  is false when the snapshot does not carry the parameter (an older engine sent only 16):
 *  such a control must not pretend to show a value. */
export type Ctl = { id: string; index: number; p?: PluginParam; range: Range; norm: number; phys: number; def: number; defNorm: number; present: boolean };

export function ctl(plugin: Plugin, id: string): Ctl {
  const spec = SPECS[id]!;
  const p = paramFor(plugin, id);
  const range = rangeOf(p, spec.range);
  const norm = p?.value ?? to0to1(range, spec.def);
  const phys = physAt(range, norm);
  return { id, index: p?.index ?? spec.index, p, range, norm, phys, def: spec.def, defNorm: to0to1(range, spec.def), present: !!p };
}

/** A normalised position in physical units (snapped to the range's step, e.g. Tune). */
export function physAt(range: Range, norm: number): number {
  const v = from0to1(range, norm);
  return range.step ? snapToRange(range, v) : v;
}

/** The normalised value set_plugin_param takes for a physical value (snapped to the step,
 *  clamped to the range). */
export function normAt(range: Range, phys: number): number {
  return to0to1(range, range.step ? snapToRange(range, phys) : phys);
}

// ── settings (set_plugin_state, contract §1c) ─────────────────────────────────────────────

export const WAVES = ["off", "sine", "square", "saw", "triangle", "noise"] as const;
export type Wave = (typeof WAVES)[number];
export const WAVE_LABEL: Record<Wave, string> = { off: "Off", sine: "Sine", square: "Square", saw: "Saw", triangle: "Triangle", noise: "Noise" };
/** The wave menu's own words (it is 56 px wide). */
export const WAVE_MENU: Record<Wave, string> = { off: "Off", sine: "Sine", square: "Square", saw: "Saw", triangle: "Tri", noise: "Noise" };
const WAVE_SHORT: Record<Wave, string> = { off: "off", sine: "sine", square: "sq", saw: "saw", triangle: "tri", noise: "noise" };

export const FILTER_TYPES = ["off", "lowpass", "highpass", "bandpass", "notch"] as const;
export type FilterType = (typeof FILTER_TYPES)[number];
export const FILTER_SHORT: Record<FilterType, string> = { off: "Off", lowpass: "LP", highpass: "HP", bandpass: "BP", notch: "Notch" };
export const FILTER_LONG: Record<FilterType, string> = { off: "Off", lowpass: "Low-pass", highpass: "High-pass", bandpass: "Band-pass", notch: "Notch" };

const stateStr = (plugin: Plugin, key: string): string | undefined => {
  const v = plugin.state?.[key]?.value;
  return typeof v === "string" ? v : undefined;
};

/** Oscillator n's wave ("off" when the snapshot does not say). */
export function waveOf(plugin: Plugin, n: number): Wave {
  const v = stateStr(plugin, `waveShape${n}`);
  return (WAVES as readonly string[]).includes(v ?? "") ? (v as Wave) : "off";
}

/** Oscillator n's unison voices (1..8). */
export function voicesOf(plugin: Plugin, n: number): number {
  const v = plugin.state?.[`voices${n}`]?.value;
  return typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), 1, 8) : 1;
}

export function filterTypeOf(plugin: Plugin): FilterType {
  const v = stateStr(plugin, "filterType");
  return (FILTER_TYPES as readonly string[]).includes(v ?? "") ? (v as FilterType) : "off";
}

/** 12 or 24 dB/oct. The engine runs the second section only when the slope is exactly 24. */
export function filterSlopeOf(plugin: Plugin): 12 | 24 {
  const v = plugin.state?.filterSlope?.value;
  return v === 24 || v === "24" ? 24 : 12;
}

export type FxKey = "distortion" | "chorus" | "delay" | "reverb";
/** The effects in the engine's processing order (FourOscPlugin::applyEffects). */
export const FX_ORDER: readonly FxKey[] = ["distortion", "chorus", "delay", "reverb"];
export const FX_STATE: Record<FxKey, string> = { distortion: "distortionOn", chorus: "chorusOn", delay: "delayOn", reverb: "reverbOn" };
export const FX_LABEL: Record<FxKey, string> = { distortion: "Dist", chorus: "Chorus", delay: "Delay", reverb: "Reverb" };
export const FX_NAME: Record<FxKey, string> = { distortion: "Distortion", chorus: "Chorus", delay: "Delay", reverb: "Reverb" };
export const fxOn = (plugin: Plugin, fx: FxKey): boolean => stateStr(plugin, FX_STATE[fx]) === "on";

/** The amp envelope's curve constants: Analog (the default) or Digital. */
export const ampAnalogOf = (plugin: Plugin): boolean => stateStr(plugin, "ampAnalog") !== "off";

/** The delay time in beats (state `delayBeats`, 0.0625..4). */
export function delayBeatsOf(plugin: Plugin): number {
  const v = plugin.state?.delayBeats?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

/** Does the snapshot carry the 4OSC contract (all 68 parameters and the settings)? An older
 *  engine sends only the first 16 parameters and no settings: the panel then keeps the
 *  plain rows instead of drawing defaults it cannot read. */
export function hasFullContract(plugin: Plugin): boolean {
  return !!paramFor(plugin, "masterLevel") && !!paramFor(plugin, "ampAttack") && plugin.state?.waveShape1 !== undefined;
}

/** Whether a settings key is in the snapshot (so a control for it can work). */
export const hasState = (plugin: Plugin, key: string): boolean => plugin.state?.[key] !== undefined;
export const stateSpec = (plugin: Plugin, key: string): PluginStateValue | undefined => plugin.state?.[key];

// ── units ─────────────────────────────────────────────────────────────────────────────

const signed = (v: number, text: string): string => (v > 0 ? `+${text}` : text);
const noNegZero = (v: number): number => (Object.is(v, -0) ? 0 : v);

/** Tune: whole semitones, "+7 st", "0 st", "-12 st". */
export const fmtSt = (st: number): string => {
  const r = noNegZero(Math.round(st));
  return `${signed(r, String(r))} st`;
};
/** Fine tune and unison detune in cents: "+12 ct", "0 ct". */
export const fmtCents = (ct: number): string => {
  const r = noNegZero(Math.round(ct));
  return `${signed(r, String(r))} ct`;
};
/** A level in dB, one decimal ("0.0 dB", "-15.9 dB", "-100.0 dB" is the floor). */
export const fmtLevel = (db: number): string => fmtDb(db, 1);
/** The same without the unit and narrower, for the oscillator chips: one decimal near 0,
 *  whole dB from -10 down ("-4.0", "0.0", "-15", "-100"). */
export const fmtLevelBare = (db: number): string => fmtDb(db, Math.abs(db) >= 9.95 ? 0 : 1).replace(" dB", "");
/** 0..100 percentages: one decimal under 10 ("0.5%"), whole above ("80%"). */
export const fmtPct100 = (v: number): string => (Math.abs(v) < 9.95 && Math.round(v * 10) % 10 !== 0 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);
/** 0..1 fractions as percent ("50%"). */
export const fmtFrac = (v: number): string => `${Math.round(v * 100)}%`;
/** A bipolar percent ("+70%", "-30%", "0%"). */
export const fmtSignedPct = (v: number): string => {
  const r = noNegZero(Math.round(v));
  return `${signed(r, String(r))}%`;
};
/** Seconds as the family's time read-out ("1.0 ms", "100 ms", "1.88 s"). */
export const fmtTime = (sec: number): string => fmtMs(sec * 1000);
/** Pan -1..1: "C", "L 30", "R 30". */
export function fmtPan(pan: number): string {
  const r = Math.round(pan * 100);
  return r === 0 ? "C" : r < 0 ? `L ${-r}` : `R ${r}`;
}

// ── the filter (FourOscVoice::updateParams) ───────────────────────────────────────────

/** Filter Freq is a MIDI note number (0..135.076232); the voice turns it into Hz. */
export const noteToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);
export const hzToNote = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
/** The voice clamps its cutoff to 8 Hz .. min(20 kHz, fs/2). */
export const cutoffTop = (fs: number): number => Math.min(20000, (fs > 0 ? fs : 48000) / 2);
export const clampCutoffHz = (hz: number, fs: number): number => clamp(hz, 8, cutoffTop(fs));
/** The BASE cutoff in Hz: Filter Freq alone, as the voice uses it for middle C before the
 *  filter envelope and key tracking move it (each note gets its own). */
export const baseCutoffHz = (note: number, fs: number): number => clampCutoffHz(noteToHz(note), fs);

/** Resonance (0..100 %) → the first section's Q, in float as the engine computes it:
 *  0.70710678118655 / (1 − res/100 · 0.99). 0.5 % (the default) is Q 0.7106; 100 % is 70.7. */
export function resonanceQ(resPct: number): number {
  return f32(f32(0.70710678118655) / f32(1 - f32(f32(clamp(resPct, 0, 100) / 100) * f32(0.99))));
}
/** The second section's fixed Q (24 dB/oct only). */
export const SECOND_Q = f32(0.70710678118655);

/** The biquads the voice runs: one of the type at the resonance's Q, then (24 dB/oct) a
 *  second of the same type at Q 0.7071. The engine hard-clips between the two, so the drawn
 *  24 dB curve is the small-signal response. "off" runs none. */
export function filterChain(type: FilterType, slope: 12 | 24, fs: number, fc: number, q: number): Biquad[] {
  const make = type === "lowpass" ? lowPass : type === "highpass" ? highPass : type === "bandpass" ? bandPass : type === "notch" ? notch : null;
  if (!make) return [];
  const first = make(fs, fc, q);
  return slope === 24 ? [first, make(fs, fc, SECOND_Q)] : [first];
}

/** The response in dB at f (0 dB everywhere when the filter is off). */
export function filterDb(type: FilterType, slope: 12 | 24, fs: number, fc: number, q: number, f: number): number {
  const chain = filterChain(type, slope, fs, fc, q);
  return chain.length ? chainDb(chain, f, fs) : 0;
}

/** Where the filter envelope takes the cutoff at its peak (a full-velocity note at middle
 *  C): the voice adds env · Amount · 137 semitones to Filter Freq. */
export const envPeakNote = (baseNote: number, amount: number): number => baseNote + amount * 137;

// ── the amp envelope (tracktion ExpEnvelope) ──────────────────────────────────────────
// Each stage is a one-pole recursion e[n+1] = offset + coeff·e[n] toward a target past its
// goal by the "TCO" constant, with coeff = exp(−ln((1 + TCO)/TCO) / N) for an N-sample stage
// (tracktion_Envelope.cpp). Its closed form, with k = TCO/(1 + TCO) and u = n/N:
//   attack   e = (1 + TCO)·(1 − k^u)                   reaches 1 exactly at u = 1
//   decay    e = (S − TCO) + (1 − S + TCO)·k^u          stops at S (u* ≤ 1; u* = 1 for S = 0)
//   release  e = −TCO + (from + TCO)·k^u                stops at 0 (u* = 1 when from = 1)
// Analog: attack TCO e^−0.5, decay and release e^−5. Digital: all 10^(−96/20).

export type Tco = { attack: number; decay: number; release: number };
export const TCO_ANALOG: Tco = { attack: f32(Math.exp(-0.5)), decay: f32(Math.exp(-5)), release: f32(Math.exp(-5)) };
const DIGITAL = f32(10 ** (-96 / 20));
export const TCO_DIGITAL: Tco = { attack: DIGITAL, decay: DIGITAL, release: DIGITAL };
export const tcoOf = (analog: boolean): Tco => (analog ? TCO_ANALOG : TCO_DIGITAL);

const kOf = (tco: number) => tco / (1 + tco);

export function expAttack(u: number, tco: number): number {
  return Math.min(1, (1 + tco) * (1 - kOf(tco) ** clamp(u, 0, 1)));
}
export function expDecay(u: number, sustain: number, tco: number): number {
  return Math.max(sustain, sustain - tco + (1 - sustain + tco) * kOf(tco) ** clamp(u, 0, 1));
}
export function expRelease(u: number, from: number, tco: number): number {
  return Math.max(0, -tco + (from + tco) * kOf(tco) ** clamp(u, 0, 1));
}
/** The fraction of the decay time at which the decay reaches the sustain level. */
export function decayEnd(sustain: number, tco: number): number {
  if (sustain >= 1) return 0;
  return clamp(Math.log(tco / (1 - sustain + tco)) / Math.log(kOf(tco)), 0, 1);
}
/** The fraction of the release time at which a release from `from` reaches 0. */
export function releaseEnd(from: number, tco: number): number {
  if (from <= 0) return 0;
  return clamp(Math.log(tco / (from + tco)) / Math.log(kOf(tco)), 0, 1);
}

export type Adsr = { attack: number; decay: number; sustain: number; release: number };

/** The amp envelope's settings (seconds; sustain 0..1). */
export function ampAdsr(plugin: Plugin): Adsr {
  return {
    attack: ctl(plugin, "ampAttack").phys,
    decay: ctl(plugin, "ampDecay").phys,
    sustain: clamp(ctl(plugin, "ampSustain").phys / 100, 0, 1),
    release: ctl(plugin, "ampRelease").phys,
  };
}

// The plot: each stage gets a width that grows with the LOG of its time (1 ms .. 60 s), so a
// 2 ms attack and a 20 s release are both grabbable; inside a stage time is linear, so the
// curve's shape is exact. The sustain is a plateau (it lasts as long as the key is held),
// and the release starts at a fixed "key up" line.
export const ENV_T_LO = 0.001, ENV_T_HI = 60;
export type EnvBox = { w: number; h: number; padL: number; padTop: number; padBottom: number; segMin: number; segMax: number; holdMin: number };
export const ENV_PLOT: EnvBox = { w: 273, h: 54, padL: 6, padTop: 7, padBottom: 6, segMin: 7, segMax: 74, holdMin: 26 };

const logFrac = (t: number) => clamp(Math.log(Math.max(t, ENV_T_LO) / ENV_T_LO) / Math.log(ENV_T_HI / ENV_T_LO), 0, 1);
/** A stage's width for its time. */
export const segWidth = (t: number, box: EnvBox = ENV_PLOT): number => box.segMin + (box.segMax - box.segMin) * logFrac(t);
/** The time a stage width stands for (the inverse of segWidth, clamped to 1 ms..60 s). */
export const segTime = (w: number, box: EnvBox = ENV_PLOT): number =>
  ENV_T_LO * (ENV_T_HI / ENV_T_LO) ** clamp((w - box.segMin) / (box.segMax - box.segMin), 0, 1);

export type EnvGeometry = {
  /** The curve, as an SVG path. */
  d: string;
  /** The same closed down to the baseline (for the fill). */
  area: string;
  x0: number; xA: number; xD: number; xOff: number; xR: number;
  yTop: number; yBot: number;
  nodes: { attack: { x: number; y: number }; decay: { x: number; y: number }; release: { x: number; y: number } };
};

/** Sample positions inside a stage, denser near its start (where a digital stage moves fastest). */
const stageU = (n: number) => Array.from({ length: n + 1 }, (_, i) => (i / n) ** 2);

export function envGeometry(env: Adsr, analog: boolean, box: EnvBox = ENV_PLOT, samples = 28): EnvGeometry {
  const tco = tcoOf(analog);
  const yTop = box.padTop, yBot = box.h - box.padBottom;
  const y = (e: number) => yBot - clamp(e, 0, 1) * (yBot - yTop);
  const x0 = box.padL;
  const xA = x0 + segWidth(env.attack, box);
  const xD = xA + segWidth(env.decay, box);
  const xOff = x0 + 2 * box.segMax + box.holdMin;
  const xR = xOff + segWidth(env.release, box);
  const S = clamp(env.sustain, 0, 1);
  const pts: [number, number][] = [[x0, yBot]];
  for (const u of stageU(samples).slice(1)) pts.push([x0 + (xA - x0) * u, y(expAttack(u, tco.attack))]);
  const uD = decayEnd(S, tco.decay);
  for (const u of stageU(samples).slice(1)) {
    if (u > uD) { pts.push([xA + (xD - xA) * uD, y(S)]); break; }
    pts.push([xA + (xD - xA) * u, y(expDecay(u, S, tco.decay))]);
  }
  pts.push([xOff, y(S)]);
  const uR = releaseEnd(S, tco.release);
  for (const u of stageU(samples).slice(1)) {
    if (u > uR) { pts.push([xOff + (xR - xOff) * uR, yBot]); break; }
    pts.push([xOff + (xR - xOff) * u, y(expRelease(u, S, tco.release))]);
  }
  pts.push([xR, yBot]);
  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`).join(" ");
  return {
    d, area: `${d} Z`, x0, xA, xD, xOff, xR, yTop, yBot,
    nodes: { attack: { x: xA, y: yTop }, decay: { x: xD, y: y(S) }, release: { x: xR, y: yBot } },
  };
}

/** A drag on the envelope plot: the settings a node position stands for. */
export function attackAtX(x: number, box: EnvBox = ENV_PLOT): number { return segTime(x - box.padL, box); }
export function decayAtX(x: number, xA: number, box: EnvBox = ENV_PLOT): number { return segTime(x - xA, box); }
export function releaseAtX(x: number, box: EnvBox = ENV_PLOT): number { return segTime(x - (box.padL + 2 * box.segMax + box.holdMin), box); }
export function sustainAtY(yPx: number, box: EnvBox = ENV_PLOT): number {
  const yTop = box.padTop, yBot = box.h - box.padBottom;
  return clamp((yBot - yPx) / (yBot - yTop), 0, 1);
}

/** Velocity sensitivity: the gain a note of velocity `vel` (0..1) gets
 *  (FourOscVoice::velocityToGain, clamped to 0..1 as the voice does). */
export function velocityGain(vel: number, sensPct: number): number {
  const s = clamp(sensPct, 0, 100) / 100;
  const v = vel * s + 1 - s;
  return clamp(v * 25 ** v * 0.04, 0, 1);
}

// ── the delay's time (state delayBeats) as note values ─────────────────────────────────

/** Note values the delay can take, in beats (quarter notes), shortest first. */
export const DELAY_NOTES: readonly { label: string; beats: number }[] = [
  { label: "1/64", beats: 1 / 16 }, { label: "1/32", beats: 1 / 8 }, { label: "1/16T", beats: 1 / 6 },
  { label: "1/16", beats: 1 / 4 }, { label: "1/8T", beats: 1 / 3 }, { label: "1/16.", beats: 3 / 8 },
  { label: "1/8", beats: 1 / 2 }, { label: "1/4T", beats: 2 / 3 }, { label: "1/8.", beats: 3 / 4 },
  { label: "1/4", beats: 1 }, { label: "1/2T", beats: 4 / 3 }, { label: "1/4.", beats: 3 / 2 },
  { label: "1/2", beats: 2 }, { label: "1/2.", beats: 3 }, { label: "1/1", beats: 4 },
];
/** The note value a beat count is, if any. */
export const delayNote = (beats: number): string | null =>
  DELAY_NOTES.find((n) => Math.abs(n.beats - beats) < 1e-4)?.label ?? null;
/** Delay lines hold 5.1 s (FODelayLine): a longer delay wraps. */
export const DELAY_MAX_SEC = 5.1;
export const delaySeconds = (beats: number, bpm: number): number => (bpm > 0 ? (beats * 60) / bpm : NaN);

// ── the live key strip ─────────────────────────────────────────────────────────────────

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (note: number): boolean => BLACK.has(((note % 12) + 12) % 12);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** "C4" is middle C (MIDI 60). */
export const noteName = (note: number): string => `${NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;

export type StripKey = { note: number; black: boolean; x: number; w: number };
/** A small keyboard from `lo` to `hi` (both white keys) laid across `width` px: white keys
 *  share the width, black keys sit centred on the line between their neighbours. */
export function keyStrip(lo: number, hi: number, width: number): StripKey[] {
  const whites: number[] = [];
  for (let n = lo; n <= hi; n++) if (!isBlack(n)) whites.push(n);
  const ww = width / Math.max(1, whites.length);
  const bw = ww * 0.62;
  const keys: StripKey[] = [];
  let wi = 0;
  for (let n = lo; n <= hi; n++) {
    if (isBlack(n)) keys.push({ note: n, black: true, x: wi * ww - bw / 2, w: bw });
    else { keys.push({ note: n, black: false, x: wi * ww, w: ww }); wi += 1; }
  }
  return keys;
}
/** The strip's range: a piano's (A0..C8), widened to the nearest white key to show any
 *  held note outside it. */
export function stripRange(held: readonly number[]): [number, number] {
  let lo = 21, hi = 108;
  for (const n of held) { lo = Math.min(lo, n); hi = Math.max(hi, n); }
  while (isBlack(lo)) lo -= 1;
  while (isBlack(hi)) hi += 1;
  return [Math.max(0, lo), Math.min(127, hi)];
}

// ── the minimized summary ──────────────────────────────────────────────────────────────

export const SUMMARY_MAX = 16;
const firstThatFits = (xs: string[], max = SUMMARY_MAX): string => xs.find((s) => s.length <= max) ?? xs[xs.length - 1]!.slice(0, max);

/** "saw+sq LP 1.2k", "sine · no filter", "all oscs off": the waves that sound and the
 *  filter, in at most 16 characters. */
export function fourOscSummary(plugin: Plugin, fs = 48000): string {
  if (!hasFullContract(plugin)) return plugin.name;
  const waves = [1, 2, 3, 4].map((n) => waveOf(plugin, n)).filter((w) => w !== "off");
  if (waves.length === 0) return "all oscs off";
  const w = waves.map((x) => WAVE_SHORT[x]).join("+");
  const n = `${waves.length} oscs`;
  const type = filterTypeOf(plugin);
  if (type === "off") return firstThatFits([`${w} · no filter`, `${w} no filter`, `${w} · no flt`, `${n} · no filter`, w]);
  const hz = baseCutoffHz(ctl(plugin, "filterFreq").phys, fs);
  const t = FILTER_SHORT[type];
  const long = fmtHz(hz), short = Math.round(hz) < 1000 ? String(Math.round(hz)) : long;
  return firstThatFits([`${w} ${t} ${long}`, `${w} ${t} ${short}`, `${w} ${t}`, `${n} ${t} ${short}`, w]);
}

/** In-panel cutoff read-out ("440 Hz", "1.20 kHz"). */
export const fmtCutoff = fmtFreq;

// ── modulation routes (read-only) ──────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  lfo1: "LFO 1", lfo2: "LFO 2", env1: "Env 1", env2: "Env 2", mpePressure: "Pressure", mpeTimbre: "Timbre",
  midiNote: "Note", midiVelocity: "Velocity",
};
export const modSourceLabel = (src: string): string => SOURCE_LABEL[src] ?? (/^cc\d+$/.test(src) ? `CC ${src.slice(2)}` : src);
/** A route's depth is added to the target's normalised value: "+50%" of its range. */
export const fmtModDepth = (depth: number): string => fmtSignedPct(depth * 100);

const OSC_PART: Record<string, string> = {
  tune: "tune", fineTune: "fine", level: "level", pulseWidth: "width", detune: "detune", spread: "spread", pan: "pan",
};
const NAMED: Record<string, string> = {
  ampAttack: "Amp attack", ampDecay: "Amp decay", ampSustain: "Amp sustain", ampRelease: "Amp release", ampVelocity: "Amp velocity",
  filterAttack: "Filter attack", filterDecay: "Filter decay", filterSustain: "Filter sustain", filterRelease: "Filter release",
  filterFreq: "Cutoff", filterResonance: "Resonance", filterAmount: "Filter env", filterKey: "Key tracking", filterVelocity: "Filter velocity",
};
/** A parameter's label that says which part of the synth it belongs to ("Osc 2 level",
 *  "Cutoff", "LFO 1 rate"): engine names repeat, ids do not. */
export function paramLabel(id: string, fallback?: string): string {
  const osc = /^(tune|fineTune|level|pulseWidth|detune|spread|pan)([1-4])$/.exec(id);
  if (osc) return `Osc ${osc[2]} ${OSC_PART[osc[1]!]}`;
  const lfo = /^lfo(Rate|Depth)([12])$/.exec(id);
  if (lfo) return `LFO ${lfo[2]} ${lfo[1]!.toLowerCase()}`;
  const env = /^mod(Attack|Decay|Sustain|Release)([12])$/.exec(id);
  if (env) return `Env ${env[2]} ${env[1]!.toLowerCase()}`;
  return NAMED[id] ?? fallback ?? id;
}

// ── which section shows (view state, per plugin, per viewer) ──────────────────────────

export type Section = "osc" | "amp" | "filter" | "fx" | "mod";
export const SECTIONS: readonly Section[] = ["osc", "amp", "filter", "fx", "mod"];
const SECTION_KEY = "mosh.v3.fourOscSection";
const SECTION_MAX = 200;
type Store = Pick<Storage, "getItem" | "setItem">;
const storage = (): Store | undefined => {
  try { return globalThis.localStorage ?? undefined; } catch { return undefined; }
};

/** The section last shown for this plugin (`key`: its item id), if remembered. */
export function loadSection(key: string, store: Store | undefined = storage()): Section | null {
  try {
    const raw = store?.getItem(SECTION_KEY);
    const map = raw ? JSON.parse(raw) : null;
    const v = map && typeof map === "object" && !Array.isArray(map) ? map[key] : undefined;
    return (SECTIONS as readonly unknown[]).includes(v) ? (v as Section) : null;
  } catch {
    return null;
  }
}

export function saveSection(key: string, section: Section, store: Store | undefined = storage()): void {
  try {
    const raw = store?.getItem(SECTION_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const map: Record<string, Section> = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    delete map[key];
    map[key] = section;                                   // re-inserted: newest last
    const keys = Object.keys(map);
    const kept = keys.length > SECTION_MAX ? Object.fromEntries(keys.slice(-SECTION_MAX).map((k) => [k, map[k]])) : map;
    store?.setItem(SECTION_KEY, JSON.stringify(kept));
  } catch {
    /* storage unavailable: the choice lasts while the panel is mounted */
  }
}
