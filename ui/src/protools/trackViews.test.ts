import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import { TRACK_ROW_HEIGHT } from "./layout";
import {
  PROTOOLS_PLAYLIST_ROW_HEIGHT,
  nextCommonProToolsTrackView,
  proToolsTrackRowHeight,
  proToolsTrackViewOptions,
} from "./trackViews";

const audioTrack = (numTakes?: number): Track => ({
  id: "audio-1",
  index: 0,
  name: "Lead Vocal",
  type: "audio",
  clips: [{
    id: "clip-1",
    name: "Lead",
    type: "wave",
    start: 0,
    length: 4,
    offset: 0,
    sourceFile: "/tmp/lead.wav",
    hasRenderLayer: false,
    numTakes,
    currentTakeIndex: 0,
  }],
});

const midiTrack: Track = {
  id: "midi-1",
  index: 1,
  name: "Keys",
  type: "midi",
  isInstrument: true,
  clips: [],
};

describe("Pro Tools Track View model", () => {
  it("offers Playlists only for audio and keeps Minus on the documented common pair", () => {
    expect(proToolsTrackViewOptions(audioTrack()).map((option) => option.value))
      .toEqual(["waveform", "playlists", "volume"]);
    expect(proToolsTrackViewOptions(midiTrack).map((option) => option.value))
      .toEqual(["clips", "notes"]);

    expect(nextCommonProToolsTrackView(audioTrack(), "waveform")).toBe("volume");
    expect(nextCommonProToolsTrackView(audioTrack(), "volume")).toBe("waveform");
    expect(nextCommonProToolsTrackView(audioTrack(), "playlists")).toBe("volume");
    expect(nextCommonProToolsTrackView(midiTrack, "clips")).toBe("notes");
  });

  it("adds one aligned row per take and preserves an empty Playlists row", () => {
    expect(proToolsTrackRowHeight(audioTrack(3), "playlists"))
      .toBe(TRACK_ROW_HEIGHT + 3 * PROTOOLS_PLAYLIST_ROW_HEIGHT);
    expect(proToolsTrackRowHeight(audioTrack(), "playlists"))
      .toBe(TRACK_ROW_HEIGHT + PROTOOLS_PLAYLIST_ROW_HEIGHT);
    expect(proToolsTrackRowHeight(audioTrack(3), "waveform")).toBe(TRACK_ROW_HEIGHT);
    expect(proToolsTrackRowHeight(audioTrack(3), "playlists", true, 0.75))
      .toBe(69 + 3 * 20 + 21);
  });
});
