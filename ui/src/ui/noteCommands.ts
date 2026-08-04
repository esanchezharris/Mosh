// The command seam for MIDI note edits: how a gesture becomes MoshOps calls.
//
// Two rules here are not style, they are correctness, and both were learned from the
// backend's actual behaviour rather than assumed:
//
//   MOVING A NOTE CAN CHANGE ITS INDEX. setStartAndLength writes IDs::b, which triggers
//   tracktion's synchronous re-sort of the live MidiList, so a note hops position the
//   moment its start changes. That makes N separate set_note calls unsafe for a group
//   move: every call after the first may address a stale index. So a multi-note edit is
//   sent as ONE set_note carrying an `edits` array, which resolves all note pointers
//   before mutating anything — the same guard cmdQuantizeNotes uses. It is also one round
//   trip and one undo step, with no batch bracket needed.
//   (An earlier comment here claimed set_note does not reindex. That is true only for
//   velocity-only edits — which is all the velocity lane ever sent — and false in general.)
//
//   remove_note REINDEXES TOO. Removing note 2 renumbers everything after it, so a
//   multi-note delete MUST go in descending index order. Descending removal is stable, so
//   N calls are fine there; they are bracketed in a batch to stay one undo step.

import type { MidiNote } from "../types";

/** A partial edit to one note, addressed by its index. Omitted fields are left alone. */
export type NoteEdit = {
  i: number;
  pitch?: number;
  start?: number;
  length?: number;
  velocity?: number;
  mute?: boolean;
};

export type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<{ ok: boolean }>;

/** A new note, as add_note wants it (no index — the backend assigns one). */
export type NewNote = Omit<MidiNote, "i">;

/**
 * Run `body` inside a legacy batch so everything it sends is one undo step.
 *
 * Three behaviours that matter, in order of how badly they bite:
 *
 *  - batch_end is sent from a `finally`. If a command inside the batch rejects and we
 *    skipped batch_end, the engine would stay `inBatch` FOREVER and every later edit in
 *    the session would silently join one ever-growing undo transaction. That is by far
 *    the worst failure available here, and it costs one try/finally to make impossible.
 *  - batch_begin can legitimately fail — `inBatch` is process-global, so an agent turn
 *    already holds it. Then we run ungrouped (N undo steps instead of 1, which is a
 *    degradation, not a corruption) and send NO batch_end, because we do not own the
 *    batch someone else opened.
 *  - a single-item edit skips the batch entirely: it is already atomic, and this keeps
 *    the common one-note drag at exactly one round trip.
 */
export async function grouped(exec: ExecFn, label: string, count: number, body: () => Promise<void>): Promise<void> {
  if (count <= 1) {
    await body();
    return;
  }
  let owned = false;
  try {
    const r = await exec("batch_begin", { name: label });
    owned = r?.ok === true;
  } catch {
    owned = false;
  }
  try {
    await body();
  } finally {
    if (owned) await exec("batch_end", {});
  }
}

/**
 * Apply N note edits as ONE command, and so one undo step. The array form is not an
 * optimisation — see the reindexing note at the top of this file: sending these
 * separately would address stale indices the moment one of them changes a start.
 */
export async function applyNoteEdits(exec: ExecFn, clipId: string, edits: readonly NoteEdit[]): Promise<void> {
  // Drop no-op edits: an edit carrying only its index would be a wasted round trip and a
  // wasted JSONL line.
  const real = edits.filter((e) => Object.keys(e).some((k) => k !== "i"));
  if (real.length === 0) return;
  if (real.length === 1) {
    const { i, ...fields } = real[0];
    await exec("set_note", { clipId, noteIndex: i, ...fields });
    return;
  }
  await exec("set_note", {
    clipId,
    edits: real.map(({ i, ...fields }) => ({ noteIndex: i, ...fields })),
  });
}

/** Delete N notes as one undo step. DESCENDING order — remove_note reindexes. */
export async function removeNotes(exec: ExecFn, clipId: string, indices: readonly number[]): Promise<void> {
  if (indices.length === 0) return;
  const ordered = [...indices].sort((a, b) => b - a);
  await grouped(exec, "remove_note", ordered.length, async () => {
    for (const i of ordered) await exec("remove_note", { clipId, noteIndex: i });
  });
}

/**
 * Add N notes as one undo step. Uses add_note's `notes` array so the whole set lands in a
 * single command (and a single transaction) rather than N round trips — the backend opens
 * exactly one transaction for the call.
 */
export async function addNotes(exec: ExecFn, clipId: string, notes: readonly NewNote[]): Promise<void> {
  if (notes.length === 0) return;
  if (notes.length === 1) {
    const n = notes[0];
    await exec("add_note", { clipId, pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity });
    return;
  }
  await exec("add_note", {
    clipId,
    notes: notes.map((n) => ({ pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity })),
  });
}
