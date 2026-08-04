// Note clipboard. Deliberately SEPARATE from store.clipboard, which holds a single-clip
// descriptor for paste_clip in the arrangement: copying notes must not clobber a clip you
// copied a moment ago, and pasting notes into the arrangement would be meaningless.
//
// Everything here is relative to the earliest copied note, so a paste lands as a shape at
// the target rather than snapping back to wherever it was cut from.

import type { MidiNote } from "../types";

export type NewNote = Omit<MidiNote, "i">;
export type NoteClipboard = {
  /** Offsets from the selection's own start, so the shape survives a move. */
  notes: NewNote[];
  /** Span of the copied material, in beats — what Cmd+D advances by. */
  span: number;
};

let held: NoteClipboard | null = null;

export function copyNotes(notes: readonly MidiNote[], sel: ReadonlySet<number>): NoteClipboard | null {
  const chosen = notes.filter((n) => sel.has(n.i));
  if (chosen.length === 0) return null;
  const anchor = Math.min(...chosen.map((n) => n.start));
  const end = Math.max(...chosen.map((n) => n.start + n.length));
  return {
    notes: chosen.map((n) => ({ pitch: n.pitch, start: n.start - anchor, length: n.length, velocity: n.velocity })),
    span: end - anchor,
  };
}

export function setClipboard(c: NoteClipboard | null) { held = c; }
export function getClipboard(): NoteClipboard | null { return held; }

/** Place the clipboard's shape at `targetBeat`. */
export function pasteAt(c: NoteClipboard, targetBeat: number): NewNote[] {
  return c.notes.map((n) => ({ ...n, start: Math.max(0, targetBeat + n.start) }));
}

/**
 * Cmd+D — a copy placed immediately AFTER the selection, which is Ableton's rule and the
 * reason duplicate feels like "extend this idea" rather than "stack another one on top".
 */
export function duplicateAfter(notes: readonly MidiNote[], sel: ReadonlySet<number>): NewNote[] {
  const c = copyNotes(notes, sel);
  if (!c) return [];
  const anchor = Math.min(...notes.filter((n) => sel.has(n.i)).map((n) => n.start));
  // A zero-span selection (one zero-length note) would duplicate on top of itself forever;
  // fall back to the note's own length so the copy is always somewhere new.
  const advance = c.span > 0 ? c.span : (c.notes[0]?.length ?? 1);
  return pasteAt(c, anchor + advance);
}
