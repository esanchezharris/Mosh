// The tuner's live note display: what Mosh AutoTune is hearing, how far that is from the
// note it is pulling to, and that note.
//
// The readings arrive on the 30 Hz "tuner" rail (store/telemetry.ts `tuners`), never in
// the snapshot, for the same reason the meters do: a pitch moving 30 times a second must
// not re-create the snapshot object. The engine sends only tuners that are hearing a
// pitch right now, and one empty payload when the last one stops.
import type { TunerReading } from "../types";

/** A tuner's key in `tuners`: the track it is on and its position in that track's chain. */
export const tunerKey = (trackId: string, index: number): string => `${trackId}:${index}`;

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// The notes each AutoTune scale allows, as semitones above the key's root. The same table
// the engine corrects with (src/plugins/moshfx/retune/TuneCorrection.h scaleAllows), so
// the keyboard greys out exactly the notes the tuner will never pull to.
const SCALE_STEPS: Record<string, readonly number[]> = {
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
};

/** The pitch classes (0 = C ... 11 = B) a scale allows from a root. An unknown scale name
 *  allows every note, as Chromatic does: the keyboard must never grey out a note the
 *  tuner might use. */
export function scalePitchClasses(root: number, scale: string): Set<number> {
  const steps = SCALE_STEPS[scale] ?? SCALE_STEPS.Chromatic;
  const base = ((Math.round(Number.isFinite(root) ? root : 0) % 12) + 12) % 12;
  return new Set(steps.map((s) => (base + s) % 12));
}

/** The pitch class (0 = C ... 11 = B) of the note nearest a frequency. */
export function pitchClassOf(hz: number): number | null {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  if (midi < 0 || midi > 127) return null;
  return midi % 12;
}

/** The one-octave keyboard the tuner draws: each key's pitch class, colour and position
 *  in white-key widths (black keys sit across the boundary between two white keys). */
export const KEYBOARD_KEYS: readonly { pc: number; black: boolean; x: number }[] = [
  { pc: 0, black: false, x: 0 }, { pc: 2, black: false, x: 1 }, { pc: 4, black: false, x: 2 },
  { pc: 5, black: false, x: 3 }, { pc: 7, black: false, x: 4 }, { pc: 9, black: false, x: 5 },
  { pc: 11, black: false, x: 6 },
  { pc: 1, black: true, x: 1 }, { pc: 3, black: true, x: 2 }, { pc: 6, black: true, x: 4 },
  { pc: 8, black: true, x: 5 }, { pc: 10, black: true, x: 6 },
];

/** The note nearest a frequency, as a name with its octave ("A3"; A4 is 440 Hz). */
export function noteName(hz: number): string | null {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  if (midi < 0 || midi > 127) return null;
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

export type TunerView = {
  /** The note nearest what is being sung. */
  heard: string;
  /** The note it is being pulled to. */
  target: string;
  /** How far the voice is from the target, in whole cents; positive is sharp. */
  cents: number;
  /** Where the needle sits: 0 is a semitone flat, 0.5 on the note, 1 a semitone sharp. */
  position: number;
  /** Within five cents of the target. */
  inTune: boolean;
};

/** What the display shows for a reading; null when there is no usable pitch. */
export function tunerView(reading: Pick<TunerReading, "inputHz" | "targetHz"> | null | undefined): TunerView | null {
  if (!reading) return null;
  const heard = noteName(reading.inputHz);
  const target = noteName(reading.targetHz);
  if (heard === null || target === null) return null;
  const exact = 1200 * Math.log2(reading.inputHz / reading.targetHz);
  const cents = Math.round(exact) || 0;   // never "-0"
  return {
    heard, target, cents,
    position: 0.5 + Math.min(100, Math.max(-100, exact)) / 200,
    inTune: Math.abs(exact) <= 5,
  };
}

/** "+23 c", "-8 c", "0 c". */
export function formatCents(cents: number): string {
  return `${cents > 0 ? "+" : ""}${cents} c`;
}

/** The display in words, for the element's accessible name. `scale` ("C Major") is
 *  appended when given, since the keyboard shows it by colour alone. */
export function describeTuner(view: TunerView | null, scale?: string): string {
  const scaleText = scale ? `. Scale: ${scale}` : "";
  if (!view) return `Live pitch: no note${scaleText}`;
  const off = view.cents === 0 ? "in tune" : `${Math.abs(view.cents)} cents ${view.cents > 0 ? "sharp" : "flat"}`;
  return `Live pitch: singing ${view.heard}, ${off}, pulling to ${view.target}${scaleText}`;
}
