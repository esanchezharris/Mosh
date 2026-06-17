import { describe, it, expect } from "vitest";
import { matchFastPath } from "./fastPath";

const ctx = (mode: "idle" | "recording" | "reviewing" = "idle") => ({ mode, tempo: 120, timeSigNum: 4 });
const cmds = (a: ReturnType<typeof matchFastPath>) => (a as { commands: { command: string; args?: Record<string, unknown> }[] }).commands;

describe("matchFastPath — global commands (any mode)", () => {
  it("maps 'play it' to a transport toggle", () => {
    const a = matchFastPath("play it", ctx());
    expect(a).toMatchObject({ kind: "commands" });
    expect(cmds(a)[0]).toMatchObject({ command: "set_transport", args: { action: "toggle" } });
  });
  it("maps 'from the top' to to_start", () => {
    expect(cmds(matchFastPath("take it from the top", ctx()))[0].args!.action).toBe("to_start");
  });
  it("maps 'undo' / 'save'", () => {
    expect(cmds(matchFastPath("undo that", ctx()))[0].command).toBe("undo");
    expect(cmds(matchFastPath("save it", ctx()))[0].command).toBe("save");
  });
});

describe("matchFastPath — record loop + state gating", () => {
  it("'put me in' enters record from idle", () => {
    expect(matchFastPath("put me in", ctx("idle"))).toMatchObject({ kind: "enterRecord" });
  });
  it("'keep that take' is keepTake only when reviewing", () => {
    expect(matchFastPath("keep that take", ctx("reviewing"))).toMatchObject({ kind: "keepTake" });
    expect(matchFastPath("keep that take", ctx("idle"))).toBeNull();
  });
  it("short 'yeah'/'nah' only resolve when reviewing", () => {
    expect(matchFastPath("yeah", ctx("reviewing"))).toMatchObject({ kind: "keepTake" });
    expect(matchFastPath("nah", ctx("reviewing"))).toMatchObject({ kind: "enterRecord" });
    expect(matchFastPath("yeah", ctx("idle"))).toBeNull();
  });
  it("'next take' / 'previous take' navigate in reviewing", () => {
    expect(matchFastPath("next take", ctx("reviewing"))).toMatchObject({ kind: "navTake", delta: 1 });
    expect(matchFastPath("go back a take", ctx("reviewing"))).toMatchObject({ kind: "navTake", delta: -1 });
  });
});

describe("matchFastPath — parametrized + safety", () => {
  it("extracts a bar number (digit or word)", () => {
    expect(matchFastPath("put me in at bar 8", ctx("idle"))).toMatchObject({ kind: "enterRecord", bar: 8 });
    expect(matchFastPath("put me in at eight", ctx("idle"))).toMatchObject({ kind: "enterRecord", bar: 8 });
  });
  it("falls through (null) on ambiguous / unknown utterances", () => {
    expect(matchFastPath("play the drums and add some reverb", ctx())).toBeNull();
    expect(matchFastPath("make the bass warmer", ctx())).toBeNull();
  });
});
