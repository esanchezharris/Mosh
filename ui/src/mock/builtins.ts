// Dev-mock plugin catalog + parameter surfaces, shared by bridge.mock.ts (load_builtin /
// list_builtins) and the seeded sessions (mock/portfolioSeed.ts) so a seeded plugin is
// byte-for-byte what load_builtin would have pushed.
//
// Kept in lockstep with the NATIVE kBuiltins TYPE names (MoshOps.cpp) — the Phase-A agent
// bench caught the drift: the mock accepted "eq" (native rejects it; the real type is
// "4bandEq") and was missing compressor/sampler/chorus/phaser/lowpass/pitchShifter
// entirely, so an agent following the real list_builtins vocabulary failed only in
// dev/e2e. Display names stay the mock's shorter forms where the UI already shows them.
import type { MoshFxReadout, Plugin, PluginParam, PluginStateValue } from "../types";

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
  const native = NATIVE[type]?.[index];
  if (native) return native.fmt(native.min + Math.min(1, Math.max(0, value)) * (native.max - native.min));
  if (type !== "moshAutoTune") return undefined;
  const spec = AUTOTUNE_PARAMS[index];
  if (!spec) return undefined;
  const v = Math.min(1, Math.max(0, value));
  if (spec.choices) return spec.choices[Math.round(v * (spec.choices.length - 1))];
  const physical = (spec.min ?? 0) + v * ((spec.max ?? 1) - (spec.min ?? 0));
  return `${(physical * (spec.scale ?? 1)).toFixed(spec.decimals ?? 0)} ${spec.unit ?? ""}`.trim();
}

// ── Native-accurate parameter surfaces for the effects with panels ─────────────────────
// Names, order, ranges, defaults and read-out strings as the engine sends them (Tracktion
// plugins/effects/*, src/plugins/moshfx/*; research 2026-10-05), and min/max exactly where
// the engine publishes them (src/moshops/MoshOps.cpp pluginParameterPhysicalRange: never
// for the compressor's threshold and ratio).
const dbStr = (db: number): string => (db <= -100 ? "-INF dB" : `${db >= 0 ? "+" : ""}${db.toFixed(2)} dB`);
const gainDbStr = (gain: number): string => (gain <= 0 ? "-INF dB" : dbStr(20 * Math.log10(gain)));
const num3 = (v: number): string => v.toFixed(3);
const hzStr = (v: number): string => `${Math.round(v)} Hz`;
function semitonesStr(v: number): string {
  if (Math.abs(v) < 0.01) return "(Original pitch)";
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  return `${v > 0 ? "+" : ""}${whole ? Math.round(v) : v.toFixed(2)} semitones`;
}

type NativeParam = { name: string; min: number; max: number; def: number; fmt: (phys: number) => string; minmax?: boolean };
const EQ_BAND = (label: string, freq: number, gainName: string, qName: string): NativeParam[] => [
  { name: label, min: 20, max: 20000, def: freq, fmt: hzStr, minmax: true },
  { name: gainName, min: -20, max: 20, def: 0, fmt: dbStr, minmax: true },
  { name: qName, min: 0.1, max: 4, def: 0.5, fmt: (v) => v.toFixed(3), minmax: true },
];
const NATIVE: Record<string, NativeParam[]> = {
  "4bandEq": [
    ...EQ_BAND("Low-shelf freq", 80, "Low-shelf gain", "Low-shelf Q"),
    ...EQ_BAND("Mid freq 1", 3000, "Mid gain 1", "Mid Q 1"),
    ...EQ_BAND("Mid freq 2", 5000, "Mid gain 2", "Mid Q 2"),
    ...EQ_BAND("High-shelf freq", 17000, "High-shelf gain", "High-shelf Q"),
  ],
  compressor: [
    { name: "Threshold", min: 0.01, max: 1, def: 10 ** (-6 / 20), fmt: gainDbStr },
    { name: "Ratio", min: 0, max: 0.95, def: 0.5, fmt: (v) => (v <= 0.001 ? "INF : 1" : `${(1 / v).toFixed(2)} : 1`) },
    { name: "Attack", min: 0.3, max: 200, def: 100, fmt: (v) => `${v.toFixed(1)} ms`, minmax: true },
    { name: "Release", min: 10, max: 300, def: 100, fmt: (v) => `${v.toFixed(1)} ms`, minmax: true },
    { name: "Output gain", min: -10, max: 24, def: 0, fmt: dbStr, minmax: true },
    { name: "Sidechain gain", min: -24, max: 24, def: 0, fmt: dbStr, minmax: true },
  ],
  reverb: [
    { name: "Room Size", min: 0, max: 1, def: 0.3, fmt: (v) => `${1 + Math.floor(10 * v)}` },
    { name: "Damping", min: 0, max: 1, def: 0.5, fmt: (v) => `${Math.floor(100 * v)}%` },
    { name: "Wet Level", min: 0, max: 1, def: 1 / 3, fmt: (v) => gainDbStr(3 * v) },
    { name: "Dry Level", min: 0, max: 1, def: 0.5, fmt: (v) => gainDbStr(2 * v) },
    { name: "Width", min: 0, max: 1, def: 1, fmt: (v) => `${Math.floor(100 * v)}%` },
    { name: "Freeze", min: 0, max: 1, def: 0, fmt: (v) => (v >= 0.5 ? "On" : "Off") },
  ],
  delay: [
    { name: "Feedback", min: -30, max: 0, def: -6, fmt: dbStr, minmax: true },
    { name: "Mix proportion", min: 0, max: 1, def: 0.3, fmt: (v) => `${Math.round(v * 100)}% wet`, minmax: true },
  ],
  lowpass: [{ name: "Frequency", min: 10, max: 22000, def: 4000, fmt: hzStr, minmax: true }],
  highpass: [{ name: "Frequency", min: 10, max: 22000, def: 180, fmt: hzStr, minmax: true }],
  pitchShifter: [{ name: "Semitones", min: -24, max: 24, def: 0, fmt: semitonesStr, minmax: true }],
  softclip: [
    { name: "Drive", min: 0, max: 24, def: 6, fmt: num3, minmax: true },
    { name: "Ceiling", min: -12, max: 0, def: -0.5, fmt: num3, minmax: true },
  ],
  moshOTT: [
    { name: "Amount", min: 0, max: 1, def: 0.12, fmt: num3, minmax: true },
    { name: "Time", min: 5, max: 500, def: 120, fmt: num3, minmax: true },
    { name: "Low Gain", min: -12, max: 12, def: 0, fmt: num3, minmax: true },
    { name: "Mid Gain", min: -12, max: 12, def: 0, fmt: num3, minmax: true },
    { name: "High Gain", min: -12, max: 12, def: 0, fmt: num3, minmax: true },
    { name: "Mix", min: 0, max: 1, def: 1, fmt: num3, minmax: true },
    { name: "Output", min: -18, max: 6, def: -1, fmt: num3, minmax: true },
  ],
  moshXFeedback: [
    { name: "Sensitivity", min: 0, max: 1, def: 0.65, fmt: num3, minmax: true },
    { name: "Max Cuts", min: 1, max: 4, def: 2, fmt: num3, minmax: true },
    { name: "Max Depth", min: 3, max: 36, def: 18, fmt: num3, minmax: true },
    { name: "Release", min: 50, max: 3000, def: 500, fmt: num3, minmax: true },
    { name: "Auto Suppress", min: 0, max: 1, def: 0, fmt: num3, minmax: true },
    { name: "Mix", min: 0, max: 1, def: 1, fmt: num3, minmax: true },
    { name: "Output", min: -18, max: 6, def: 0, fmt: num3, minmax: true },
  ],
  // Chorus and phaser have NO automatable parameters: everything is in `state`.
  chorus: [],
  phaser: [],
};

