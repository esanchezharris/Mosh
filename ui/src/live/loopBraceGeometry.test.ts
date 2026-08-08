// Unit pins for the loop-brace geometry (loopBraceGeometry.ts).

import { describe, it, expect } from "vitest";
import { moveLoop, resizeLoopEdge, loopKeyEdit } from "./loopBraceGeometry";

const S = { start: 2, end: 6 };   // a 4s loop inside 32s of content

describe("moveLoop", () => {
  it("moves the whole span, length preserved", () => {
    expect(moveLoop(S, 3, 32)).toEqual({ start: 5, end: 9 });
    expect(moveLoop(S, -1, 32)).toEqual({ start: 1, end: 5 });
  });
  it("clamps at both ends of the content", () => {
    expect(moveLoop(S, -99, 32)).toEqual({ start: 0, end: 4 });
    expect(moveLoop(S, 99, 32)).toEqual({ start: 28, end: 32 });
  });
});

describe("resizeLoopEdge", () => {
  it("moves each edge independently", () => {
    expect(resizeLoopEdge(S, "start", 3, 0.05, 32)).toEqual({ start: 3, end: 6 });
    expect(resizeLoopEdge(S, "end", 10, 0.05, 32)).toEqual({ start: 2, end: 10 });
  });
  it("the edges can't cross (minLen respected)", () => {
    expect(resizeLoopEdge(S, "start", 99, 0.5, 32)).toEqual({ start: 5.5, end: 6 });
    expect(resizeLoopEdge(S, "end", 0, 0.5, 32)).toEqual({ start: 2, end: 2.5 });
  });
  it("clamps inside the content", () => {
    expect(resizeLoopEdge(S, "start", -4, 0.05, 32)).toEqual({ start: 0, end: 6 });
    expect(resizeLoopEdge(S, "end", 99, 0.05, 32)).toEqual({ start: 2, end: 32 });
  });
});

describe("loopKeyEdit", () => {
  it("plain arrows move by the grid step", () => {
    expect(loopKeyEdit(S, "ArrowLeft", false, 0.5, 32, 0.05)).toEqual({ start: 1.5, end: 5.5 });
    expect(loopKeyEdit(S, "ArrowRight", false, 0.5, 32, 0.05)).toEqual({ start: 2.5, end: 6.5 });
  });
  it("Mod+← halves, Mod+→ doubles (start-anchored)", () => {
    expect(loopKeyEdit(S, "ArrowLeft", true, 0.5, 32, 0.05)).toEqual({ start: 2, end: 4 });
    expect(loopKeyEdit(S, "ArrowRight", true, 0.5, 32, 0.05)).toEqual({ start: 2, end: 10 });
  });
  it("halving floors at minLen; doubling clamps to the content", () => {
    expect(loopKeyEdit({ start: 2, end: 2.08 }, "ArrowLeft", true, 0.5, 32, 0.05)).toEqual({ start: 2, end: 2.05 });
    expect(loopKeyEdit({ start: 24, end: 30 }, "ArrowRight", true, 0.5, 32, 0.05)).toEqual({ start: 24, end: 32 });
  });
  it("other keys are not the brace's business", () => {
    expect(loopKeyEdit(S, "ArrowUp", false, 0.5, 32, 0.05)).toBeNull();
    expect(loopKeyEdit(S, "z", false, 0.5, 32, 0.05)).toBeNull();
  });
});
