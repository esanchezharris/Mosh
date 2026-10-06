// Tracktion DelayPlugin, unpatched (research key "delay", tracktion_Delay.cpp:61-100).
// Pure view maths for the delay panel:
//   fbDb = -30 + 30·v0;  loop gain g = fbDb > -30 ? 10^(fbDb/20) : 0   (.cpp:16, 68-69)
//   wet = sin(v1·π/2), dry = sin((1−v1)·π/2)   (convex crossfade, .cpp:71, 90)
//   L = (int)(lengthMs·sr/1000) samples        (.cpp:73; whole ms, no interpolation)
//   y[n] = dry·x[n] + wet·Σ_{k≥1} g^(k−1)·x[n−kL]
// so the impulse response is a dry stem at 0 and wet taps at k·L/sr whose level is
// 20·log10(wet) + (k−1)·fbDb dB. At the bottom of the Feedback range the loop is OFF (one
// echo); at 0 dB nothing in the loop limits it (the echoes never decay).
import type { Plugin } from "../../types";
import { clamp, param, physOf, stateNum } from "./params";

export const FEEDBACK = { min: -30, max: 0 } as const;
export const MIX = { min: 0, max: 1 } as const;
export const TIME = { min: 1, max: 2000, def: 150 } as const;
export const DEFAULTS = { feedbackDb: -6, mix: 0.3, lengthMs: 150 } as const;
/** The echo strip's floor and the most taps it draws. */
export const FLOOR_DB = -60;
export const MAX_TAPS = 64;
/** The longest view of the strip, in ms. */
export const MAX_VIEW_MS = 4000;

export const loopGainOf = (fbDb: number): number => (fbDb > FEEDBACK.min ? 10 ** (fbDb / 20) : 0);
export const wetGainOf = (mix: number): number => Math.sin((clamp(mix, 0, 1) * Math.PI) / 2);
export const dryGainOf = (mix: number): number => Math.sin(((1 - clamp(mix, 0, 1)) * Math.PI) / 2);
const db = (gain: number): number => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

/** Whole milliseconds within 1..2000, as set_plugin_state stores lengthMs. For values SENT. */
export const clampMs = (ms: number): number => (Number.isFinite(ms) ? clamp(Math.round(ms), TIME.min, TIME.max) : TIME.def);
/** The engine's reported lengthMs as it runs: whole ms, at least 1, but NOT capped at 2000.
 *  A loaded edit can hold more (the plugin restores lengthMs without clamping), and the
 *  panel must show that truthfully and still be able to set 2000. */
export const engineMs = (ms: number): number => (Number.isFinite(ms) ? Math.max(TIME.min, Math.round(ms)) : TIME.def);

/** The engine's delay in samples and the echo period it gives (seconds). */
export function periodOf(lengthMs: number, fs: number): { samples: number; seconds: number } {
  const rate = fs > 0 ? fs : 48000;
  const samples = Math.max(1, Math.floor((lengthMs * rate) / 1000));
  return { samples, seconds: samples / rate };
}

export type Tap = { k: number; ms: number; db: number };

export type DelayModel = {
  lengthMs: number; periodMs: number;
  feedbackDb: number; mix: number;
  /** The loop is off: exactly one echo (Feedback at its -30 dB bottom). */
  oneRepeat: boolean;
  /** Feedback at 0 dB: the echoes never decay. */
  infinite: boolean;
  wetDb: number; dryDb: number;
  /** The wet taps at or above FLOOR_DB (at most MAX_TAPS). */
  taps: Tap[];
  /** Seconds for the echoes to fall 60 dB; null with the loop off, Infinity at 0 dB. */
  tailS: number | null;
};

/** Everything the panel shows. `over` replaces values being dragged. */
export function delayModel(plugin: Plugin, fs: number, over: { feedbackDb?: number; mix?: number; lengthMs?: number } = {}): DelayModel {
  const feedbackDb = over.feedbackDb ?? physOf(param(plugin, 0), FEEDBACK);
  const mix = over.mix ?? physOf(param(plugin, 1), MIX);
  const lengthMs = over.lengthMs !== undefined ? clampMs(over.lengthMs) : engineMs(stateNum(plugin, "lengthMs", TIME.def));
  const periodMs = periodOf(lengthMs, fs).seconds * 1000;
  const g = loopGainOf(feedbackDb);
  const wetDb = db(wetGainOf(mix)), dryDb = db(dryGainOf(mix));
  const oneRepeat = g === 0, infinite = feedbackDb >= FEEDBACK.max;
  const taps: Tap[] = [];
  if (Number.isFinite(wetDb)) {
    for (let k = 1; k <= MAX_TAPS; k += 1) {
      const level = wetDb + (k - 1) * feedbackDb;
      if (level < FLOOR_DB || (oneRepeat && k > 1)) break;
      taps.push({ k, ms: k * periodMs, db: level });
    }
  }
  const tailS = oneRepeat ? null : infinite ? Infinity : (periodMs / 1000) * (60 / -feedbackDb);
  return { lengthMs, periodMs, feedbackDb, mix, oneRepeat, infinite, wetDb, dryDb, taps, tailS };
}

