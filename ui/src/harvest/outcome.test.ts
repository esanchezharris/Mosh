import { describe, it, expect } from "vitest";
import { computeUndoneTurns, type UndoEvent } from "./outcome";

const turn = (turnIndex: number): UndoEvent => ({ kind: "push", unit: { turnIndex } });
const cmd: UndoEvent = { kind: "push", unit: { turnIndex: null } }; // standalone undoable command
const undo: UndoEvent = { kind: "undo" };
const redo: UndoEvent = { kind: "redo" };

describe("computeUndoneTurns", () => {
  it("undo after a turn marks that turn undone", () => {
    expect([...computeUndoneTurns([turn(0), undo])]).toEqual([0]);
  });

  it("undo hits the most-recent unit — an interleaved manual command, not the earlier turn", () => {
    expect([...computeUndoneTurns([turn(0), cmd, undo])]).toEqual([]);
  });

  it("undo then redo re-applies the turn (not undone)", () => {
    expect([...computeUndoneTurns([turn(0), undo, redo])]).toEqual([]);
  });

  it("undo pops the latest of several turns", () => {
    expect([...computeUndoneTurns([turn(0), turn(1), undo])]).toEqual([1]);
  });

  it("a new unit after an undo clears redo but leaves the turn undone", () => {
    expect([...computeUndoneTurns([turn(0), undo, turn(1)])]).toEqual([0]);
  });

  it("an undo with nothing on the stack is a no-op", () => {
    expect([...computeUndoneTurns([undo, turn(0)])]).toEqual([]);
  });
});
