// The dev mock's 4OSC: the engine's parameter surface, exactly (instrument-panels contract
// §1b/§1c). Every one of Tracktion FourOscPlugin's 68 automatable parameters in constructor
// order with its paramID, name, NormalisableRange (start, end, interval, skew), default and
// read-out, and the CachedValue settings set_plugin_state reaches.
//
// Source: tracktion_engine plugins/effects/tracktion_FourOscPlugin.cpp (the addParam calls,
// the referTo defaults and setupTextFunctions), research `4osc-engine.engineDesign` table A.
// The arithmetic is done the way the engine does it: JUCE's NormalisableRange<float> in
// 32-bit floats (Math.fround), juce::roundToInt (round half to even), and String(v, n)
// (std::ostream fixed). So a mock value or display string is the one the engine would send.
import type { PluginParam, PluginStateValue } from "../types";

const f32 = Math.fround;

/** juce::roundToInt: adds 1.5·2^52 to the double, so a tie rounds to even. */
export function roundToInt(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** juce::String (value, places): a fixed-point print of the float promoted to double. */
const fixed = (v: number, places: number): string => v.toFixed(places);

// ── Tracktion's text functions (FourOscPlugin::setupTextFunctions) ─────────────────────
type Fmt = (v: number) => string;
/** The default: an integer above 100, then 1, 2 or 3 decimals, then the param's label. */
const basic = (label: string): Fmt => (value) => {
  const a = Math.abs(value);
  const text = a > 100 ? String(roundToInt(value)) : a > 10 ? fixed(value, 1) : a > 1 ? fixed(value, 2) : fixed(value, 3);
  return text + label;
};
const time: Fmt = (v) => (v < 1 ? `${roundToInt(f32(v * 1000))}ms` : `${fixed(v, 2)}s`);
const pan: Fmt = (v) => (v < 0 ? `${roundToInt(f32(-v * 100))}L` : `${roundToInt(f32(v * 100))}R`);
const pct: Fmt = (v) => `${roundToInt(f32(v * 100))}%`;
const tune: Fmt = (v) => `${roundToInt(v)}st`;
const freq: Fmt = (v) => `${roundToInt(f32(440 * f32(Math.pow(2, f32(f32(v - 69) / 12)))))}Hz`;

/** One 4OSC parameter: its range is a JUCE NormalisableRange<float>. */
export type FourOscParamSpec = {
  id: string; name: string; min: number; max: number; step: number; skew: number; def: number; fmt: Fmt;
};
const P = (id: string, name: string, min: number, max: number, def: number, fmt: Fmt, skew = 1, step = 0): FourOscParamSpec =>
  ({ id, name, min: f32(min), max: f32(max), step: f32(step), skew: f32(skew), def: f32(def), fmt });

const TIME_SKEW = 0.2;
const LEVEL_SKEW = 4;

function oscParams(n: number): FourOscParamSpec[] {
  return [
    P(`tune${n}`, `Tune ${n}`, -36, 36, 0, tune, 1, 1),
    P(`fineTune${n}`, `Fine Tune ${n}`, -100, 100, 0, basic("")),       // cents, but no label
    P(`level${n}`, `Level ${n}`, -100, 0, 0, basic("dB"), LEVEL_SKEW),
    P(`pulseWidth${n}`, `Pulse Width ${n}`, 0.01, 0.99, 0.5, pct),
    P(`detune${n}`, `Detune ${n}`, 0, 0.5, 0, pct),
    P(`spread${n}`, `Spread ${n}`, -100, 100, 0, basic("%")),
    P(`pan${n}`, `Pan ${n}`, -1, 1, 0, pan),
  ];
}
const lfoParams = (n: number): FourOscParamSpec[] => [
  P(`lfoRate${n}`, `Rate ${n}`, 0, 500, 1, basic("Hz"), 0.3),
  P(`lfoDepth${n}`, `Depth ${n}`, 0, 1, 1, pct),
];
const modEnvParams = (n: number): FourOscParamSpec[] => [
  P(`modAttack${n}`, `Mod Attack ${n}`, 0, 60, 0.1, time, TIME_SKEW),
  P(`modDecay${n}`, `Mod Decay ${n}`, 0, 60, 0.1, time, TIME_SKEW),
  P(`modSustain${n}`, `Mod Sustain ${n}`, 0, 100, 80, basic("%")),
  P(`modRelease${n}`, `Mod Release ${n}`, 0.001, 60, 0.1, time, TIME_SKEW),
];

/** The 68 parameters, index = position (the engine's getAutomatableParameter order). */
export const FOUR_OSC_PARAMS: readonly FourOscParamSpec[] = [
  ...oscParams(1), ...oscParams(2), ...oscParams(3), ...oscParams(4),           // 0-27
  ...lfoParams(1), ...lfoParams(2),                                            // 28-31
  ...modEnvParams(1), ...modEnvParams(2),                                      // 32-39
  P("ampAttack", "Amp Attack", 0.001, 60, 0.1, time, TIME_SKEW),                // 40
  P("ampDecay", "Amp Decay", 0.001, 60, 0.1, time, TIME_SKEW),
  P("ampSustain", "Amp Sustain", 0, 100, 80, basic("%")),
  P("ampRelease", "Amp Release", 0.001, 60, 0.1, time, TIME_SKEW),
  P("ampVelocity", "Amp Velocity", 0, 100, 100, basic("%")),
  P("filterAttack", "Filter Attack", 0, 60, 0.1, time, TIME_SKEW),             // 45
  P("filterDecay", "Filter Decay", 0, 60, 0.1, time, TIME_SKEW),
  P("filterSustain", "Filter Sustain", 0, 100, 80, basic("%")),
  P("filterRelease", "Filter Release", 0, 60, 0.1, time, TIME_SKEW),
  P("filterFreq", "Filter Freq", 0, 135.076232, 69, freq),                    // a MIDI note number
  P("filterResonance", "Filter Resonance", 0, 100, 0.5, basic("%")),
  P("filterAmount", "Filter Amount", -1, 1, 0, pct),
  P("filterKey", "Filter Key", 0, 100, 0, basic("%")),
  P("filterVelocity", "Filter Velocity", 0, 100, 0, basic("%")),
  P("distortion", "Distortion", 0, 1, 0, pct),                                 // 54
  P("reverbSize", "Size", 0, 1, 0, pct),
  P("reverbDamping", "Damping", 0, 1, 0, pct),
  P("reverbWidth", "Width", 0, 1, 0, pct),
  P("reverbMix", "Mix", 0, 1, 0, pct),
  P("delayFeedback", "Feedback", -100, 0, -10, basic("dB"), LEVEL_SKEW),        // 59
  P("delayCrossfeed", "Crossfeed", -100, 0, -100, basic("dB"), LEVEL_SKEW),
  P("delayMix", "Mix", 0, 1, 0, pct),
  P("chorusSpeed", "Speed", 0.1, 10, 1, basic("Hz")),                          // 62
  P("chorusDepth", "Depth", 0.1, 20, 3, basic("ms")),
  P("chorusWidth", "Width", 0, 1, 0.5, pct),
  P("chorusMix", "Mix", 0, 1, 0, pct),
  P("legato", "Legato", 0, 500, 0, basic("ms")),                               // 66
  P("masterLevel", "Level", -100, 0, 0, basic(""), LEVEL_SKEW),                // 67: dB, but no label
];

/** NormalisableRange<float>::convertFrom0to1 (clamped; the skew skipped at 0). */
export function fourOscFrom0to1(s: FourOscParamSpec, norm: number): number {
  let p = f32(Math.min(1, Math.max(0, Number.isFinite(norm) ? norm : 0)));
  if (s.skew !== 1 && p > 0) p = f32(Math.exp(f32(f32(Math.log(p)) / s.skew)));
  return f32(s.min + f32(f32(s.max - s.min) * p));
}

/** NormalisableRange<float>::convertTo0to1 (clamped). */
export function fourOscTo0to1(s: FourOscParamSpec, phys: number): number {
  const p = f32(Math.min(1, Math.max(0, f32(f32(phys - s.min) / f32(s.max - s.min)))));
  return s.skew === 1 ? p : f32(Math.pow(p, s.skew));
}

/** The snapshot entry for parameter `index` at physical value `phys` (what pluginToVar
 *  sends for 4OSC: value, display, min/max, and skew/step only where the range has them). */
export function fourOscParamEntry(index: number, phys: number): PluginParam {
  const s = FOUR_OSC_PARAMS[index]!;
  const current = f32(phys);
  return {
    index, name: s.name, value: fourOscTo0to1(s, current), display: s.fmt(current),
    min: s.min, max: s.max,
    ...(s.skew !== 1 ? { skew: s.skew } : {}),
    ...(s.step > 0 ? { step: s.step } : {}),
    id: s.id,
  };
}

/** A fresh 4OSC's 68 parameters at the engine's defaults. */
export const fourOscParams = (): PluginParam[] => FOUR_OSC_PARAMS.map((s, i) => fourOscParamEntry(i, s.def));

/** set_plugin_param on a 4OSC parameter: the engine clamps the normalised value, maps it
 *  through the range (raw = convertFrom0to1), stores the raw value and reads the snapshot
 *  value back from it. Tracktion does not snap to the interval: the Tune read-out rounds. */
export function fourOscSetNorm(index: number, norm: number): PluginParam | null {
  const s = FOUR_OSC_PARAMS[index];
  return s ? fourOscParamEntry(index, fourOscFrom0to1(s, norm)) : null;
}

// ── settings that are not parameters (set_plugin_state), contract §1c ─────────────────
const WAVES = ["off", "sine", "square", "saw", "triangle", "noise"];
const ON_OFF = ["off", "on"];
export const FOUR_OSC_STATE: Record<string, PluginStateValue> = {
  waveShape1: { value: "sine", choices: WAVES },
  waveShape2: { value: "off", choices: WAVES },
  waveShape3: { value: "off", choices: WAVES },
  waveShape4: { value: "off", choices: WAVES },
  voices1: { value: 1, min: 1, max: 8, step: 1 },
  voices2: { value: 1, min: 1, max: 8, step: 1 },
  voices3: { value: 1, min: 1, max: 8, step: 1 },
  voices4: { value: 1, min: 1, max: 8, step: 1 },
  filterType: { value: "off", choices: ["off", "lowpass", "highpass", "bandpass", "notch"] },
  filterSlope: { value: 12, min: 12, max: 24, step: 12, unit: "dB/oct" },
  distortionOn: { value: "off", choices: ON_OFF },
  reverbOn: { value: "off", choices: ON_OFF },
  delayOn: { value: "off", choices: ON_OFF },
  chorusOn: { value: "off", choices: ON_OFF },
  delayBeats: { value: 1, min: 0.0625, max: 4, unit: "beats" },
  voiceMode: { value: "poly", choices: ["mono", "legato", "poly"] },
  ampAnalog: { value: "on", choices: ON_OFF },
};

// ── the five bundled presets (resources/presets/4osc/*.json) ──────────────────────────
// An embedded copy: the mock runs in the browser and Vite does not serve files outside ui/.
// fourosc.test.ts reads the real files and fails if this copy drifts.
export type FourOscPresetFile = { state?: Record<string, string | number>; params?: Record<string, number>; waveShapes?: unknown };
export const FOUR_OSC_PRESETS: Record<string, FourOscPresetFile> = {
  "mosh-bass": {
    state: { waveShape1: "saw", waveShape2: "square", filterType: "lowpass", filterSlope: 24 },
    params: { "Level 1": 0.7807, "Level 2": 0.6416, "Tune 2": 0.3333, "Amp Attack": 0.0, "Amp Decay": 0.3509, "Amp Sustain": 0.8, "Amp Release": 0.2654, "Filter Freq": 0.3812, "Filter Resonance": 0.3, "Filter Amount": 0.6, "Filter Attack": 0.0, "Filter Decay": 0.3511, "Filter Sustain": 0.3, "Filter Release": 0.2661 },
  },
  "mosh-keys": {
    state: { waveShape1: "sine", waveShape2: "triangle", filterType: "lowpass", filterSlope: 12 },
    params: { "Level 1": 0.8009, "Level 2": 0.5496, "Tune 2": 0.6667, "Amp Attack": 0.0, "Amp Decay": 0.4493, "Amp Sustain": 0.6, "Amp Release": 0.398, "Filter Freq": 0.6983, "Filter Resonance": 0.1 },
  },
  "mosh-lead": {
    state: { waveShape1: "saw", waveShape2: "saw", voices1: 3, voices2: 3, filterType: "lowpass", filterSlope: 12 },
    params: { "Level 1": 0.8009, "Level 2": 0.7513, "Detune 1": 0.25, "Detune 2": 0.35, "Amp Attack": 0.0, "Amp Decay": 0.3013, "Amp Sustain": 0.75, "Amp Release": 0.3013, "Filter Freq": 0.8, "Filter Resonance": 0.25 },
  },
  "mosh-pad": {
    state: { waveShape1: "triangle", waveShape2: "saw", voices2: 4, filterType: "lowpass", filterSlope: 12 },
    params: { "Level 1": 0.7513, "Level 2": 0.6503, "Detune 2": 0.4, "Spread 2": 0.7, "Amp Attack": 0.5013, "Amp Decay": 0.5013, "Amp Sustain": 0.9, "Amp Release": 0.5296, "Filter Freq": 0.5484, "Filter Resonance": 0.15 },
  },
  "mosh-pluck": {
    state: { waveShape1: "square", filterType: "lowpass", filterSlope: 24 },
    params: { "Level 1": 0.8145, "Pulse Width 1": 0.3469, "Amp Attack": 0.0, "Amp Decay": 0.3463, "Amp Sustain": 0.0, "Amp Release": 0.2777, "Filter Freq": 0.4506, "Filter Resonance": 0.35, "Filter Amount": 0.725, "Filter Attack": 0.0, "Filter Decay": 0.3017, "Filter Sustain": 0.0, "Filter Release": 0.2782 },
  },
};

/** The engine's coerce for one setting (PluginState.h): a choice must be one of its ids;
 *  a number must be finite and is clamped to [min, max]; an integer with a step > 1 snaps
 *  onto min + k·step (a tie rounds up, never past the last grid point), a step of 1 rounds
 *  to a whole number (juce::roundToInt, a tie to even). Wording as the engine's. */
export function coerceSetting(key: string, spec: PluginStateValue, requested: unknown): { value: number | string } | { error: string } {
  if (spec.choices) {
    if (typeof requested !== "string" || !spec.choices.includes(requested))
      return { error: `bad value for ${key}: must be one of ${spec.choices.join(", ")}` };
    return { value: requested };
  }
  if (typeof requested !== "number" || !Number.isFinite(requested)) return { error: `bad value for ${key}: must be a finite number` };
  const lo = spec.min ?? -Infinity, hi = spec.max ?? Infinity;
  let value = Math.min(hi, Math.max(lo, requested));
  if (spec.step && spec.step > 1) {
    const top = lo + spec.step * Math.floor((hi - lo) / spec.step);
    value = Math.min(top, Math.max(lo, lo + spec.step * Math.floor((value - lo) / spec.step + 0.5)));
  } else if (spec.step === 1) {
    value = Math.min(hi, Math.max(lo, roundToInt(value)));
  }
  return { value };
}

export type FourOscPresetResult =
  | { error: string }
  | { next: PluginParam[]; nextState: Record<string, PluginStateValue>; applied: number; settingsApplied: number;
      unknown: string[]; reset: number; changed: boolean };

/** load_preset's .json branch, as the engine runs it (MoshOps.Plugins.cpp cmdLoadPreset).
 *  A numbered `waveShapes` list (the first bank's) is refused, as is a `state` or `params`
 *  that is not an object. Each `state` key must be a 4OSC setting with a valid value (else the
 *  whole preset is refused); each param binds by exact paramID, else to the FIRST parameter
 *  whose name matches case-insensitively (unknown names are reported, not applied). The patch is whole: every param and setting it does not name returns to its
 *  default. `changed` is false when the patch was already loaded (the engine opens no step). */
export function applyFourOscPreset(params: PluginParam[], state: Record<string, PluginStateValue> | undefined,
  preset: FourOscPresetFile): FourOscPresetResult {
  if (preset.waveShapes !== undefined)
    return { error: 'this preset uses the old numbered "waveShapes"; name the waves in "state" instead (waveShape1..4: off|sine|square|saw|triangle|noise)' };
  const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (preset.state !== undefined && !isObject(preset.state)) return { error: '"state" must be an object of 4OSC settings' };
  if (preset.params !== undefined && !isObject(preset.params)) return { error: '"params" must be an object of 4OSC parameter ids or names' };
  const settings: Record<string, number | string> = {};
  for (const [key, raw] of Object.entries(preset.state ?? {})) {
    const spec = FOUR_OSC_STATE[key];
    if (!spec) return { error: `unknown 4OSC setting in "state": ${key} (settings: ${Object.keys(FOUR_OSC_STATE).join(", ")})` };
    const c = coerceSetting(key, spec, raw);
    if ("error" in c) return { error: `4OSC setting ${key}: ${c.error}` };
    settings[key] = c.value;
  }
  const named = new Map<number, number>();
  const unknown: string[] = [];
  let applied = 0;
  for (const [name, value] of Object.entries(preset.params ?? {})) {
    // the paramID first (exact), then the first case-insensitive display name ("Mix" is the reverb's)
    const byId = FOUR_OSC_PARAMS.findIndex((s) => s.id === name);
    const i = byId >= 0 ? byId : FOUR_OSC_PARAMS.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (i < 0) { unknown.push(name); continue; }
    named.set(i, Math.min(1, Math.max(0, value)));
    applied += 1;
  }
  if (applied === 0 && Object.keys(settings).length === 0)
    return { error: "preset matched no 4OSC parameters or settings" + (unknown.length ? ` (unknown: ${unknown.join(", ")})` : "") };

  let reset = 0;
  let changed = false;
  const next = params.map((p) => {
    const spec = FOUR_OSC_PARAMS[p.index];
    if (!spec) return { ...p };
    const norm = named.get(p.index);
    const entry = norm !== undefined ? fourOscSetNorm(p.index, norm) : fourOscParamEntry(p.index, spec.def);
    if (!entry) return { ...p };
    if (entry.value !== p.value) { changed = true; if (norm === undefined) reset += 1; }
    return { ...p, ...entry };
  });
  const nextState: Record<string, PluginStateValue> = {};
  for (const [key, spec] of Object.entries(FOUR_OSC_STATE)) {
    const current = state?.[key] ?? spec;
    const value = key in settings ? settings[key]! : spec.value;
    if (current.value !== value) { changed = true; if (!(key in settings)) reset += 1; }
    nextState[key] = { ...current, value, ...(current.choices ? { choices: [...current.choices] } : {}) };
  }
  return { next, nextState, applied, settingsApplied: Object.keys(settings).length, unknown, reset, changed };
}
