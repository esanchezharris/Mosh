// Pure drum-step-grid mapping. The step sequencer is a PROJECTION of a MIDI
// clip's notes — each lane is a fixed GM drum pitch, each step is a slice of the
// bar. All editing flows through the same add_note/remove_note/set_note commands
// the piano roll uses; this module just converts between notes (beats) and grid
// cells. No React, no store — trivially testable.
//
// Phase 6 (FL feel) adds: configurable pattern LENGTH (step count), SWING (off-beat
// delay), and per-step VELOCITY mapping. All optional params default to the prior
// behavior (16 steps, no swing) so existing callers are unaffected.

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

// Default pattern length: one bar at sixteenth resolution.
export const STEPS = 16;
// Pattern lengths the UI offers (steps).
export const STEP_OPTIONS = [8, 16, 32] as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Beats per step for a given bar length (meter numerator) and step count. */
export const stepBeats = (beatsPerBar: number, steps: number = STEPS): number => beatsPerBar / steps;

/**
 * Swing delay (in beats) applied to a step. Off-beats (odd step indices — the
 * "and"s) are pushed later; on-beats stay put. `swing` is 0..1, where 0 is
 * straight and 1 delays the off-beat by 2/3 of a step (a hard triplet shuffle).
 */
export const swingOffsetBeats = (step: number, sb: number, swing: number): number =>
  step % 2 === 1 ? clamp(swing, 0, 1) * sb * (2 / 3) : 0;

/** Clip-local beat position of a step, including swing. */
export const stepStartBeats = (step: number, sb: number, swing = 0): number =>
  step * sb + swingOffsetBeats(step, sb, swing);

/** Back-compat alias (straight, no swing). */
export const noteStart = (step: number, sb: number): number => step * sb;

/** Row index of a GM drum pitch, or -1 if the pitch isn't a lane. */
export const laneIndexForPitch = (pitch: number): number =>
  DRUM_LANES.findIndex((l) => l.pitch === pitch);

/** Map a velocity-bar drag fraction (0 at the bottom, 1 at the top) → MIDI velocity 1..127. */
export const velocityFromFraction = (frac: number): number =>
  clamp(Math.round(frac * 127), 1, 127);

/**
 * Map a note to its (lane, step), or null if it's off-lane or past the pattern.
 * Swing-aware: picks the step whose swung start is nearest the note, rejecting
 * notes more than half a step away (off-grid). For swing=0 this is the classic
 * round(start / stepBeats).
 */
export function cellForNote(
  note: Pick<MidiNote, "pitch" | "start">,
  sb: number,
  steps: number = STEPS,
  swing = 0,
): { lane: number; step: number } | null {
  const lane = laneIndexForPitch(note.pitch);
  if (lane < 0) return null;
  let best = -1, bestD = Infinity;
  for (let s = 0; s < steps; s++) {
    const d = Math.abs(stepStartBeats(s, sb, swing) - note.start);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (best < 0 || bestD > sb * 0.5) return null;
  return { lane, step: best };
}

/** Build a DRUM_LANES.length × steps grid from a clip's notes (first note wins a cell). */
export function buildGrid(
  notes: MidiNote[],
  beatsPerBar: number,
  steps: number = STEPS,
  swing = 0,
): DrumCell[][] {
  const sb = stepBeats(beatsPerBar, steps);
  const grid: DrumCell[][] = DRUM_LANES.map(() =>
    Array.from({ length: steps }, () => ({ on: false, velocity: 0, noteIndex: -1 })),
  );
  for (const n of notes) {
    const c = cellForNote(n, sb, steps, swing);
    if (!c) continue;
    if (grid[c.lane][c.step].on) continue; // first note wins the cell
    grid[c.lane][c.step] = { on: true, velocity: n.velocity, noteIndex: n.i };
  }
  return grid;
}

/** Shift-click accent cycle: loud → med → soft → loud. */
export const cycleVelocity = (v: number): number =>
  v >= 110 ? 90 : v >= 70 ? 50 : 127;
