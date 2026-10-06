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

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

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

/** The display in words, for the element's accessible name. */
export function describeTuner(view: TunerView | null): string {
  if (!view) return "Live pitch: no note";
  const off = view.cents === 0 ? "in tune" : `${Math.abs(view.cents)} cents ${view.cents > 0 ? "sharp" : "flat"}`;
  return `Live pitch: singing ${view.heard}, ${off}, pulling to ${view.target}`;
}
