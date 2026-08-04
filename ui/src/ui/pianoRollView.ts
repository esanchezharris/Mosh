// Which pitches the roll shows, and where each one sits.
//
// The roll used to hardcode pitches 36..96, so a bass part below C2 or a lead above C7 was
// silently unreachable — the notes existed in the clip and simply could not be seen or
// edited. It now spans the full MIDI range, which makes FOLDING necessary rather than
// merely nice: 128 rows is a lot of scrolling for a drum clip that uses eight of them.
//
// Fold-to-Scale keeps in-key pitches UNION every pitch that actually has a note. That union
// is load-bearing: without it, folding hides the producer's own out-of-key notes and makes
// them unselectable, which is a data-loss-shaped bug rather than a view preference.

import type { MidiNote } from "../types";

export const PITCH_MIN = 0, PITCH_MAX = 127;

export type FoldMode =
  | "off"        // every pitch
  | "content"    // only pitches that have notes (Ableton's Fold, F)
  | "scale";     // in-key pitches, plus any pitch that has a note (Fold to Scale, G)

export type PitchAxis = {
  /** Descending, so index 0 is the top row. */
  visible: number[];
  /** Y of a pitch's row top, or -1 when it is folded away. */
  yOf: (pitch: number) => number;
  /** The pitch at a Y offset (clamped into range). */
  pitchAt: (y: number) => number;
  height: number;
  rowH: number;
};

export function visiblePitches(opts: {
  low?: number; high?: number;
  mode: FoldMode;
  keyMask?: readonly boolean[];   // 12 entries, indexed by pitch class
  notes?: readonly MidiNote[];
}): number[] {
  const low = opts.low ?? PITCH_MIN, high = opts.high ?? PITCH_MAX;
  const all: number[] = [];
  for (let p = high; p >= low; p--) all.push(p);
  if (opts.mode === "off") return all;

  const withNotes = new Set((opts.notes ?? []).map((n) => n.pitch));
  if (opts.mode === "content") {
    const kept = all.filter((p) => withNotes.has(p));
    // Never fold to nothing — an empty clip would render a zero-height grid with no way
    // back. Fall back to showing everything, which is what the producer can act on.
    return kept.length > 0 ? kept : all;
  }

  const mask = opts.keyMask;
  if (!mask) return all;
  const kept = all.filter((p) => mask[((p % 12) + 12) % 12] || withNotes.has(p));
  return kept.length > 0 ? kept : all;
}

export function pitchAxis(visible: readonly number[], rowH: number): PitchAxis {
  // A lookup table rather than arithmetic: once rows can be missing, (high - pitch) * rowH
  // is simply wrong, and every consumer (rows, gutter, note boxes, marquee hit-testing,
  // click-to-draw) has to agree on the same mapping.
  const rowOf = new Map<number, number>();
  visible.forEach((p, i) => rowOf.set(p, i));
  return {
    visible: [...visible],
    rowH,
    height: visible.length * rowH,
    yOf: (pitch) => {
      const r = rowOf.get(pitch);
      return r == null ? -1 : r * rowH;
    },
    pitchAt: (y) => {
      if (visible.length === 0) return 60;
      const r = Math.max(0, Math.min(visible.length - 1, Math.floor(y / rowH)));
      return visible[r];
    },
  };
}
