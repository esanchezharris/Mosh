import { describe, it, expect } from "vitest";
import { emitCommands } from "./emit";
import { replayProgram } from "./bindReplay";
import type { ImportIR } from "./moshIR";

describe("replayProgram (import → mock verifier)", () => {
  it("clean-applies a reconstructed session from a clean slate", async () => {
    const ir: ImportIR = {
      format: "rpp",
      source: "demo",
      unmappable: [],
      session: {
        tempo: 128,
        tracks: [
          {
            name: "Drums",
            type: "drum",
            volumeDb: 0,
            clips: [
              {
                kind: "midi",
                start: 0,
                length: 4,
                notes: [
                  { pitch: 36, start: 0, length: 1, velocity: 120 },
                  { pitch: 38, start: 1, length: 1, velocity: 110 },
                ],
              },
            ],
          },
          { name: "Bass", type: "audio", volumeDb: -3, pan: 0.1, clips: [{ kind: "wave", name: "sub", start: 0, length: 8 }] },
        ],
      },
    };

    const r = await replayProgram(emitCommands(ir));

    expect(r.cleanValidate).toBe(true);
    expect(r.cleanApply).toBe(true);
    expect(r.unbound).toEqual([]);
    expect(r.finalSnapshot.tracks).toHaveLength(2); // reconstructed from an empty slate
    const drums = r.finalSnapshot.tracks.find((t) => t.name === "Drums")!;
    expect(drums.clips[0].type).toBe("midi");
    expect(drums.clips[0].notes).toHaveLength(2);
    const bass = r.finalSnapshot.tracks.find((t) => t.name === "Bass")!;
    expect(bass.volumeDb).toBe(-3);
    expect(r.finalSnapshot.session.tempo).toBe(128);
  });

  it("reports an unbound ref without throwing (clean-apply false)", async () => {
    const r = await replayProgram({
      commands: [{ command: "set_track_volume", args: { trackId: "$missing", db: 0 } }],
      unmappable: [],
    });
    expect(r.cleanApply).toBe(false);
    expect(r.unbound).toContain("$missing");
  });
});
