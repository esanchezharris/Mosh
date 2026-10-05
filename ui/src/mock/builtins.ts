// Dev-mock plugin catalog + parameter surfaces, shared by bridge.mock.ts (load_builtin /
// list_builtins) and the seeded sessions (mock/portfolioSeed.ts) so a seeded plugin is
// byte-for-byte what load_builtin would have pushed.
//
// Kept in lockstep with the NATIVE kBuiltins TYPE names (MoshOps.cpp) — the Phase-A agent
// bench caught the drift: the mock accepted "eq" (native rejects it; the real type is
// "4bandEq") and was missing compressor/sampler/chorus/phaser/lowpass/pitchShifter
// entirely, so an agent following the real list_builtins vocabulary failed only in
// dev/e2e. Display names stay the mock's shorter forms where the UI already shows them.
import type { MoshFxReadout, Plugin, PluginParam } from "../types";

export const BUILTINS = [
  { type: "4osc", name: "4OSC", category: "Instruments", isInstrument: true, builtin: true as const },
  { type: "sampler", name: "Sampler", category: "Instruments", isInstrument: true, builtin: true as const },
  { type: "reverb", name: "Reverb", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "delay", name: "Delay", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "4bandEq", name: "4-Band EQ", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "compressor", name: "Compressor", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "chorus", name: "Chorus", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "phaser", name: "Phaser", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "lowpass", name: "Low / High-Pass Filter", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "pitchShifter", name: "Pitch Shifter", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "moshAutoTune", name: "Mosh AutoTune", category: "Mosh FX", isInstrument: false, builtin: true as const },
  { type: "moshOTT", name: "Mosh OTT", category: "Mosh FX", isInstrument: false, builtin: true as const },
  { type: "moshXFeedback", name: "Mosh X-FDBK", category: "Mosh FX", isInstrument: false, builtin: true as const },
  { type: "highpass", name: "High-Pass", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "softclip", name: "Mosh Soft Clipper", category: "Effects", isInstrument: false, builtin: true as const },
];

