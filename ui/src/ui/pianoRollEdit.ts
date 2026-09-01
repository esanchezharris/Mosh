// Gesture → note edits. The piano roll's drag arithmetic, lifted out of the component so
// it can be tested at group scale without a DOM.
//
// THE INVARIANT THIS CARRIES (piano-roll axis independence, PR #427 + its mirror):
// an axis you did not move is never rewritten. Sliding notes sideways is a request to
// change their TIME, not to straighten their pitch; nudging them up the scale is a request
// to change their PITCH, not to quantize a deliberately off-grid hit.
//
// Two details make that hold for a whole selection rather than one note:
//
//  - `timeMoved` and `dp` are derived ONCE from pointer travel, which every selected note
//    shares. They are properties of the gesture, not of any note.
//  - each note's new value is derived from ITS OWN frozen original, so the selection keeps
//    its internal shape — three notes a beat apart stay a beat apart, instead of collapsing
//    onto the note the producer happened to grab.
//
// Untouched axes are emitted with the note's EXISTING value rather than omitted. Omitting
// them would also be correct (set_note leaves absent fields alone) and marginally cheaper,
// but the wire format is what the drag-axis tests assert on, and writing the old value back
// is indistinguishable in effect. Not worth changing a proven guard's shape for.

import type { MidiNote } from "../types";
import type { NoteEdit } from "./noteCommands";

export type GestureGeom = {
  beatPx: number;
  rowH: number;
  /** Below this many pixels of horizontal travel, the time axis was not moved (hand tremor). */
  dragThreshold: number;
  snapBeat: (beat: number, bypass: boolean) => number;
  lockPitch: (pitch: number) => number;
  /** Shortest note a resize may produce; the caller resolves it from the current snap. */
  minLengthBeats: number;
};

export type DragInput = {
  /** The selection as it was at pointerdown, keyed by note index. Never re-read mid-drag. */
  orig: ReadonlyMap<number, MidiNote>;
  dxPx: number;
  dyPx: number;
  bypassSnap: boolean;
};

const clampPitch = (p: number) => Math.max(0, Math.min(127, p));

/** Move / transpose. Returns [] when the gesture moved neither axis. */
export function moveEdits(input: DragInput, g: GestureGeom): NoteEdit[] {
  const timeMoved = Math.abs(input.dxPx) > g.dragThreshold;
  const dp = -Math.round(input.dyPx / g.rowH); // +y is downward = lower pitch
  if (!timeMoved && dp === 0) return [];

  const db = input.dxPx / g.beatPx;
  const edits: NoteEdit[] = [];
  for (const [i, n] of input.orig) {
    edits.push({
      i,
      start: timeMoved ? Math.max(0, g.snapBeat(n.start + db, input.bypassSnap)) : n.start,
      pitch: dp === 0 ? n.pitch : g.lockPitch(clampPitch(n.pitch + dp)),
    });
  }
  return edits;
}

/**
 * Resize from the right edge. Returns [] inside the deadzone — and the caller must CLEAR
 * its preview on that, not merely skip the commit: dragging the grip far out and back to
 * the origin would otherwise release with the abandoned length still standing.
 */
export function resizeEdits(input: DragInput, g: GestureGeom): NoteEdit[] {
  if (Math.abs(input.dxPx) <= g.dragThreshold) return [];
  const db = input.dxPx / g.beatPx;
  const edits: NoteEdit[] = [];
  for (const [i, n] of input.orig) {
    const end = g.snapBeat(n.start + n.length + db, input.bypassSnap);
    edits.push({ i, length: Math.max(g.minLengthBeats, end - n.start) });
  }
  return edits;
}

export function resizeStartEdits(input: DragInput, g: GestureGeom): NoteEdit[] {
  if (Math.abs(input.dxPx) <= g.dragThreshold) return [];
  const db = input.dxPx / g.beatPx;
  const edits: NoteEdit[] = [];
  for (const [i, n] of input.orig) {
    const end = n.start + n.length;
    const proposed = g.snapBeat(n.start + db, input.bypassSnap);
    const start = Math.max(0, Math.min(end - g.minLengthBeats, proposed));
    if (start === n.start) continue;
    edits.push({ i, start, length: end - start });
  }
  return edits;
}

/** Keyboard transpose (Up/Down = ±1, Shift+Up/Down = ±12). */
export function transposeEdits(notes: readonly MidiNote[], sel: ReadonlySet<number>,
                               semitones: number, lockPitch: (p: number) => number): NoteEdit[] {
  if (semitones === 0) return [];
  return notes.filter((n) => sel.has(n.i))
              .map((n) => ({ i: n.i, pitch: lockPitch(clampPitch(n.pitch + semitones)) }));
}