function nativeParams(type: string): PluginParam[] | null {
  const spec = NATIVE[type];
  if (!spec) return null;
  return spec.map((q, index) => ({
    index, name: q.name, value: (q.def - q.min) / (q.max - q.min), display: q.fmt(q.def),
    ...(q.minmax ? { min: q.min, max: q.max } : {}),
  }));
}

/** The engine's `state` for a built-in: settings that are not automatable parameters
 *  (contract: delay length, chorus/phaser settings, the low/high-pass mode). */
export const STATE_SPECS: Record<string, Record<string, PluginStateValue>> = {
  delay: { lengthMs: { value: 150, min: 1, max: 2000, step: 1, unit: "ms" } },
  chorus: {
    depthMs: { value: 3, min: 0.1, max: 20, unit: "ms" },
    speedHz: { value: 1, min: 0.1, max: 10, unit: "Hz" },
    width: { value: 0.5, min: 0, max: 1 },
    mix: { value: 0.5, min: 0, max: 1 },
  },
  phaser: {
    depth: { value: 5, min: 0, max: 8, unit: "oct" },
    rate: { value: 0.4, min: 0.05, max: 10, unit: "Hz" },
    feedback: { value: 0.7, min: -0.95, max: 0.95 },
  },
  lowpass: { mode: { value: "lowpass", choices: ["lowpass", "highpass"] } },
  highpass: { mode: { value: "highpass", choices: ["lowpass", "highpass"] } },
};

export function mkBuiltinState(type: string): Record<string, PluginStateValue> | undefined {
  const spec = STATE_SPECS[type];
  if (!spec) return undefined;
  return Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, { ...v, ...(v.choices ? { choices: [...v.choices] } : {}) }]));
}

let mockItemSerial = 0;
/** A fresh mock plugin id, standing in for the engine's EditItemID. */
export function nextMockItemId(): string {
  mockItemSerial += 1;
  return `m${mockItemSerial}`;
}

/** Set a seeded plugin's parameter in physical units (keeps value and display consistent). */
export function setPhysical(plugin: Plugin, index: number, phys: number): void {
  const q = NATIVE[plugin.type]?.[index];
  const p = plugin.params.find((x) => x.index === index);
  if (!q || !p) return;
  p.value = Math.min(1, Math.max(0, (phys - q.min) / (q.max - q.min)));
  p.display = q.fmt(q.min + p.value * (q.max - q.min));
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
  const native = nativeParams(type);
  if (native) return native;
  return mkParams(4);
}
export function mkMoshFx(type: string): MoshFxReadout | undefined {
  if (type === "moshAutoTune") return { kind: "autotune", inputHz: 449.0, targetHz: 440.0, correctionCents: -34.4, confidence: 0.91 };
  if (type === "moshOTT") return { kind: "ott", amount: 0.12, timeMs: 120.0 };
  if (type === "softclip") return { kind: "softclip" };
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
  return mkBuiltinPlugin(b, index);
}

/** The plugin entry for a catalog built-in at chain position `index`, with a fresh id. */
export function mkBuiltinPlugin(b: (typeof BUILTINS)[number], index: number): Plugin {
  const state = mkBuiltinState(b.type);
  return {
    index, name: b.name, type: b.type, enabled: true, external: false, builtin: true, category: b.category,
    isInstrument: b.isInstrument, params: mkBuiltinParams(b.type, b.isInstrument), moshFx: mkMoshFx(b.type),
    itemId: nextMockItemId(), ...(state ? { state } : {}),
  };
}
