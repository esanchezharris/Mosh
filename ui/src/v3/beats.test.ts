import { beforeEach, describe, expect, it } from "vitest";
import { parseDrumPattern } from "../ui/drumPatternUtil";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { DEFAULT_DRUM_BEAT, dropDrumBeat } from "./beats";

describe("V3 default beat", () => {
  it("parses as one bar of three lanes with hits on every lane (anti-vacuity: the grammar is real)", () => {
    const parsed = parseDrumPattern(DEFAULT_DRUM_BEAT, 16, 0, 100);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bars).toBe(1);
    expect(parsed.lanePitches.length).toBe(3);
    expect(parsed.steps.length).toBeGreaterThan(8);
  });

  describe("dropDrumBeat against the mock backend", () => {
    beforeEach(async () => { __resetMockForTests(); await useStore.getState().refresh(); });

    it("adds one drum track and one clip with notes, selects it and opens the editor; one undo removes both", async () => {
      const before = useStore.getState().snapshot!;
      const dropped = await dropDrumBeat();
      expect(dropped).not.toBeNull();
      const after = useStore.getState().snapshot!;
      expect(after.tracks.length).toBe(before.tracks.length + 1);
      const track = after.tracks.find((t) => t.id === dropped!.trackId)!;
      expect(track.type).toBe("drum");
      const clip = track.clips.find((c) => c.id === dropped!.clipId)!;
      expect(clip.notes?.length ?? 0).toBeGreaterThan(8);
      expect(useStore.getState().selectedTrackId).toBe(track.id);
      expect(useStore.getState().editingClipId).toBe(clip.id);
      await useStore.getState().exec("undo");
      await useStore.getState().refresh();
      expect(useStore.getState().snapshot!.tracks.length).toBe(before.tracks.length);
    });
  });
});
