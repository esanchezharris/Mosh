import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const snapshot = () => mockSnapshot<Snapshot>();

describe("bridge.mock — import_midi_file mirrors the engine", () => {
  beforeEach(() => __resetMockForTests());

  it("lands one MIDI clip with notes on a new MIDI track, and one undo removes it", async () => {
    const before = (await snapshot()).tracks.length;
    const r = await run("import_midi_file", { file: "/Users/you/riff.mid" });
    expect(r.ok).toBe(true);
    const data = r.data as { trackId: string; clipId: string; noteCount: number; createdTrack: boolean };
    expect(data.createdTrack).toBe(true);
    expect(data.noteCount).toBeGreaterThan(0);
    const after = await snapshot();
    expect(after.tracks.length).toBe(before + 1);
    const track = after.tracks.find((t) => t.id === data.trackId)!;
    expect(track.name).toBe("riff");
    expect(track.clips.find((c) => c.id === data.clipId)!.type).toBe("midi");
    expect(track.plugins?.some((p) => p.isInstrument)).toBe(true);           // audible (DRM-001)
    expect(track.clips.find((c) => c.id === data.clipId)!.notes!.length).toBe(data.noteCount);
    expect((await run("undo")).ok).toBe(true);
    expect((await snapshot()).tracks.length).toBe(before);
  });

  it("lands onto a MIDI-capable selected track, refuses a wave track and a non-MIDI file", async () => {
    const s = await snapshot();
    const bass = s.tracks[1].id, keys = s.tracks[2].id;                     // Bass: MIDI clips; Keys: a wave clip
    const onto = await run("import_midi_file", { file: "/x/riff.mid", trackId: bass });
    expect(onto.ok).toBe(true);
    expect((onto.data as { createdTrack: boolean }).createdTrack).toBe(false);
    expect((await run("import_midi_file", { file: "/x/riff.mid", trackId: keys })).error).toMatch(/wave audio/);
    expect((await run("import_midi_file", { file: "/x/kick.wav" })).error).toMatch(/not a Standard MIDI File/);
    expect((await run("import_midi_file", { file: "/x/riff.mid", trackId: "nope" })).error).toMatch(/no track/);
    expect((await run("import_midi_file", {})).error).toMatch(/missing 'file'/);
  });
});
