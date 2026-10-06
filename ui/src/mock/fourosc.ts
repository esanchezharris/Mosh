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
// bridge.mock.fourosc.test.ts reads the real files and fails if this copy drifts.
export type FourOscPresetFile = { waveShapes: number[]; params: Record<string, number> };
export const FOUR_OSC_PRESETS: Record<string, FourOscPresetFile> = {
  "mosh-bass": {
    waveShapes: [4, 5, 0, 0],
    params: {
      "Level 1": 0.85, "Level 2": 0.7, "Tune 2": 0.5, "Detune 1": 0.12, "Amp Attack": 0.0, "Amp Decay": 0.35,
      "Amp Sustain": 0.8, "Amp Release": 0.18, "Filter Freq": 0.38, "Filter Resonance": 0.3, "Filter Amount": 0.6,
      "Filter Attack": 0.0, "Filter Decay": 0.35, "Filter Sustain": 0.3, "Filter Release": 0.2, "Level 3": 0.0, "Level 4": 0.0,
    },
  },
  "mosh-keys": {
    waveShapes: [1, 2, 0, 0],
    params: {
      "Level 1": 0.8, "Level 2": 0.55, "Tune 2": 0.75, "Amp Attack": 0.04, "Amp Decay": 0.45, "Amp Sustain": 0.6,
      "Amp Release": 0.4, "Filter Freq": 0.7, "Filter Resonance": 0.1, "Level 3": 0.0, "Level 4": 0.0,
    },
  },
  "mosh-lead": {
    waveShapes: [3, 3, 0, 0],
    params: {
      "Level 1": 0.8, "Level 2": 0.75, "Detune 1": 0.25, "Detune 2": 0.35, "Amp Attack": 0.02, "Amp Decay": 0.3,
      "Amp Sustain": 0.75, "Amp Release": 0.3, "Filter Freq": 0.8, "Filter Resonance": 0.25, "Level 3": 0.0, "Level 4": 0.0,
    },
  },
  "mosh-pad": {
    waveShapes: [2, 3, 0, 0],
    params: {
      "Level 1": 0.75, "Level 2": 0.65, "Detune 2": 0.4, "Spread": 0.7, "Amp Attack": 0.5, "Amp Decay": 0.5,
      "Amp Sustain": 0.9, "Amp Release": 0.8, "Filter Freq": 0.55, "Filter Resonance": 0.15, "Level 3": 0.0, "Level 4": 0.0,
    },
  },
  "mosh-pluck": {
    waveShapes: [5, 0, 0, 0],
    params: {
      "Level 1": 0.85, "Pulse Width 1": 0.35, "Amp Attack": 0.0, "Amp Decay": 0.22, "Amp Sustain": 0.0,
      "Amp Release": 0.15, "Filter Freq": 0.45, "Filter Resonance": 0.35, "Filter Amount": 0.85, "Filter Attack": 0.0,
      "Filter Decay": 0.2, "Filter Sustain": 0.0, "Filter Release": 0.15, "Level 2": 0.0, "Level 3": 0.0, "Level 4": 0.0,
    },
  },
};

/** load_preset's .json branch, as the engine runs it (MoshOps.Plugins.cpp cmdLoadPreset):
 *  each named param binds to the FIRST parameter whose name matches case-insensitively, its
 *  normalised value clamped and mapped through the range; names that match nothing are
 *  reported, not applied. The file's `waveShapes` are NOT applied: the engine writes them
 *  onto child trees FourOsc never reads (a known bug, owner-gated), so the mock does not
 *  pretend they land either. */
export function applyFourOscPreset(params: PluginParam[], preset: FourOscPresetFile): {
  next: PluginParam[]; applied: number; unknown: string[];
} {
  const next = params.map((p) => ({ ...p }));
  let applied = 0;
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(preset.params)) {
    const i = FOUR_OSC_PARAMS.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (i < 0) { unknown.push(name); continue; }
    const entry = fourOscSetNorm(i, value);
    const at = next.findIndex((p) => p.index === i);
    if (entry && at >= 0) next[at] = { ...next[at], ...entry };
    applied += 1;
  }
  return { next, applied, unknown };
}