/** Keyboard nudge in time (arrow keys), by a whole grid step. Never goes below beat 0. */
export function nudgeEdits(notes: readonly MidiNote[], sel: ReadonlySet<number>, deltaBeats: number): NoteEdit[] {
  if (deltaBeats === 0) return [];
  return notes.filter((n) => sel.has(n.i))
              .map((n) => ({ i: n.i, start: Math.max(0, n.start + deltaBeats) }));
}

/** Keyboard velocity change (Cmd+Up/Down), clamped to the engine's 1..127. */
export function velocityEdits(notes: readonly MidiNote[], sel: ReadonlySet<number>, delta: number): NoteEdit[] {
  if (delta === 0) return [];
  return notes.filter((n) => sel.has(n.i))
              .map((n) => ({ i: n.i, velocity: Math.max(1, Math.min(127, n.velocity + delta)) }));
}

/**
 * Toggle deactivate (Ableton's `0`). A mixed selection ACTIVATES everything rather than
 * flipping each note independently — flipping per note makes the key useless on a mixed
 * selection, because pressing it twice returns you to where you started by a different
 * route each time.
 */
export function toggleActiveEdits(notes: readonly MidiNote[], sel: ReadonlySet<number>): NoteEdit[] {
  const chosen = notes.filter((n) => sel.has(n.i));
  if (chosen.length === 0) return [];
  const anyActive = chosen.some((n) => !n.mute);
  return chosen.map((n) => ({ i: n.i, mute: anyActive }));
}

/** Apply edits over the frozen originals → the note map the grid should render mid-drag. */
export function previewFrom(orig: ReadonlyMap<number, MidiNote>, edits: readonly NoteEdit[]): Map<number, MidiNote> {
  const out = new Map<number, MidiNote>();
  for (const e of edits) {
    const base = orig.get(e.i);
    if (!base) continue;
    out.set(e.i, {
      ...base,
      ...(e.pitch !== undefined ? { pitch: e.pitch } : {}),
      ...(e.start !== undefined ? { start: e.start } : {}),
      ...(e.length !== undefined ? { length: e.length } : {}),
      ...(e.velocity !== undefined ? { velocity: e.velocity } : {}),
    });
  }
  return out;
}

// ── draw mode (Live's pencil, SPEC §7 of docs/live-clone/SPEC.md) ────────────────
// Draw ON: a click-DRAG on empty grid paints one note whose LENGTH follows the drag;
// a plain click paints a grid-step note (the caller's existing click path — a
// zero-travel drag degenerates to exactly that here, which the tests pin). Draw OFF:
// this helper is never consulted and a drag is the marquee, as before.

/**
 * The { start, length } a draw gesture commits.
 *
 *  - The START floors to the grid line at/below the pointer-DOWN (never the current
 *    pointer) — rounding here would drop the note half a step from where the producer
 *    aimed, the same rule the click-to-draw path's snapDownBeat carries.
 *  - The END follows the drag, snapped (round) to the grid, and never produces a note
 *    shorter than one grid step — so a click (down == up) yields exactly a grid-step
 *    note and a drag can never shrink below it.
 *  - Dragging LEFT of the start still paints rightward from the floored start (the
 *    span clamps at the start; Live behaves the same way).
 *  - `stepBeats` 0 (snap off) or `bypassSnap` (Option held) = freehand: no floor, no
 *    snap, just a floor on the minimum length so a wobble-click still lands a note.
 */
export function drawNoteSpan(input: {
  downBeat: number;
  currentBeat: number;
  /** Grid step in beats; 0 = snap off. */
  stepBeats: number;
  bypassSnap?: boolean;
}): { start: number; length: number } {
  const { downBeat, currentBeat, stepBeats, bypassSnap } = input;
  const snapOn = stepBeats > 0 && !bypassSnap;
  const minLen = snapOn ? stepBeats : 0.25;
  const start = Math.max(0, snapOn ? Math.floor(downBeat / stepBeats) * stepBeats : downBeat);
  const rawEnd = Math.max(currentBeat, start);
  const end = snapOn
    ? Math.max(start + stepBeats, Math.round(rawEnd / stepBeats) * stepBeats)
    : Math.max(start + minLen, rawEnd);
  return { start, length: end - start };
}
