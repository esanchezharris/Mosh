// Pure drum-step-grid mapping. The step sequencer is a PROJECTION of a MIDI
// clip's notes — each lane is a fixed GM drum pitch, each step is a 1/16 of the
// first bar. All editing flows through the same add_note/remove_note/set_note
// commands the piano roll uses; this module just converts between notes (beats)
// and grid cells. No React, no store — trivially testable.

import type { MidiNote } from "../types";

export type DrumLane = { name: string; pitch: number };
export type DrumCell = { on: boolean; velocity: number; noteIndex: number };

// 8 lanes, displayed top → bottom. GM percussion key numbers.
export const DRUM_LANES: DrumLane[] = [
  { name: "Kick", pitch: 36 },
  { name: "Snare", pitch: 38 },
  { name: "Clap", pitch: 39 },
  { name: "Closed Hat", pitch: 42 },
  { name: "Open Hat", pitch: 46 },
  { name: "Low Tom", pitch: 45 },
  { name: "Mid Tom", pitch: 47 },
  { name: "Crash", pitch: 49 },
];

// One bar, sixteenth resolution.
export const STEPS = 16;

/** Beats per step given the bar's beat count (the meter numerator). */
export const stepBeats = (beatsPerBar: number): number => beatsPerBar / STEPS;

/** Clip-local beat position (relative to the clip) of a step. */
export const noteStart = (step: number, sb: number): number => step * sb;

/** Row index of a GM drum pitch, or -1 if the pitch isn't a lane. */
export const laneIndexForPitch = (pitch: number): number =>
  DRUM_LANES.findIndex((l) => l.pitch === pitch);

/** Map a note to its (lane, step), or null if it's off-lane or past the bar. */
export function cellForNote(
  note: Pick<MidiNote, "pitch" | "start">,
  sb: number,
): { lane: number; step: number } | null {
  const lane = laneIndexForPitch(note.pitch);
  if (lane < 0) return null;
  const step = Math.round(note.start / sb);
  if (step < 0 || step >= STEPS) return null;
  return { lane, step };
}

/** Build a DRUM_LANES.length × STEPS grid from a clip's notes (first note wins a cell). */
export function buildGrid(notes: MidiNote[], beatsPerBar: number): DrumCell[][] {
  const sb = stepBeats(beatsPerBar);
  const grid: DrumCell[][] = DRUM_LANES.map(() =>
    Array.from({ length: STEPS }, () => ({ on: false, velocity: 0, noteIndex: -1 })),
  );
  for (const n of notes) {
    const c = cellForNote(n, sb);
    if (!c) continue;
    if (grid[c.lane][c.step].on) continue; // first note wins the cell
    grid[c.lane][c.step] = { on: true, velocity: n.velocity, noteIndex: n.i };
  }
  return grid;
}

/** Shift-click accent cycle: loud → med → soft → loud. */
export const cycleVelocity = (v: number): number =>
  v >= 110 ? 90 : v >= 70 ? 50 : 127;
