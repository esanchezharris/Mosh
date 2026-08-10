import { describe, expect, it } from "vitest";
import type { Clip } from "../types";
import {
  nextPlaylistTakeIndex,
  promotedPlaylistClipId,
  resolvePlaylistCycleTarget,
} from "./playlistTakeCycle";

const CLIP: Clip = {
  id: "vocal-comp",
  name: "Lead Comp",
  type: "wave",
  start: 4,
  length: 6,
  offset: 0,
  sourceFile: "/tmp/lead.wav",
  hasRenderLayer: false,
  numTakes: 3,
  currentTakeIndex: 1,
};

describe("Pro Tools selection-scoped playlist cycling", () => {
  it("resolves only a finite range contained by a multi-take wave clip", () => {
    expect(resolvePlaylistCycleTarget(CLIP, { start: 5, end: 7 })).toEqual({
      clipId: "vocal-comp",
      start: 5,
      end: 7,
      currentTakeIndex: 1,
      takeCount: 3,
    });
    expect(resolvePlaylistCycleTarget(CLIP, { start: 3.9, end: 7 })).toBeNull();
    expect(resolvePlaylistCycleTarget({ ...CLIP, type: "midi" }, { start: 5, end: 7 })).toBeNull();
    expect(resolvePlaylistCycleTarget({ ...CLIP, numTakes: 1 }, { start: 5, end: 7 })).toBeNull();
    expect(resolvePlaylistCycleTarget(CLIP, { start: Number.NaN, end: 7 })).toBeNull();
  });

  it("wraps previous and next take indexes without selecting the current take", () => {
    expect(nextPlaylistTakeIndex(1, 3, 1)).toBe(2);
    expect(nextPlaylistTakeIndex(2, 3, 1)).toBe(0);
    expect(nextPlaylistTakeIndex(0, 3, -1)).toBe(2);
  });

  it("accepts only a string clip id from the promotion result envelope", () => {
    expect(promotedPlaylistClipId({
      ok: true,
      command: "promote_take_region",
      data: { clipId: "middle-segment" },
    })).toBe("middle-segment");
    expect(promotedPlaylistClipId({
      ok: true,
      command: "promote_take_region",
      data: { clipId: 42 },
    })).toBeNull();
    expect(promotedPlaylistClipId({
      ok: false,
      command: "promote_take_region",
      error: "locked",
    })).toBeNull();
  });
});
