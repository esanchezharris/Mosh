import { DRUM_LANES, laneIndexForPitch } from "../../ui/drumGrid";
import type { MidiNote } from "../../types";

export const V3_DRUM_LANES = ["kick", "snare", "hat"] as const;
export type V3DrumLane = (typeof V3_DRUM_LANES)[number];

/** Collapse GM percussion into the three demo lanes: Kick / Snare / Hat. */
export function v3DrumLane(pitch: number): V3DrumLane | null {
  if (pitch === 35 || pitch === 36) return "kick";
  if (pitch === 38 || pitch === 40 || pitch === 37 || pitch === 39) return "snare";
  if (pitch === 42 || pitch === 44 || pitch === 46 || pitch === 49 || pitch === 51 || pitch === 52) {
    return "hat";
  }
  const idx = laneIndexForPitch(pitch);
  if (idx < 0) return null;
  if (idx === 0) return "kick";
  if (idx <= 2) return "snare";
  return "hat";
}

export function notesOnLane(notes: readonly MidiNote[] | undefined, lane: V3DrumLane): MidiNote[] {
  return (notes ?? []).filter((n) => v3DrumLane(n.pitch) === lane);
}

export function v3DrumLaneCount(): number {
  return V3_DRUM_LANES.length;
}

export function extraGmLanesCollapsed(): number {
  return Math.max(0, DRUM_LANES.length - V3_DRUM_LANES.length);
}
