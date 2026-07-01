import { describe, it, expect } from "vitest";
import { mockBrainReply } from "./brainMock";

describe("mockBrainReply beat requests", () => {
  it("turns a typed beat ask into the real recipe generator command", () => {
    const r = mockBrainReply("make a dark trap beat at 140 bpm in F minor seed 7 with lead", null);

    expect(r.intent).toBe("ACK_GOT_IT");
    expect(r.commands).toEqual([
      {
        command: "generate_beat_recipe",
        args: { mood: "dark", tempo: 140, key: "F minor", seed: 7, lead: true },
      },
    ]);
  });

  it("keeps simple track creation on the old narrow fallback", () => {
    const r = mockBrainReply("add drums", null);

    expect(r.commands).toEqual([{ command: "create_track", args: { name: "Drum" } }]);
  });

  it("does not steal beatbox capture requests", () => {
    const r = mockBrainReply("sketch this beatbox at 140 bpm", null);

    expect(r.commands).toEqual([{ command: "set_tempo", args: { bpm: 140 } }]);
  });
});
