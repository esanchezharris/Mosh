// The command seam for note edits. Every assertion here checks the FULL call sequence,
// never `toContain` — `expect(calls).toContain("batch_begin")` passes happily when
// batch_end is missing, which is exactly the bug that would leave the engine `inBatch`
// forever and silently fold every later edit of the session into one undo transaction.

import { describe, expect, it, vi } from "vitest";
import { applyNoteEdits, removeNotes, addNotes, grouped, type ExecFn } from "./noteCommands";

const spyExec = (impl?: (c: string) => Promise<{ ok: boolean }>) => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const exec = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    return impl ? impl(command) : { ok: true };
  }) as unknown as ExecFn;
  return { exec, calls, names: () => calls.map((c) => c.command) };
};

describe("applyNoteEdits", () => {
  it("sends a bare set_note for a single edit — no batch for the common one-note drag", async () => {
    const { exec, names } = spyExec();
    await applyNoteEdits(exec, "c1", [{ i: 3, pitch: 62 }]);
    expect(names()).toEqual(["set_note"]);
  });

  it("sends a multi-note edit as ONE set_note carrying an edits array", async () => {
    // Not just fewer round trips — it is the only SAFE shape. Moving a note re-sorts the
    // engine's MidiList, so a second set_note in the same gesture would address an index
    // that has already moved. The array form resolves every target before mutating.
    const { exec, calls, names } = spyExec();
    await applyNoteEdits(exec, "c1", [{ i: 0, pitch: 60 }, { i: 1, pitch: 62 }, { i: 2, pitch: 64 }]);
    expect(names()).toEqual(["set_note"]);
    expect(calls[0].args.edits).toEqual([
      { noteIndex: 0, pitch: 60 }, { noteIndex: 1, pitch: 62 }, { noteIndex: 2, pitch: 64 },
    ]);
  });

  it("never splits a group edit across calls, however many notes", async () => {
    const { exec, names } = spyExec();
    await applyNoteEdits(exec, "c1", Array.from({ length: 40 }, (_, i) => ({ i, start: i + 1 })));
    expect(names()).toEqual(["set_note"]);
  });

  it("drops edits that carry no actual change", async () => {
    const { exec, names } = spyExec();
    await applyNoteEdits(exec, "c1", [{ i: 1 }, { i: 2 }]);
    expect(names()).toEqual([]);
  });

  it("keeps the scalar form for a single edit", async () => {
    const { exec, calls } = spyExec();
    await applyNoteEdits(exec, "c1", [{ i: 4, velocity: 90 }]);
    expect(calls[0].args).toEqual({ clipId: "c1", noteIndex: 4, velocity: 90 });
  });
});

describe("removeNotes", () => {
  it("deletes in DESCENDING index order — remove_note reindexes", async () => {
    const { exec, calls } = spyExec();
    await removeNotes(exec, "c1", [0, 2, 5]);
    expect(calls.filter((c) => c.command === "remove_note").map((c) => c.args.noteIndex)).toEqual([5, 2, 0]);
  });

  it("brackets a multi-note delete and sends nothing for an empty selection", async () => {
    const { exec, names } = spyExec();
    await removeNotes(exec, "c1", [1, 2]);
    expect(names()).toEqual(["batch_begin", "remove_note", "remove_note", "batch_end"]);
    const empty = spyExec();
    await removeNotes(empty.exec, "c1", []);
    expect(empty.names()).toEqual([]);
  });

  it("runs UNGROUPED, and sends no batch_end, when batch_begin is refused", async () => {
    // `inBatch` is process-global: an agent turn may already hold it. Degrading to N undo
    // steps is acceptable; closing a batch we do not own is not.
    const { exec, names } = spyExec(async (c) => ({ ok: c !== "batch_begin" }));
    await removeNotes(exec, "c1", [0, 1]);
    expect(names()).toEqual(["batch_begin", "remove_note", "remove_note"]);
  });

  it("still sends batch_end when a remove_note throws mid-group", async () => {
    // The worst failure available here. Without the finally the engine stays `inBatch`
    // forever, and every later edit of the session joins one ever-growing transaction.
    const { exec, names } = spyExec(async (c) => {
      if (c === "remove_note") throw new Error("engine said no");
      return { ok: true };
    });
    await expect(removeNotes(exec, "c1", [0, 1])).rejects.toThrow();
    expect(names()).toEqual(["batch_begin", "remove_note", "batch_end"]);
  });
});

describe("addNotes", () => {
  it("sends ONE add_note carrying the whole chord, so it is one undo step", async () => {
    const { exec, calls, names } = spyExec();
    await addNotes(exec, "c1", [
      { pitch: 60, start: 0, length: 1, velocity: 100 },
      { pitch: 64, start: 0, length: 1, velocity: 100 },
    ]);
    expect(names()).toEqual(["add_note"]);
    expect((calls[0].args.notes as unknown[]).length).toBe(2);
  });

  it("uses the scalar form for a single note", async () => {
    const { exec, calls } = spyExec();
    await addNotes(exec, "c1", [{ pitch: 60, start: 2, length: 1, velocity: 90 }]);
    expect(calls[0].args).toMatchObject({ clipId: "c1", pitch: 60, start: 2 });
    expect(calls[0].args.notes).toBeUndefined();
  });
});

describe("grouped", () => {
  it("does not open a batch for a single item", async () => {
    const { exec, names } = spyExec();
    await grouped(exec, "x", 1, async () => { await exec("set_note", {}); });
    expect(names()).toEqual(["set_note"]);
  });

  it("survives batch_begin itself throwing", async () => {
    const { exec, names } = spyExec(async (c) => {
      if (c === "batch_begin") throw new Error("bridge down");
      return { ok: true };
    });
    await grouped(exec, "x", 2, async () => { await exec("set_note", {}); });
    expect(names()).toEqual(["batch_begin", "set_note"]);
  });
});
