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
