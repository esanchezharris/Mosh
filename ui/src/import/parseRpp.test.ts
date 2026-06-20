import { describe, it, expect } from "vitest";
import { parseRpp } from "./parseRpp";

// Inline synthetic project mirroring real REAPER structure (quoted + unquoted
// NAMEs, VOLPAN linear gain, MUTESOLO, a WAVE item, an empty track).
const RPP = `<REAPER_PROJECT 0.1 "6.11/x64" 123
  TEMPO 140 3 4
  <TRACK '{GUID1}'
    NAME "Bass"
    VOLPAN 0.5 -0.3 -1 -1 1
    MUTESOLO 1 0 0
    <FXCHAIN
      <VST "VST: Thing" "Thing.vst" 0 ""
      >
    >
    <ITEM
      POSITION 2.5
      LENGTH 8
      NAME "sub loop"
      VOLPAN 1 0 1 -1
      <SOURCE WAVE
        FILE "Media/sub.wav"
      >
    >
  >
  <TRACK '{GUID2}'
    NAME Empty
    VOLPAN 1 0 -1 -1 1
    MUTESOLO 0 1 0
  >
>
`;

describe("parseRpp", () => {
  it("extracts tempo + time signature", () => {
    const ir = parseRpp(RPP, "demo.rpp");
    expect(ir.format).toBe("rpp");
    expect(ir.session.tempo).toBe(140);
    expect(ir.session.timeSig).toEqual({ numerator: 3, denominator: 4 });
  });

  it("extracts tracks with name, volume (linear→dB), pan, mute/solo", () => {
    const { session } = parseRpp(RPP, "demo.rpp");
    expect(session.tracks).toHaveLength(2);
    const bass = session.tracks[0];
    expect(bass.name).toBe("Bass");
    expect(bass.volumeDb).toBeCloseTo(-6.02, 1); // 20*log10(0.5)
    expect(bass.pan).toBeCloseTo(-0.3, 5);
    expect(bass.mute).toBe(true);
    expect(bass.solo).toBe(false);
    const empty = session.tracks[1];
    expect(empty.name).toBe("Empty"); // unquoted NAME token
    expect(empty.mute).toBe(false);
    expect(empty.solo).toBe(true);
    expect(empty.clips).toHaveLength(0);
  });

  it("extracts a WAVE item as a wave clip with position/length/name/source", () => {
    const { session } = parseRpp(RPP, "demo.rpp");
    const clip = session.tracks[0].clips[0];
    expect(clip.kind).toBe("wave");
    expect(clip.start).toBe(2.5);
    expect(clip.length).toBe(8);
    expect(clip.name).toBe("sub loop");
    expect(clip.sourceFile).toBe("Media/sub.wav");
  });

  it("logs FX chains as unmappable rather than dropping them silently", () => {
    const ir = parseRpp(RPP, "demo.rpp");
    expect(ir.unmappable.some((u) => /FX/i.test(u))).toBe(true);
  });
});

// A MIDI item: REAPER stores notes in <SOURCE MIDI> as delta-PPQ E/e events.
// HASDATA gives the PPQ (960). `E` = unselected, `e` = selected — both real notes.
// Status high-nibble 9 = note-on, 8 = note-off; other statuses (b0=CC) are skipped.
const RPP_MIDI = `<REAPER_PROJECT 0.1 "6.11/x64" 1
  TEMPO 120 4 4
  <TRACK
    NAME Keys
    <ITEM
      POSITION 1.5
      LENGTH 2
      NAME riff
      <SOURCE MIDI
        HASDATA 1 960 QN
        E 0 90 3c 64
        E 480 80 3c 00
        e 0 91 40 50
        E 960 81 40 00
        E 0 b0 7b 00
      >
    >
  >
>
`;

describe("parseRpp MIDI notes", () => {
  it("extracts delta-PPQ notes from <SOURCE MIDI> into beats (E + e, channels, CC skipped)", () => {
    const { session } = parseRpp(RPP_MIDI, "midi.rpp");
    const clip = session.tracks[0].clips[0];
    expect(clip.kind).toBe("midi");
    expect(clip.start).toBe(1.5); // clip position stays in seconds on the timeline
    expect(clip.notes).toEqual([
      { pitch: 60, start: 0, length: 0.5, velocity: 100 }, // tick 0→480 @ ppq 960
      { pitch: 64, start: 0.5, length: 1, velocity: 80 }, // tick 480→1440 (lowercase e, ch1)
    ]);
  });

  it("does not log a MIDI item as unmappable once notes are extracted", () => {
    const ir = parseRpp(RPP_MIDI, "midi.rpp");
    expect(ir.unmappable.some((u) => /not implemented/i.test(u))).toBe(false);
  });

  it("treats a note-on with velocity 0 as a note-off, and pairs same-pitch notes FIFO", () => {
    const rpp = `<REAPER_PROJECT 0.1 "x" 1
  <TRACK
    <ITEM
      POSITION 0
      LENGTH 4
      <SOURCE MIDI
        HASDATA 1 960 QN
        E 0 90 24 70
        E 0 90 24 50
        E 240 90 24 00
        E 240 80 24 00
      >
    >
  >
>
`;
    const { session } = parseRpp(rpp, "kick.rpp");
    const notes = session.tracks[0].clips[0].notes ?? [];
    // two overlapping kicks (pitch 36): FIFO pairs first-on→first-off.
    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({ pitch: 36, start: 0, length: 0.25, velocity: 112 }); // 0→240
    expect(notes[1]).toEqual({ pitch: 36, start: 0, length: 0.5, velocity: 80 }); // 0→480
  });
});
