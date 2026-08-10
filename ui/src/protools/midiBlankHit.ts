import type { Clip } from "../types";
import { DRUM_LANES, laneIndexForPitch } from "../ui/drumGrid";
import { isDrumClip } from "../ui/clipRenderers";

export function midiPointerIsBlank(
  clip: Clip,
  x: number,
  y: number,
  width: number,
  height: number,
  beatSeconds: number,
  drumTrack: boolean,
): boolean {
  const notes = clip.notes ?? [];
  if (notes.length === 0 || width <= 0 || height <= 0 || clip.length <= 0) return true;
  const localSeconds = Math.max(0, Math.min(clip.length, x / width * clip.length));
  const drum = drumTrack || isDrumClip(notes);

  if (drum) {
    const laneHeight = height / DRUM_LANES.length;
    return !notes.some((note) => {
      const lane = laneIndexForPitch(note.pitch);
      if (lane < 0) return false;
      const starts = note.start * beatSeconds;
      const ends = starts + Math.max(0.03, note.length * beatSeconds);
      return localSeconds >= starts && localSeconds <= ends
        && y >= lane * laneHeight && y <= (lane + 1) * laneHeight;
    });
  }

  let low = Math.min(...notes.map((note) => note.pitch));
  let high = Math.max(...notes.map((note) => note.pitch));
  if (high - low < 4) {
    const center = Math.round((low + high) / 2 || 60);
    low = center - 6;
    high = center + 6;
  } else {
    low -= 1;
    high += 1;
  }
  const span = Math.max(1, high - low);
  const rowHeight = Math.max(2, Math.min(7, (height - 2) / span));
  return !notes.some((note) => {
    const starts = note.start * beatSeconds;
    const ends = starts + Math.max(0.03, note.length * beatSeconds);
    const noteY = (1 - (note.pitch - low) / span) * (height - rowHeight);
    return localSeconds >= starts && localSeconds <= ends
      && y >= noteY - 2 && y <= noteY + rowHeight + 2;
  });
}