// Mosh AutoTune's controls as the engine describes them (MoshAutoTunePlugin.cpp): the key
// and the scale are named choices, the rest are ranges that read back in their own units.
type AutoTuneSpec = { name: string; choices?: readonly string[]; min?: number; max?: number; scale?: number; decimals?: number; unit?: string };
const AUTOTUNE_PARAMS: readonly AutoTuneSpec[] = [
  { name: "Key", choices: ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"] },
  { name: "Scale", choices: ["Chromatic", "Major", "Minor"] },
  { name: "Retune speed", min: 5, max: 250, decimals: 0, unit: "ms" },
  { name: "Amount", min: 0, max: 1, scale: 100, decimals: 0, unit: "%" },
  { name: "Range", min: 0, max: 300, decimals: 0, unit: "cents" },
  { name: "Mix", min: 0, max: 1, scale: 100, decimals: 0, unit: "%" },
  { name: "Output", min: -18, max: 6, decimals: 1, unit: "dB" },
  { name: "Glide", min: 0, max: 1, scale: 100, decimals: 0, unit: "%" },
  { name: "Look-ahead", min: 0, max: 12, decimals: 1, unit: "ms" },
];
// C, chromatic, 80 ms, 100 %, 100 cents, 100 %, 0 dB, 100 %, 0 ms: a new plugin's values.
const AUTOTUNE_DEFAULTS = [0, 0, 75 / 245, 1, 1 / 3, 1, 0.75, 1, 0];

/** What a built-in's parameter reads back as at a 0-1 `value`, where the mock knows the
 *  engine's own wording (Mosh AutoTune). Undefined elsewhere: the row shows the number. */
export function builtinParamDisplay(type: string, index: number, value: number): string | undefined {
  if (type !== "moshAutoTune") return undefined;
  const spec = AUTOTUNE_PARAMS[index];
  if (!spec) return undefined;
  const v = Math.min(1, Math.max(0, value));
  if (spec.choices) return spec.choices[Math.round(v * (spec.choices.length - 1))];
  const physical = (spec.min ?? 0) + v * ((spec.max ?? 1) - (spec.min ?? 0));
  return `${(physical * (spec.scale ?? 1)).toFixed(spec.decimals ?? 0)} ${spec.unit ?? ""}`.trim();
}

export function mkParams(n: number): PluginParam[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, name: ["Drive", "Tone", "Mix", "Decay", "Size", "Rate", "Depth", "Gain"][i] ?? `P${i}`, value: 0.5 }));
}
function params(names: string[], values: number[]): PluginParam[] {
  return names.map((name, index) => ({ index, name, value: values[index] ?? 0.5 }));
}
export function mkBuiltinParams(type: string, isInstrument: boolean): PluginParam[] {
  // The built-in 4OSC exposes a small patch surface (native load_preset reports paramsApplied: 8),
  // so a preset's effect is observable here as it is in the engine. Other instruments stay bare.
  if (isInstrument) return type === "4osc"
    ? params(["Osc 1 Level", "Osc 2 Level", "Cutoff", "Resonance", "Attack", "Decay", "Sustain", "Release"], [0.8, 0.5, 0.6, 0.2, 0.05, 0.3, 0.7, 0.25])
    : [];
  if (type === "moshAutoTune") return AUTOTUNE_PARAMS.map((spec, index) => {
    const value = AUTOTUNE_DEFAULTS[index];
    return {
      index, name: spec.name, value, display: builtinParamDisplay(type, index, value),
      ...(spec.choices ? { discrete: true, states: spec.choices.length, choices: [...spec.choices] } : {}),
    };
  });
  if (type === "moshOTT") return params(["Amount", "Time", "Low Gain", "Mid Gain", "High Gain", "Mix", "Output"], [0.12, 0.24, 0.5, 0.5, 0.5, 1, 0.71]);
  if (type === "moshXFeedback") return params(["Sensitivity", "Max Cuts", "Max Depth", "Release", "Auto Suppress", "Mix", "Output"], [0.62, 0.5, 0.55, 0.38, 1, 0.8, 0.5]);
  if (type === "highpass") return params(["Frequency"], [0.34]);   // 180 Hz within the 10-22000 Hz native range
  if (type === "softclip") return params(["Drive", "Ceiling"], [0.25, 0.958]);   // 6 dB drive, -0.5 dBFS ceiling
  // The engine's own parameter display names (tracktion_engine plugins/effects), so the
  // inspector's first rows read as the real device does — not a generic Drive/Tone/Mix.
  if (type === "compressor") return params(["Threshold", "Ratio", "Attack", "Release", "Output gain"], [0.62, 0.35, 0.18, 0.4, 0.5]);
  if (type === "4bandEq") return params(
    ["Low-shelf freq", "Low-shelf gain", "Low-shelf Q", "Mid freq 1", "Mid gain 1", "Mid Q 1", "Mid freq 2", "Mid gain 2", "Mid Q 2", "High-shelf freq", "High-shelf gain", "High-shelf Q"],
    [0.18, 0.44, 0.5, 0.36, 0.5, 0.5, 0.62, 0.56, 0.5, 0.82, 0.58, 0.5]);
  if (type === "reverb") return params(["Room Size", "Damping", "Wet Level", "Dry Level", "Width"], [0.55, 0.4, 0.3, 0.7, 1]);
  if (type === "delay") return params(["Feedback", "Mix proportion"], [0.35, 0.25]);
  return mkParams(4);
}
export function mkMoshFx(type: string): MoshFxReadout | undefined {
  if (type === "moshAutoTune") return { kind: "autotune", inputHz: 449.0, targetHz: 440.0, correctionCents: -34.4, confidence: 0.91 };
  if (type === "moshOTT") return { kind: "ott", amount: 0.12, timeMs: 120.0 };
  if (type !== "moshXFeedback") return undefined;
  return {
    kind: "feedback",
    candidates: [
      { frequencyHz: 1260, score: 0.82, depthDb: 5.5 },
      { frequencyHz: 2510, score: 0.74, depthDb: 4.2 },
      { frequencyHz: 3875, score: 0.61, depthDb: 3.4 },
    ],
    activeCuts: [],
  };
}

/** The Plugin entry load_builtin pushes for `type` at chain position `index` (or null for
 *  an unknown type). Seeds use this so their chains are exactly what the command would build. */
export function builtinPlugin(type: string, index: number): Plugin | null {
  const b = BUILTINS.find((x) => x.type === type);
  if (!b) return null;
  return { index, name: b.name, type: b.type, enabled: true, external: false, builtin: true, category: b.category, isInstrument: b.isInstrument, params: mkBuiltinParams(b.type, b.isInstrument), moshFx: mkMoshFx(b.type) };
}
