// Tracktion's PitchShiftPlugin, as numbers the panel shows (tracktion_PitchShift.cpp;
// research key "pitchShifter"). One automatable parameter, index 0 "Semitones", linear on
// -24..+24 (addParam {-24, 24}, :129-135): semitones = -24 + 48·v, so +7 st is v = 31/48.
// The ratio is 2^(st/12) (tracktion_Pitch.h:79-85). The interval names are UI-side music
// theory, not an engine claim.
import type { Plugin } from "../../types";
import { clamp, normOf, param, physOf, type Range } from "./params";

export const SEMITONES_PARAM = 0;
export const PITCH_RANGE: Range = { min: -24, max: 24 };
/** One-click settings. */
export const PITCH_CHIPS = [-12, -7, -5, 0, 5, 7, 12] as const;
/** SoundTouch primes its output FIFO with getMaxFramesNeeded() = 8192 samples of silence
 *  (tracktion_TimeStretch.cpp:520-524; tracktion_PitchShift.cpp:42, 51). */
export const PITCH_LATENCY_SAMPLES = 8192;

/** The setting in semitones (physical), from the snapshot's normalised value. */
export const semitonesOf = (plugin: Plugin): number => physOf(param(plugin, SEMITONES_PARAM), PITCH_RANGE);

/** The normalised value set_plugin_param is sent for a number of semitones. */
export const semitoneNorm = (plugin: Plugin, st: number): number =>
  normOf(param(plugin, SEMITONES_PARAM), clamp(st, PITCH_RANGE.min, PITCH_RANGE.max), PITCH_RANGE);

/** The next whole semitone above (dir +1) or below (dir -1) a setting, `n` semitones on:
 *  from +7 st +20¢, one down is +7 (not +6) and one up is +8. */
export function nextWholeSemitone(st: number, dir: 1 | -1, n = 1): number {
  return dir > 0 ? Math.floor(st + 1e-9) + n : Math.ceil(st - 1e-9) - n;
}

/** Snap a semitone value: whole semitones, or (fine) hundredths, i.e. whole cents. */
export const snapSemitones = (st: number, fine = false): number =>
  fine ? Math.round(st * 100) / 100 : Math.round(st);

export const pitchRatio = (st: number): number => 2 ** (st / 12);

const INTERVALS = [
  "unison", "minor 2nd", "major 2nd", "minor 3rd", "major 3rd", "perfect 4th",
  "tritone", "perfect 5th", "minor 6th", "major 6th", "minor 7th", "major 7th",
];

/** Is this the original pitch (what the engine prints as "(Original pitch)")? */
export const isOriginal = (st: number): boolean => Math.abs(st) < 0.005;

/** "perfect 5th up", "octave down", "2 octaves up", "octave + major 3rd up",
 *  "original pitch"; a fraction of a semitone around unison is "detuned up/down". */
export function intervalName(st: number): string {
  if (isOriginal(st)) return "original pitch";
  const dir = st > 0 ? "up" : "down";
  const n = Math.abs(splitCents(st).semis);        // the same rounding as the read-out
  if (n === 0) return `detuned ${dir}`;
  const octs = Math.floor(n / 12), rest = n % 12;
  const oct = octs === 0 ? "" : octs === 1 ? "octave" : `${octs} octaves`;
  const name = rest === 0 ? oct : oct ? `${oct} + ${INTERVALS[rest]}` : INTERVALS[rest];
  return `${name} ${dir}`;
}

/** The whole semitones and the leftover cents (-50..+50). Halves round away from zero, the
 *  same both ways: +6.5 is "+7 st -50¢" and -6.5 is "-7 st +50¢". */
export function splitCents(st: number): { semis: number; cents: number } {
  const semis = Math.sign(st) * Math.round(Math.abs(st));
  const cents = Math.round((st - semis) * 100);
  return { semis: Object.is(semis, -0) ? 0 : semis, cents: Object.is(cents, -0) ? 0 : cents };
}

/** "+7 st", "-12 st", "0 st", "+7 st +20¢". */
export function fmtSemitones(st: number): string {
  const { semis, cents } = splitCents(st);
  const head = `${semis > 0 ? "+" : ""}${semis} st`;
  return cents === 0 ? head : `${head} ${cents > 0 ? "+" : "-"}${Math.abs(cents)}¢`;
}

/** "×1.498". */
export const fmtRatioX = (st: number): string => `×${pitchRatio(st).toFixed(3)}`;

/** The plugin's latency in ms at a sample rate: 170.7 ms at 48 kHz. */
export const pitchLatencyMs = (fs: number): number => (PITCH_LATENCY_SAMPLES / (fs > 0 ? fs : 48000)) * 1000;

/** What a screen reader hears: "+7 semitones, perfect 5th up". */
export function pitchValueText(st: number): string {
  if (isOriginal(st)) return "0 semitones, original pitch";
  const { semis, cents } = splitCents(st);
  const s = `${semis > 0 ? "+" : ""}${semis} semitone${Math.abs(semis) === 1 ? "" : "s"}`;
  return `${s}${cents ? ` ${cents > 0 ? "+" : "-"}${Math.abs(cents)} cents` : ""}, ${intervalName(st)}`;
}

/** The minimized row's summary budget: its slot is 97 px of 10 px monospace (6.0 px a
 *  character), so 16 characters fit whole. */
export const SUMMARY_CHARS = 16;

/** The interval's words without the direction (the sign says it), in three lengths. */
function intervalWords(st: number): string[] {
  const full = intervalName(st).replace(/ (up|down)$/, "");
  const short = full.replace(/perfect /g, "").replace(/minor /g, "min ").replace(/major /g, "maj ");
  return [full, short];
}

/** One line for the minimized row, most telling first and at most 16 characters: the
 *  setting, then the interval as long as it fits. "+7 st · 5th", "+4 st · maj 3rd",
 *  "-12 st · octave", "+7 st +20¢ · 5th", "+19 st"; "original pitch" at 0. */
export function pitchSummary(plugin: Plugin): string {
  const st = semitonesOf(plugin);
  if (isOriginal(st)) return "original pitch";
  const head = fmtSemitones(st);
  if (splitCents(st).semis === 0) return head;          // "0 st +20¢": a detune, no interval
  for (const words of intervalWords(st)) {
    const line = `${head} · ${words}`;
    if (line.length <= SUMMARY_CHARS) return line;
  }
  return head;
}
