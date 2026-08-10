import { describe, expect, it } from "vitest";
import type { Clip, Snapshot, Track } from "../types";
import {
  buildProToolsUniverseTracks,
  proToolsUniverseFrame,
  proToolsUniverseTarget,
} from "./proToolsUniverse";

const clip = (id: string, start: number, length: number, hidden = false): Clip => ({
  id,
  name: id,
  type: id.includes("midi") ? "midi" : "wave",
  start,
  length,
  offset: 0,
  hasRenderLayer: false,
  ...(hidden ? { hidden: true } : {}),
});

const track = (id: string, index: number, clips: readonly Clip[], extra: Partial<Track> = {}): Track => ({
  id,
  index,
  name: id,
  type: "audio",
  clips: [...clips],
  ...extra,
});

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-universe.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    track("Vocal", 0, [clip("verse", 4, 4), clip("hidden-render", 12, 2, true)], { color: "#a24b55" }),
    track("Bass", 1, [clip("midi-bass", 0, 8)], { color: "#4778b8" }),
    track("Empty", 2, []),
    track("Group", 3, [], { isGroup: true }),
    track("Aux", 4, [], { isReturn: true }),
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Pro Tools Universe geometry", () => {
  it("preserves shown Edit-track order and maps clip spans into the full session", () => {
    expect(buildProToolsUniverseTracks(SNAPSHOT, 16)).toEqual([
      {
        trackId: "Vocal",
        trackName: "Vocal",
        color: "#a24b55",
        clips: [{ clipId: "verse", startFraction: 0.25, widthFraction: 0.25 }],
      },
      {
        trackId: "Bass",
        trackName: "Bass",
        color: "#4778b8",
        clips: [{ clipId: "midi-bass", startFraction: 0, widthFraction: 0.5 }],
      },
      { trackId: "Empty", trackName: "Empty", clips: [] },
    ]);
  });

  it("normalizes and clamps the framed current Edit-window area", () => {
    expect(proToolsUniverseFrame({
      scrollLeft: 400,
      scrollTop: 92,
      clientWidth: 800,
      clientHeight: 184,
      scrollWidth: 1_600,
      scrollHeight: 368,
    })).toEqual({ left: 0.25, top: 0.25, width: 0.5, height: 0.5 });

    expect(proToolsUniverseFrame({
      scrollLeft: 999,
      scrollTop: 999,
      clientWidth: 400,
      clientHeight: 200,
      scrollWidth: 800,
      scrollHeight: 400,
    })).toEqual({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 });
  });

  it("centers click navigation while respecting both scroll boundaries", () => {
    const viewport = {
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 800,
      clientHeight: 184,
      scrollWidth: 1_600,
      scrollHeight: 368,
    };

    expect(proToolsUniverseTarget({ x: 0.5, y: 0.5 }, viewport))
      .toEqual({ scrollLeft: 400, scrollTop: 92 });
    expect(proToolsUniverseTarget({ x: 1, y: 1 }, viewport))
      .toEqual({ scrollLeft: 800, scrollTop: 184 });
    expect(proToolsUniverseTarget({ x: -1, y: -1 }, viewport))
      .toEqual({ scrollLeft: 0, scrollTop: 0 });
  });
});
