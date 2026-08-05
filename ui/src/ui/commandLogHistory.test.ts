// CAP-PRJ-005 — the UI's reading of the history stamps.
//
// The native selftest proves the JUMP lands correctly. This proves the UI does not OFFER
// a jump it cannot deliver, which is the other half of the same trap: a row that looks
// clickable but restores to a different point is exactly the silent divergence the
// ticket is about, and it would be invisible in a screenshot.
//
// Every fixture here has a NON-UNDOABLE command in the middle (two log lines sharing one
// stamp). Without it these tests would pass against a "one row = one restore point"
// implementation and prove nothing.

import { describe, expect, it } from "vitest";
import { historyRows, historyRowHint } from "./commandLogHistory";
import type { CommandLog, CommandLogEntry } from "../types";

const entry = (command: string, txn?: string, extra: Partial<CommandLogEntry> = {}): CommandLogEntry => ({
  command,
  ok: true,
  undoable: true,
  ...(txn !== undefined ? { txn } : {}),
  ...extra,
});

// Newest-first, as get_command_log returns them. Chronologically this reads bottom-up:
//   create_track HJ-A   -> opened transaction 1
//   create_track HJ-B   -> opened transaction 2
//   set_metronome       -> opened NOTHING; still at 2
//   create_track HJ-C   -> opened transaction 3
const log = (over: Partial<CommandLog> = {}): CommandLog => ({
  entries: [
    entry("create_track", "s:3"),
    entry("set_metronome", "s:2", { undoable: false }),
    entry("create_track", "s:2"),
    entry("create_track", "s:1"),
  ],
  total: 4,
  currentTxn: "s:3",
  restorableTxns: ["s:0", "s:1", "s:2", "s:3"],
  ...over,
});

describe("CAP-PRJ-005 — which command-log rows are restore points", () => {
  it("a command that opened its own undo transaction is a restore point", () => {
    const rows = historyRows(log());
    expect(rows[0].kind).toBe("restore-point");   // create_track HJ-C
    expect(rows[2].kind).toBe("restore-point");   // create_track HJ-B
    expect(rows[3].kind).toBe("restore-point");   // create_track HJ-A
  });

  it("THE TRAP: a non-undoable command in the middle offers no restore of its own", () => {
    // set_metronome shares HJ-B's stamp because it changed nothing undoable. Treating it
    // as its own step is precisely how a row-counting implementation drifts one step off.
    const rows = historyRows(log());
    expect(rows[1].entry.command).toBe("set_metronome");
    expect(rows[1].kind).toBe("no-state-change");
    expect(rows[1].txn).toBeNull();
  });

  it("the restore target is the stamp, so clicking never resolves to a row index", () => {
    const rows = historyRows(log());
    expect(rows.map((r) => r.txn)).toEqual(["s:3", null, "s:2", "s:1"]);
  });

  it("a point the live timeline can no longer reach is shown, and shown as gone", () => {
    // The producer jumped back to s:1 and then made a new edit: JUCE discarded the redo
    // tail, so s:2 and s:3 name transactions that no longer exist.
    const rows = historyRows(log({ currentTxn: "s:1", restorableTxns: ["s:0", "s:1", "s:4"] }));
    expect(rows[0].kind).toBe("unreachable");
    expect(rows[0].txn).toBeNull();
    expect(rows[2].kind).toBe("unreachable");
    expect(rows[3].kind).toBe("restore-point");   // s:1 survived
  });

  it("a line with no stamp at all (written before the stamp shipped) offers no jump", () => {
    const rows = historyRows({
      entries: [entry("create_track"), entry("create_track")],
      total: 2,
      currentTxn: "s:1",
      restorableTxns: ["s:0", "s:1"],
    });
    expect(rows.every((r) => r.kind === "no-state-change" && r.txn === null)).toBe(true);
  });

  it("without restorableTxns nothing is offered — a missing read fails closed", () => {
    const rows = historyRows({ entries: log().entries, total: 4, currentTxn: "s:3" });
    expect(rows.every((r) => r.txn === null)).toBe(true);
  });

  it("the 'you are here' marker sits on the NEWEST row carrying the current point", () => {
    // currentTxn s:2 is carried by two rows (set_metronome and create_track HJ-B).
    // Newest-first, so the marker belongs on index 1 — everything above it is ahead.
    const rows = historyRows(log({ currentTxn: "s:2" }));
    expect(rows.map((r) => r.isCurrent)).toEqual([false, true, false, false]);
  });

  it("the row you are standing on is not offered as somewhere to go", () => {
    const rows = historyRows(log());
    expect(rows[0].isCurrent).toBe(true);
    // historyRows still reports the txn (the row IS a point); the panel is what declines
    // to make the current row a button. Pinning both halves so neither drifts alone.
    expect(rows[0].txn).toBe("s:3");
    expect(historyRowHint(rows[0])).toBe("you are here");
  });

  it("an empty / absent log yields no rows rather than throwing", () => {
    expect(historyRows(null)).toEqual([]);
    expect(historyRows({ entries: [], total: 0 })).toEqual([]);
  });

  it("every kind has a distinct, non-empty hint", () => {
    const rows = historyRows(log({ currentTxn: "s:1", restorableTxns: ["s:0", "s:1"] }));
    const hints = new Set(rows.map(historyRowHint));
    expect(hints.size).toBeGreaterThan(1);
    for (const h of hints) expect(h.trim().length).toBeGreaterThan(0);
  });
});
