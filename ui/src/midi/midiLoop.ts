// Pure helpers for MIDI clip looping (Live 12's brace → ghost repeats). The
// engine owns the loop state (set_clip_loop's MIDI branch → te::MidiClip's
// loopStart/loopLengthBeats); these expand a clip's notes into the originals plus
// the dimmed ghost repeats the arrangement and the editor paint past the brace.

import type { MidiNote } from "../types";

export type LoopedNote = MidiNote & { ghost?: boolean };

/**
 * Expand a MIDI clip's notes across the clip per its loop region (all times in
 * CONTENT-relative beats, matching the snapshot's midiLoopStart/LengthBeats).
 * Notes inside the loop region repeat at every loopLength interval that fits
 * within clipLengthBeats; notes outside the region play once; a zero/negative
 * loop length (deactivated) returns the originals unchanged. Ghosts (the repeats
 * past the first pass) are flagged for dimmed rendering.
 */
export function expandLoopedNotes(
  notes: readonly MidiNote[],
  clipLengthBeats: number,
  loopStartBeats: number,
  loopLengthBeats: number,
): LoopedNote[] {
  if (!(loopLengthBeats > 1e-9) || notes.length === 0) return [...notes];
  const inLoop = (n: MidiNote) =>
    n.start >= loopStartBeats - 1e-9 && n.start < loopStartBeats + loopLengthBeats - 1e-9;
  const out: LoopedNote[] = notes.map((n) => ({ ...n }));
  for (let offset = loopLengthBeats; ; offset += loopLengthBeats) {
    let any = false;
    for (const n of notes) {
      if (!inLoop(n)) continue;
      const start = n.start + offset;
      if (start >= clipLengthBeats - 1e-9) continue;
      out.push({ ...n, start, ghost: true });
      any = true;
    }
    if (!any) break;
  }
  return out;
}
