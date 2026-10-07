// Tracktion's ChorusPlugin, as numbers the panel draws (tracktion_Chorus.cpp; research key
// "chorus+phaser"). It has NO automatable parameters: every setting is a CachedValue that
// the snapshot carries in `plugin.state` (physical units) and set_plugin_state writes.
//
// DSP, per channel: a delay line with a fixed 20 ms base whose read point sweeps
//   delay_ms(t) = 20 + depthMs/2 · (1 + sin φ),  φ advancing 2π·speedHz/fs per sample,
// the right channel's φ offset by π·width (tracktion_Chorus.cpp:56-59, 66-67, 78-80, 88),
// then out = wet·sin(mix·π/2) + dry·cos(mix·π/2) (:69, :104). Feedback is fixed at 0 (:65).
import type { Plugin } from "../../types";
import { clamp, fmtMs, normOf, physOf, stateNum, type Range } from "./params";

export const CHORUS_BASE_MS = 20;

export type ChorusKey = "speedHz" | "depthMs" | "width" | "mix";
/** The engine's defaults (tracktion_Chorus.cpp:18-21) and the contract's ranges/steps. */
export const CHORUS_SPEC: Record<ChorusKey, { def: number; range: Range; step: number }> = {
  speedHz: { def: 1, range: { min: 0.1, max: 10 }, step: 0.01 },
  depthMs: { def: 3, range: { min: 0.1, max: 20 }, step: 0.1 },
  width: { def: 0.5, range: { min: 0, max: 1 }, step: 0.01 },
  mix: { def: 0.5, range: { min: 0, max: 1 }, step: 0.01 },
};

export type ChorusSettings = Record<ChorusKey, number>;

// ── state settings as dial positions (shared with the phaser) ───────────────────────────

/** Can this engine set `key`? An engine that predates set_plugin_state publishes no
 *  `plugin.state`: its controls are shown (the engine defaults are what an old session
 *  holds) but disabled, and nothing is sent. */
export const stateSettable = (plugin: Plugin, key: string): boolean => plugin.state?.[key] !== undefined;

/** The one line a panel shows when some of its settings cannot be set by this engine. */
export const NEEDS_ENGINE = "needs the updated Mosh engine";

/** A state setting's physical range: the engine's min/max when sent, else the fallback. */
export function stateRange(plugin: Plugin, key: string, fallback: Range): Range {
  const s = plugin.state?.[key];
  const min = typeof s?.min === "number" ? s.min : fallback.min;
  const max = typeof s?.max === "number" ? s.max : fallback.max;
  return max > min ? { min, max } : fallback;
}

const decimalsOf = (step: number): number => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));

/** The physical value a 0-1 dial position stands for (linear, via params.ts), rounded to
 *  the setting's step and kept inside its range. This is what set_plugin_state is sent. */
export function stateValueAt(norm: number, range: Range, step: number): number {
  const phys = physOf({ index: -1, name: "", value: norm }, range);
  const snapped = clamp(Math.round(phys / step) * step, range.min, range.max);
  return Number(snapped.toFixed(decimalsOf(step)));
}

/** The dial position (0-1) of a physical value. */
export const stateNormOf = (value: number, range: Range): number => normOf(undefined, value, range);

/** Snap a dial position so it always lands on a whole step of the physical value. */
export const stateQuantizer = (range: Range, step: number) => (norm: number): number =>
  stateNormOf(stateValueAt(norm, range, step), range);

/** How many whole steps a key moves a state setting, or null for a key the dial keeps
 *  (Home/End). Shift is fine: exactly one step. Arrows move 1% of the range and PageUp/Down
 *  10%, rounded to whole steps and never less than one. (The framework dial's own fine
 *  steps are smaller than one step on most settings, so they would snap back and do nothing.) */
export function stateKeySteps(key: string, shift: boolean, range: Range, step: number): number | null {
  const unit = (frac: number) => Math.max(1, Math.round((frac * (range.max - range.min)) / step));
  switch (key) {
    case "ArrowUp": case "ArrowRight": return shift ? 1 : unit(0.01);
    case "ArrowDown": case "ArrowLeft": return shift ? -1 : -unit(0.01);
    case "PageUp": return unit(0.1);
    case "PageDown": return -unit(0.1);
    default: return null;
  }
}

/** A physical value moved by `steps` whole steps, landing on a step, inside the range. */
export function stateStep(value: number, steps: number, range: Range, step: number): number {
  const v = clamp(Math.round(value / step + steps) * step, range.min, range.max);
  return Number(v.toFixed(decimalsOf(step)));
}

