import { describe, expect, it } from "vitest";
import type { Clip, Snapshot, Track } from "../types";
import {
  listMidiEditorTracks,
  projectMidiEditorContextNotes,
  resolveMidiEditorTargetClip,
} from "./proToolsMidiEditorModel";

const midiClip = (
  id: string,
  start: number,
  length: number,
  notes: NonNullable<Clip["notes"]> = [],
): Clip => ({
  id,
  name: id,
  type: "midi",
  start,
  length,
  offset: 0,
  hasRenderLayer: false,
  notes,
});

const track = (id: string, index: number, clips: Clip[], extra: Partial<Track> = {}): Track => ({
  id,
  index,
  name: id,
  type: "audio",
  clips,
  ...extra,
});

const targetClip = midiClip("drums-clip", 2, 4, [
  { i: 0, pitch: 60, start: 0, length: 1, velocity: 100 },
]);
const bassClip = midiClip("bass-clip", 0, 8, [
  { i: 0, pitch: 36, start: 3, length: 2, velocity: 90 },
  { i: 1, pitch: 38, start: 5, length: 1, velocity: 80 },
  { i: 2, pitch: 40, start: 12, length: 1, velocity: 70 },
]);

const snapshot: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    editFile: "/tmp/protools-midi.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    track("drums", 0, [targetClip], { name: "Drums", type: "drum", isInstrument: true, color: "#a24b55" }),
    track("bass", 1, [bassClip], { name: "Bass", isInstrument: true, color: "#4778b8" }),
    track("keys", 2, [{ ...midiClip("not-midi", 0, 4), type: "wave" }], { name: "Keys" }),
    track("group", 3, [midiClip("group-midi", 0, 4)], { name: "Folder", isGroup: true }),
    track("return", 4, [midiClip("return-midi", 0, 4)], { name: "Verb", isReturn: true }),
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Pro Tools MIDI Editor model", () => {
  it("lists only MIDI-capable working tracks and resolves one explicit target clip per row", () => {
    expect(listMidiEditorTracks(snapshot, targetClip.id)).toEqual([
      {
        trackId: "drums",
        trackName: "Drums",
        color: "#a24b55",
        clipCount: 1,
        targetClipId: "drums-clip",
        isTarget: true,
      },
      {
        trackId: "bass",
        trackName: "Bass",
        color: "#4778b8",
        clipCount: 1,
        targetClipId: "bass-clip",
        isTarget: false,
      },
    ]);
  });

  it("chooses the candidate with the greatest timeline overlap, then nearest distance", () => {
    const candidates = track("candidate", 9, [
      midiClip("far-before", 0, 1),
      midiClip("short-overlap", 3, 1),
      midiClip("full-overlap", 1, 8),
    ]);

    expect(resolveMidiEditorTargetClip(candidates, targetClip)?.id).toBe("full-overlap");
  });

  it("projects only visible non-target notes into the target clip beat window", () => {
    expect(projectMidiEditorContextNotes(snapshot, targetClip.id, ["drums", "bass"]))
      .toEqual([
        {
          key: "bass:bass-clip:0",
          trackId: "bass",
          trackName: "Bass",
          clipId: "bass-clip",
          clipName: "bass-clip",
          color: "#4778b8",
          pitch: 36,
          start: 0,
          length: 1,
          velocity: 90,
        },
        {
          key: "bass:bass-clip:1",
          trackId: "bass",
          trackName: "Bass",
          clipId: "bass-clip",
          clipName: "bass-clip",
          color: "#4778b8",
          pitch: 38,
          start: 1,
          length: 1,
          velocity: 80,
        },
      ]);
    expect(projectMidiEditorContextNotes(snapshot, targetClip.id, ["drums"])).toEqual([]);
  });
});
