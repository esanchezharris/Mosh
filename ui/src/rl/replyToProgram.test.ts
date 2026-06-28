import { describe, it, expect } from "vitest";
import { replyToProgram } from "./replyToProgram";

const OUT = "/tmp/rl/out.wav";

describe("replyToProgram", () => {
  it("appends an export_audio to the parsed commands", () => {
    const reply = JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "set_tempo", args: { bpm: 120 } }],
    });
    const { commands, deferred } = replyToProgram(reply, OUT);
    expect(deferred).toBe(false);
    expect(commands.map((c) => c.command)).toEqual(["set_tempo", "export_audio"]);
    expect(commands.at(-1)).toEqual({ command: "export_audio", args: { file: OUT, format: "wav" } });
  });

  it("defers (no render) when the reply emits no commands", () => {
    // a question-phrased ack with no commands — the 'acts-shy' failure
    const reply = JSON.stringify({ intent: "ACK_GOT_IT", say: "Sure, what tempo?" });
    expect(replyToProgram(reply, OUT)).toEqual({ commands: [], deferred: true });
  });

  it("defers on malformed / non-JSON replies", () => {
    expect(replyToProgram("not json at all", OUT).deferred).toBe(true);
    expect(replyToProgram("", OUT).deferred).toBe(true);
  });

  it("normalizes the function-call-string reply form (parseReply parity)", () => {
    // the policy sometimes echoes the catalog as call-strings; parseReply maps positional args
    const reply = JSON.stringify({ intent: "ACK_GOT_IT", commands: ['add_midi_clip("17")'] });
    const { commands, deferred } = replyToProgram(reply, OUT);
    expect(deferred).toBe(false);
    expect(commands[0].command).toBe("add_midi_clip");
    expect(commands.at(-1)?.command).toBe("export_audio");
  });

  it("honors a non-default export format", () => {
    const reply = JSON.stringify({ commands: [{ command: "set_tempo", args: { bpm: 90 } }] });
    expect(replyToProgram(reply, "/tmp/rl/o.aiff", "aiff").commands.at(-1)).toEqual({
      command: "export_audio",
      args: { file: "/tmp/rl/o.aiff", format: "aiff" },
    });
  });

  it("renders a content-producing reply (note population) into a program", () => {
    const reply = JSON.stringify({
      commands: [
        { command: "add_midi_clip", args: { trackId: "2", start: 0 } },
        { command: "add_note", args: { clipId: "5", pitch: 60, start: 0, length: 1, velocity: 100 } },
      ],
    });
    const { commands } = replyToProgram(reply, OUT);
    expect(commands.map((c) => c.command)).toEqual(["add_midi_clip", "add_note", "export_audio"]);
  });
});
