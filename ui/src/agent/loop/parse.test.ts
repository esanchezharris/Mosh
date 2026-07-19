import { describe, it, expect } from "vitest";
import { parseLoopReply } from "./parse";

describe("parseLoopReply — the loop reply contract", () => {
  it("parses status/plan/commands and normalizes plan-step commands", () => {
    const r = parseLoopReply(JSON.stringify({
      intent: "ACK_WORKING",
      say: "on it",
      status: "continue",
      plan: [
        { goal: "set the tempo", commands: [{ command: "set_tempo", args: { bpm: "90" } }] },
        { goal: "lay the drums" },
      ],
    }));
    expect(r.status).toBe("continue");
    expect(r.plan).toHaveLength(2);
    // the same normalization pipeline as single-shot: numeric-string coerced
    expect(r.plan![0]!.commands).toEqual([{ command: "set_tempo", args: { bpm: 90 } }]);
    expect(r.plan![1]!.commands).toBeUndefined();
  });

  it("tolerates code fences and surrounding prose", () => {
    const r = parseLoopReply('Sure!\n```json\n{"intent":"DONE","status":"done"}\n```');
    expect(r.status).toBe("done");
    expect(r.intent).toBe("DONE");
  });

  it("degrades a missing status: commands present → continue, none → done", () => {
    expect(parseLoopReply('{"commands":[{"command":"set_tempo","args":{"bpm":90}}]}').status).toBe("continue");
    expect(parseLoopReply('{"intent":"DONE","say":"all set"}').status).toBe("done");
  });

  it("a plan with no status is a continue", () => {
    expect(parseLoopReply('{"plan":[{"goal":"x"}]}').status).toBe("continue");
  });

  it("unparseable content parks as need_user (never fabricates commands)", () => {
    const r = parseLoopReply("I think you should try turning it up?");
    expect(r.status).toBe("need_user");
    expect(r.parseFailed).toBe(true);
    expect(r.commands).toBeUndefined();
  });

  it("drops empty plan entries and normalizes top-level commands too", () => {
    const r = parseLoopReply(JSON.stringify({
      status: "continue",
      plan: [{ goal: "" }, { goal: "real step" }],
      commands: [{ command: "add_drum_pattern", args: { pattern: { kick: "x..." } } }],
    }));
    expect(r.plan).toEqual([{ goal: "real step", commands: undefined }]);
    expect(r.commands).toEqual([{ command: "add_drum_pattern", args: { pattern: "kick: x..." } }]);
  });
});
