// Outcome inference for harvested turns.
//
// The JSONL log is append-only and forward-only — it records every mutation but
// never erases an undone one. To know whether an agent turn was KEPT or later
// reverted, we model Tracktion's undo stack at the log level:
//   - Each completed agent turn (a batch) is ONE undoable unit.
//   - Each standalone undoable command outside a batch is its own unit.
//   - `undo` pops the most-recent unit; `redo` re-applies it; a fresh unit
//     clears the redo stack (standard undo semantics).
// A turn is `undone` iff its unit ends the session in the popped state.

export type UndoUnit = { turnIndex: number | null }; // null = a non-turn (manual) command
export type UndoEvent = { kind: "push"; unit: UndoUnit } | { kind: "undo" } | { kind: "redo" };

/** Replay the undo/redo event stream and return the set of turn indices that
 *  remain undone at the end. */
export function computeUndoneTurns(events: UndoEvent[]): Set<number> {
  const undoStack: UndoUnit[] = [];
  const redoStack: UndoUnit[] = [];
  const undone = new Set<number>();

  for (const e of events) {
    if (e.kind === "push") {
      undoStack.push(e.unit);
      redoStack.length = 0; // a new edit invalidates the redo history
      if (e.unit.turnIndex !== null) undone.delete(e.unit.turnIndex);
    } else if (e.kind === "undo") {
      const u = undoStack.pop();
      if (u) {
        redoStack.push(u);
        if (u.turnIndex !== null) undone.add(u.turnIndex);
      }
    } else {
      const u = redoStack.pop();
      if (u) {
        undoStack.push(u);
        if (u.turnIndex !== null) undone.delete(u.turnIndex);
      }
    }
  }

  return undone;
}
