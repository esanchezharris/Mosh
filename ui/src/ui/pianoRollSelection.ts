// Piano-roll selection algebra. Pure set operations over note INDICES, extracted so the
// rules can be tested without mounting a component.
//
// One subtlety runs through this file: a note's index is not a stable identity. The
// backend's MidiList keeps its notes sorted by start, so adding or removing notes
// renumbers the rest. Anything that survives a round trip to the engine (duplicate, paste)
// must therefore re-derive its selection by VALUE — see noteIdentity/reselectByIdentity —
// rather than holding on to indices that have since moved under it.

import type { MidiNote } from "../types";

export type Box = { x: number; y: number; w: number; h: number };
export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Notes whose rendered box intersects the marquee. */
export function marqueeHit(notes: readonly MidiNote[], rect: Rect, boxOf: (n: MidiNote) => Box): number[] {
  const xMin = Math.min(rect.x0, rect.x1), xMax = Math.max(rect.x0, rect.x1);
  const yMin = Math.min(rect.y0, rect.y1), yMax = Math.max(rect.y0, rect.y1);
  return notes
    .filter((n) => {
      const b = boxOf(n);
      return b.x + b.w >= xMin && b.x <= xMax && b.y + b.h >= yMin && b.y <= yMax;
    })
    .map((n) => n.i);
}

/** Shift-click: add to / remove from the selection. Plain click: select just this one. */
export function toggleSelection(sel: ReadonlySet<number>, i: number, additive: boolean): Set<number> {
  if (!additive) return new Set([i]);
  const next = new Set(sel);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  return next;
}

export function selectAll(notes: readonly MidiNote[]): Set<number> {
  return new Set(notes.map((n) => n.i));
}

export function invertSelection(notes: readonly MidiNote[], sel: ReadonlySet<number>): Set<number> {
  return new Set(notes.filter((n) => !sel.has(n.i)).map((n) => n.i));
}

/** Clicking a key in the gutter selects every note at that pitch (Ableton's shift-click). */
export function selectAtPitch(notes: readonly MidiNote[], pitch: number,
                              additive: boolean, sel: ReadonlySet<number>): Set<number> {
  const atPitch = notes.filter((n) => n.pitch === pitch).map((n) => n.i);
  if (!additive) return new Set(atPitch);
  const next = new Set(sel);
  // If the whole pitch is already selected, a second shift-click clears it — otherwise
  // there is no way to undo the gesture without abandoning the rest of the selection.
  const allIn = atPitch.length > 0 && atPitch.every((i) => next.has(i));
  for (const i of atPitch) {
    if (allIn) next.delete(i);
    else next.add(i);
  }
  return next;
}

/**
 * Option+Arrow: step the selection to the next/previous note in TIME order (ties broken by
 * pitch, so the walk is deterministic on a chord). With nothing selected, enters at the
 * first note going forward, or the last going backward.
 */
export function stepSelection(notes: readonly MidiNote[], sel: ReadonlySet<number>, dir: 1 | -1): Set<number> {
  if (notes.length === 0) return new Set();
  const ordered = [...notes].sort((a, b) => (a.start - b.start) || (a.pitch - b.pitch));
  if (sel.size === 0) return new Set([dir === 1 ? ordered[0].i : ordered[ordered.length - 1].i]);
  // Anchor on the edge of the selection we are travelling towards.
  const positions = ordered.map((n, k) => (sel.has(n.i) ? k : -1)).filter((k) => k >= 0);
  const from = dir === 1 ? Math.max(...positions) : Math.min(...positions);
  const next = Math.max(0, Math.min(ordered.length - 1, from + dir));
  return new Set([ordered[next].i]);
}

/** A note's value-identity — stable across the reindexing an add/remove causes. */
export type NoteIdentity = string;
export function noteIdentity(n: Pick<MidiNote, "pitch" | "start" | "length" | "velocity" | "mute">): NoteIdentity {
  return `${n.pitch}|${n.start.toFixed(6)}|${n.length.toFixed(6)}|${n.velocity}|${n.mute === true ? 1 : 0}`;
}

/**
 * Re-derive a selection after a refresh, by identity rather than index. Needed because
 * indices shift under us whenever notes are added or removed.
 */
export function reselectByIdentity(notes: readonly MidiNote[], wanted: readonly NoteIdentity[]): Set<number> {
  const remaining = new Map<NoteIdentity, number>();
  for (const identity of wanted) remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  const selected = new Set<number>();
  for (const note of notes) {
    const identity = noteIdentity(note);
    const count = remaining.get(identity) ?? 0;
    if (count === 0) continue;
    selected.add(note.i);
    if (count === 1) remaining.delete(identity);
    else remaining.set(identity, count - 1);
  }
  return selected;
}