/** The strip's time span (ms): the drawn taps plus a little room, never fewer than two
 *  periods (so the second-repeat handle is always on the strip), at most 4 s. */
export const viewMs = (m: DelayModel): number =>
  Math.min(MAX_VIEW_MS, (Math.max(m.taps.length, 2) + 0.6) * m.periodMs);

// ── the time control ───────────────────────────────────────────────────────────────────

/** A horizontal drag on the time read-out: 60 px doubles or halves it (240 px with Shift). */
export const timeFromDrag = (startMs: number, dx: number, fine = false): number =>
  clampMs(startMs * 2 ** (dx / (fine ? 240 : 60)));

/** Keys on the time control: arrows ±1 ms (Shift ±10), PageUp/Down double/halve, Home/End. */
export function timeKey(ms: number, key: string, shift = false): number | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowUp": case "ArrowRight": return clampMs(ms + step);
    case "ArrowDown": case "ArrowLeft": return clampMs(ms - step);
    case "PageUp": return clampMs(ms * 2);
    case "PageDown": return clampMs(ms / 2);
    case "Home": return TIME.min;
    case "End": return TIME.max;
    default: return null;
  }
}

/** Note values the time can be SET from (a one-off ms value; not tempo sync). */
export const NOTES = [
  { label: "1/2", beats: 2 }, { label: "1/4.", beats: 1.5 }, { label: "1/4", beats: 1 }, { label: "1/4T", beats: 2 / 3 },
  { label: "1/8.", beats: 0.75 }, { label: "1/8", beats: 0.5 }, { label: "1/8T", beats: 1 / 3 }, { label: "1/16", beats: 0.25 },
] as const;

export const noteMs = (beats: number, bpm: number): number => Math.round((beats * 60000) / bpm);

/** The note value the current time equals at this tempo (to the whole ms), if any. */
export function matchingNote(ms: number, bpm: number): string | null {
  if (!(bpm > 0)) return null;
  return NOTES.find((n) => noteMs(n.beats, bpm) === ms)?.label ?? null;
}

// ── read-outs ──────────────────────────────────────────────────────────────────────────

export const fmtTime = (ms: number): string => `${Math.round(ms)} ms`;
export const fmtMix = (mix: number): string => `${Math.round(clamp(mix, 0, 1) * 100)}% wet`;

/** "1.5 s", "12 s", "> 60 s", "∞". */
export function fmtTail(s: number | null): string {
  if (s === null) return "–";
  if (!Number.isFinite(s)) return "∞";
  if (s > 60) return "> 60 s";
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** The Feedback dial's read-out. */
export function fmtFeedback(m: Pick<DelayModel, "oneRepeat" | "infinite" | "feedbackDb">): string {
  if (m.oneRepeat) return "1 repeat";
  if (m.infinite) return "∞ 0 dB";
  return `${m.feedbackDb.toFixed(1)} dB`;
}

/** What the echoes do, in words: "-60 dB in 1.5 s", "1 repeat", "∞ repeats". */
export function tailText(m: DelayModel): string {
  if (m.taps.length === 0) return "no echo (dry only)";
  if (m.oneRepeat) return "1 repeat";
  if (m.infinite) return "∞ repeats, no decay";
  return `-60 dB in ${fmtTail(m.tailS)}`;
}

/** The minimized line, e.g. "150 ms · -6.0 dB (1.5 s) · 30% wet": time, feedback with the
 *  time the echoes take to fall 60 dB, and the mix. */
export function delaySummary(plugin: Plugin, fs = 48000): string {
  const m = delayModel(plugin, fs);
  if (m.taps.length === 0) return "dry only";
  const echo = m.oneRepeat ? "1 repeat" : m.infinite ? "∞ repeats" : `${m.feedbackDb.toFixed(1)} dB (${fmtTail(m.tailS)})`;
  return `${fmtTime(m.lengthMs)} · ${echo} · ${fmtMix(m.mix)}`;
}
