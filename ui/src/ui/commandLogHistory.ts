// CAP-PRJ-005 — turning the command log into a clickable history list.
//
// Pro Tools, Reaper and Live all show a history list you click an entry in, and all
// three restore to THAT POINT rather than asking for a step count. The command log is
// the list Mosh already has, so it is the one to make clickable — but the command log
// and the undo stack are two different lists and they do not line up. mosh-log.jsonl
// records every command including the ones that are deliberately not undoable
// (set_metronome, set_project_settings, transport moves); the UndoManager holds only the
// transactions that materialised. Counting rows would land the producer somewhere they
// did not click, and would do it silently.
//
// The engine's answer is to stamp each line with the IDENTITY of the undo point it left
// the session at (`txn`), and to publish which of those points the live undo timeline
// can still reach (`restorableTxns`) and where the session is now (`currentTxn`). This
// module is the whole of the UI's reading of that, kept pure so it can be tested without
// a DOM: given the log, decide per row whether it is a point you can go back to, a row
// that changed no undoable state, or a point that has since been overwritten.
//
// Note what is NOT derived from the `undoable` flag. That flag is the call site's own
// claim, and a command can claim undoable:true while opening an empty transaction (the
// G14 class). Two adjacent rows sharing a `txn` is the engine reporting what actually
// happened to the undo stack, which is the only thing a restore can act on.

import type { CommandLog, CommandLogEntry } from "../types";

export type HistoryRowKind =
  /** Opened its own undo transaction and that transaction is still on the timeline:
      clicking restores the session to exactly this point. */
  | "restore-point"
  /** Ran, but left the undo stack where it was — a preference write, a transport move,
      or a command inside a batch that shares the batch's single transaction. There is no
      distinct point to go back to, so it offers no click. */
  | "no-state-change"
  /** Was a point once, but the live timeline can no longer reach it: undone past and
      then overwritten by a new edit, evicted as the history filled, or written by an
      earlier session. Shown, and shown as gone. */
  | "unreachable";

export type HistoryRow = {
  entry: CommandLogEntry;
  kind: HistoryRowKind;
  /** The stamp to send to `jump_to_history`. Null when the row offers no jump. */
  txn: string | null;
  /** The newest row carrying the session's current point — the "you are here" marker.
      Rows above it are ahead of the producer (redoable, or discarded). */
  isCurrent: boolean;
};

/** Build the per-row verdicts for a command log window. `entries` are newest-first, as
 *  `get_command_log` returns them. */
export function historyRows(log: CommandLog | null): HistoryRow[] {
  const entries = log?.entries ?? [];
  const restorable = new Set(log?.restorableTxns ?? []);
  const currentTxn = log?.currentTxn;
  // Newest-first, so the first row carrying the current stamp is the newest one.
  const currentIndex = currentTxn ? entries.findIndex((e) => e.txn === currentTxn) : -1;

  return entries.map((entry, i) => {
    const txn = entry.txn;
    // The chronologically PREVIOUS command is the next index (the list runs newest-first).
    // A row introduced a new undo point iff its stamp differs from that neighbour's. At
    // the oldest edge of the window the neighbour is off-screen, so we treat the row as a
    // point — the landing stays exact either way, because the jump resolves an identity
    // rather than a position, so the worst case is offering one click too many.
    const previous = entries[i + 1];
    const openedItsOwnPoint = txn != null && (previous === undefined || previous.txn !== txn);

    let kind: HistoryRowKind;
    if (!openedItsOwnPoint) kind = "no-state-change";
    else if (restorable.has(txn!)) kind = "restore-point";
    else kind = "unreachable";

    return {
      entry,
      kind,
      txn: kind === "restore-point" ? txn! : null,
      isCurrent: i === currentIndex,
    };
  });
}

/** One-line explanation of a row's kind, for the row's tooltip. */
export function historyRowHint(row: HistoryRow): string {
  switch (row.kind) {
    case "restore-point":
      return row.isCurrent ? "you are here" : "go back to this point";
    case "no-state-change":
      return "changed nothing undoable — no point of its own to go back to";
    case "unreachable":
      return "no longer in the undo history";
  }
}
