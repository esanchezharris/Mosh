import { describe, it, expect } from "vitest";
import { emitCommands } from "./emit";
import type { ImportIR } from "./moshIR";

const ir = (session: Partial<ImportIR["session"]>): ImportIR => ({
  format: "rpp",
  source: "x",
  unmappable: [],
  session: { tracks: [], ...session },
});

describe("emitCommands", () => {
  it("emits session-level commands, then per-track create + mixer with $refs", () => {
    const cmds = emitCommands(
      ir({
        tempo: 140,
        timeSig: { numerator: 4, denominator: 4 },
        tracks: [{ name: "Bass", type: "audio", volumeDb: -3, pan: -0.2, clips: [] }],
      }),
    ).commands;

    expect(cmds[0]).toEqual({ command: "set_tempo", args: { bpm: 140 } });
    expect(cmds[1]).toEqual({ command: "set_time_signature", args: { numerator: 4, denominator: 4 } });
    expect(cmds.find((c) => c.command === "create_track")).toMatchObject({
      args: { name: "Bass", type: "audio" },
      bind: "t0",
    });
    expect(cmds.find((c) => c.command === "set_track_volume")!.args).toEqual({ trackId: "$t0", db: -3 });
    expect(cmds.find((c) => c.command === "set_track_pan")!.args).toEqual({ trackId: "$t0", pan: -0.2 });
  });

  it("maps a midi clip to add_midi_clip + add_note (clip-ref bound) and a wave clip to a logged placeholder", () => {
    const program = emitCommands(
      ir({
        tracks: [
          {
            type: "audio",
            clips: [
              { kind: "midi", start: 0, length: 2, notes: [{ pitch: 36, start: 0, length: 1, velocity: 100 }] },
              { kind: "wave", name: "loop", start: 4, length: 4, sourceFile: "/x/loop.wav" },
            ],
          },
        ],
      }),
    );
    const names = program.commands.map((c) => c.command);
    expect(names).toContain("add_midi_clip");
    expect(names).toContain("add_note");
    expect(names).toContain("add_test_tone_clip");
    expect(program.commands.find((c) => c.command === "add_midi_clip")!.bind).toBe("c0_0");
    expect(program.commands.find((c) => c.command === "add_note")!.args).toEqual({
      clipId: "$c0_0",
      pitch: 36,
      start: 0,
      length: 1,
      velocity: 100,
    });
    expect(program.unmappable.some((u) => /placeholder/.test(u))).toBe(true);
  });
});
