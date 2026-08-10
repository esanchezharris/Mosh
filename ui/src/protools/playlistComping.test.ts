import { describe, expect, it } from "vitest";
import {
  normalizePlaylistCompRange,
  playlistSecondsAtClientX,
} from "./playlistComping";

describe("Pro Tools playlist comp range geometry", () => {
  it("maps the pointer into clip time and clamps it to the visible clip", () => {
    expect(playlistSecondsAtClientX(350, 100, 1, 4, 100)).toBe(3.5);
    expect(playlistSecondsAtClientX(20, 100, 1, 4, 100)).toBe(1);
    expect(playlistSecondsAtClientX(700, 100, 1, 4, 100)).toBe(5);
  });

  it("normalizes reverse drags and rejects accidental micro-ranges", () => {
    expect(normalizePlaylistCompRange(4, 2, 1, 4)).toEqual({ start: 2, end: 4 });
    expect(normalizePlaylistCompRange(2, 2.019, 1, 4)).toBeNull();
    expect(normalizePlaylistCompRange(0, 8, 1, 4)).toEqual({ start: 1, end: 5 });
  });
});