// ── chorus maths ──────────────────────────────────────────────────────────────────────

export function chorusSettings(plugin: Plugin): ChorusSettings {
  // The snapshot's values as they are (the engine clamps what it is sent; an imported edit
  // is drawn as it is, not as a range would wish it to be).
  const n = (k: ChorusKey) => stateNum(plugin, k, CHORUS_SPEC[k].def);
  return { speedHz: n("speedHz"), depthMs: n("depthMs"), width: n("width"), mix: n("mix") };
}

/** The delay (ms) at LFO phase φ (radians). */
export const chorusDelayMs = (depthMs: number, phaseRad: number): number =>
  CHORUS_BASE_MS + (depthMs / 2) * (1 + Math.sin(phaseRad));

/** The right channel's phase lead over the left, in cycles (π·width rad = width/2 cycles). */
export const rightPhaseOffset = (width: number): number => width / 2;

/** The wet voice's peak pitch deviation, in cents, up and down. The read point moves at
 *  d'(t) = π·speedHz·depth·cos φ (depth in s), so the pitch ratio is 1 − d'(t). */
export function chorusWobbleCents(speedHz: number, depthMs: number): { up: number; down: number } {
  const x = Math.PI * speedHz * (depthMs / 1000);
  return { up: 1200 * Math.log2(1 + x), down: x < 1 ? 1200 * Math.log2(1 - x) : -Infinity };
}

/** "±16 ¢" when both directions round alike, else "+849/-1702 ¢". */
export function fmtWobble(w: { up: number; down: number }): string {
  const up = Math.round(w.up), down = Math.round(-w.down);
  if (up === down) return `±${up} ¢`;
  return `+${up}/-${Number.isFinite(down) ? down : "∞"} ¢`;
}

/** The delay lane's y-axis span above the 20 ms base: the smallest of 1, 2, 5, 10, 20 ms
 *  that holds the sweep, so the curve's height reads as depth against a labelled axis. */
export function chorusLaneSpan(depthMs: number): number {
  for (const s of [1, 2, 5, 10, 20]) if (depthMs <= s + 1e-9) return s;
  return Math.ceil(depthMs);
}

/** The depth (and the delay it reaches) at the dial's 0.1 ms resolution: "3.0 ms", "12.4 ms". */
export const fmtDepthMs = (ms: number): string => (Number.isFinite(ms) ? `${ms.toFixed(1)} ms` : "–");

/** "1.00 Hz", "0.40 Hz", "10.0 Hz". */
export const fmtRate = (hz: number): string => `${hz >= 10 ? hz.toFixed(1) : hz.toFixed(2)} Hz`;

/** "1.00 s", "250 ms": one LFO period. */
export const fmtPeriod = (hz: number): string => (hz > 0 ? fmtMs(1000 / hz) : "–");

export const widthDegrees = (width: number): number => Math.round(width * 180);

/** The minimized row's summary budget: its slot is 97 px of 10 px monospace (6.0 px a
 *  character), so 16 characters fit whole. */
export const SUMMARY_CHARS = 16;

/** A number at most `decimals` places, trailing zeros dropped: 2.50 → "2.5", 20.0 → "20". */
export const trimNum = (v: number, decimals: number): string => String(Number(v.toFixed(decimals)));

/** The first line that fits the minimized row, else the last (callers make the last fit). */
export const firstThatFits = (lines: string[]): string => lines.find((l) => l.length <= SUMMARY_CHARS) ?? lines[lines.length - 1];

/** One short line for the minimized header, most telling first: rate and depth,
 *  "1.00 Hz · 3.0 ms"; "dry · 1.00 Hz" at mix 0 (all dry: nothing else matters). Mix and
 *  width are left to the panel. Where the exact figures are too long, trailing zeros go
 *  ("2.98 Hz · 20 ms"), then the depth is rounded and marked ("0.25 Hz · ~12 ms"). */
export function chorusSummary(plugin: Plugin): string {
  const s = chorusSettings(plugin);
  if (s.mix <= 0) return `dry · ${fmtRate(s.speedHz)}`;
  const rate = trimNum(s.speedHz, s.speedHz >= 10 ? 1 : 2);
  return firstThatFits([
    `${fmtRate(s.speedHz)} · ${fmtDepthMs(s.depthMs)}`,
    `${rate} Hz · ${trimNum(s.depthMs, 1)} ms`,
    `${rate} Hz · ~${Math.round(s.depthMs)} ms`,
  ]);
}
