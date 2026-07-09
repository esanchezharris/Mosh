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

describe("matchFastPath — state-aware track ops (mute/solo by name)", () => {
  const T = [
    { id: "1", name: "Drums" },
    { id: "2", name: "Bass" },
    { id: "3", name: "Melody" },
    { id: "4", name: "Vocal" },
  ];
  const tctx = (mode: "idle" | "recording" | "reviewing" = "idle") => ({ mode, tempo: 120, timeSigNum: 4, tracks: T });
  const muted = (a: ReturnType<typeof matchFastPath>) =>
    cmds(a).filter((c) => c.command === "set_track_mute" && c.args!.mute === true).map((c) => c.args!.trackId).sort();

  it("'mute everything but the drums and bass' mutes only the complement", () => {
    expect(muted(matchFastPath("mute everything but the drums and bass", tctx()))).toEqual(["3", "4"]);
  });

  it("handles 'except' and a single keep-track", () => {
    expect(muted(matchFastPath("mute everything except the drums", tctx()))).toEqual(["2", "3", "4"]);
  });

  it("'solo the drums and bass' solos exactly those tracks", () => {
    const a = matchFastPath("solo the drums and bass", tctx());
    expect(cmds(a).map((c) => [c.command, c.args!.trackId])).toEqual([["set_track_solo", "1"], ["set_track_solo", "2"]]);
  });

  it("falls through when fuzzy track matching ties across multiple candidates", () => {
    const ambiguousCtx = () => ({
      mode: "idle" as const,
      tempo: 120,
      timeSigNum: 4,
      tracks: [
        { id: "1", name: "Vocal Lead" },
        { id: "2", name: "Vocal Bus" },
        { id: "3", name: "Drums" },
      ],
    });
    expect(matchFastPath("solo the vocal", ambiguousCtx())).toBeNull();
  });

  it("clears stale solos on non-target tracks before soloing the targets", () => {
    const soloCtx = () => ({
      mode: "idle" as const,
      tempo: 120,
      timeSigNum: 4,
      tracks: [
        { id: "1", name: "Drums", solo: false },
        { id: "2", name: "Bass", solo: false },
        { id: "3", name: "Melody", solo: true },
      ],
    });
    const a = matchFastPath("solo the drums and bass", soloCtx());
    expect(cmds(a).map((c) => [c.command, c.args!.trackId, c.args!.solo])).toEqual([
      ["set_track_solo", "3", false],
      ["set_track_solo", "1", true],
      ["set_track_solo", "2", true],
    ]);
  });

  it("'mute the vocals' mutes the fuzzy-matched track", () => {
    expect(muted(matchFastPath("mute the vocals", tctx()))).toEqual(["4"]);
  });

  it("falls through when a named track does not exist", () => {
    expect(matchFastPath("mute everything but the piano", tctx())).toBeNull();
    expect(matchFastPath("solo the strings", tctx())).toBeNull();
  });

  it("does not fire without a track list or while recording", () => {
    expect(matchFastPath("mute everything but the drums and bass", ctx())).toBeNull();
    expect(matchFastPath("solo the drums", tctx("recording"))).toBeNull();
  });
});
