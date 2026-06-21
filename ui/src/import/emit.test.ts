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

  it("maps a midi clip to add_midi_clip + add_note and an audio clip (with a path) to import_clip", () => {
    const program = emitCommands(
      ir({
        tracks: [
          {
            type: "audio",
            clips: [
              { kind: "midi", start: 0, length: 2, notes: [{ pitch: 36, start: 0, length: 1, velocity: 100 }] },
              { kind: "wave", name: "loop", start: 4, length: 4, sourceFile: "/abs/loop.wav" },
            ],
          },
        ],
      }),
    );
    const names = program.commands.map((c) => c.command);
    expect(names).toContain("add_midi_clip");
    expect(names).toContain("add_note");
    expect(names).toContain("import_clip"); // audio is no longer a test-tone placeholder
    expect(names).not.toContain("add_test_tone_clip");
    expect(program.commands.find((c) => c.command === "add_midi_clip")!.bind).toBe("c0_0");
    expect(program.commands.find((c) => c.command === "add_note")!.args).toEqual({
      clipId: "$c0_0",
      pitch: 36,
      start: 0,
      length: 1,
      velocity: 100,
    });
    expect(program.commands.find((c) => c.command === "import_clip")!.args).toEqual({
      trackId: "$t0",
      file: "/abs/loop.wav", // absolute path passes through unchanged
      startSeconds: 4,
      name: "loop", // no `length` — import_clip imports the whole file (cmdImportClip models no trim)
    });
    // a real import, not a logged loss
    expect(program.unmappable.some((u) => /placeholder/.test(u))).toBe(false);
  });

  it("resolves a project-relative audio path against the project file's directory", () => {
    const program = emitCommands({
      format: "rpp",
      source: "/Users/me/beats/song.rpp",
      unmappable: [],
      session: { tracks: [{ type: "audio", clips: [{ kind: "wave", start: 0, length: 2, sourceFile: "Media/kick.wav" }] }] },
    });
    expect(program.commands.find((c) => c.command === "import_clip")!.args.file).toBe("/Users/me/beats/Media/kick.wav");
  });

  it("normalizes Windows separators in a relative path and passes a foreign drive-letter path through", () => {
    const prog = (sourceFile: string) =>
      emitCommands({
        format: "rpp",
        source: "/Users/me/beats/song.rpp",
        unmappable: [],
        session: { tracks: [{ type: "audio", clips: [{ kind: "wave", start: 0, length: 1, sourceFile }] }] },
      }).commands.find((c) => c.command === "import_clip")!.args.file;
    expect(prog("media\\kick.wav")).toBe("/Users/me/beats/media/kick.wav"); // relative Windows path
    expect(prog("D:\\Samples\\snare.wav")).toBe("D:\\Samples\\snare.wav"); // foreign drive-letter absolute — passed through
    expect(prog("\\\\nas\\share\\hat.wav")).toBe("\\\\nas\\share\\hat.wav"); // foreign UNC path — passed through intact
  });

  it("falls back to a logged test-tone placeholder when an audio clip has no source path", () => {
    const program = emitCommands(
      ir({ tracks: [{ type: "audio", clips: [{ kind: "wave", name: "mystery", start: 1, length: 3 }] }] }),
    );
    const names = program.commands.map((c) => c.command);
    expect(names).toContain("add_test_tone_clip");
    expect(names).not.toContain("import_clip");
    expect(program.commands.find((c) => c.command === "add_test_tone_clip")!.args).toEqual({ trackId: "$t0", start: 1, seconds: 3 });
    expect(program.unmappable.some((u) => /placeholder/.test(u))).toBe(true);
  });
});
