import { describe, it, expect } from "vitest";
import { pickTrackIcon, iconArgsForKind, TRACK_KINDS } from "./TrackLaneList";

// An instrument track is type:"audio" carrying a synth, so before this it rendered the
// SAME waveform glyph as a plain audio track and the two were indistinguishable.
describe("pickTrackIcon", () => {
  it("an instrument track is keys, even though its type is audio", () => {
    expect(pickTrackIcon("audio", true)).toBe("keys");
  });
  it("a plain audio track stays a waveform", () => {
    expect(pickTrackIcon("audio", false)).toBe("waveform");
  });
  it("a drum track stays drums even when it hosts a sampler", () => {
    expect(pickTrackIcon("drum", true)).toBe("drum");
  });
  it("an unknown type falls back to layers", () => {
    expect(pickTrackIcon("bus", false)).toBe("layers");
  });
});

describe("iconArgsForKind", () => {
  it("covers all TRACK_KINDS so a newly added kind cannot silently go uncovered", () => {
    // Verify that every kind in TRACK_KINDS has an entry below.
    const kinds = TRACK_KINDS.map(k => k.kind);
    expect(kinds.length).toBeGreaterThan(0);

    for (const kind of kinds) {
      const args = iconArgsForKind(kind);
      expect(args).toBeDefined();
      expect(args.type).toBeDefined();
      expect(typeof args.isInstrument).toBe("boolean");
    }
  });

  it("maps midi to audio type with isInstrument:true → keys glyph", () => {
    const args = iconArgsForKind("midi");
    expect(args).toEqual({ type: "audio", isInstrument: true });
    expect(pickTrackIcon(args.type, args.isInstrument)).toBe("keys");
  });

  it("maps drum to drum type with isInstrument:false → drum glyph", () => {
    const args = iconArgsForKind("drum");
    expect(args).toEqual({ type: "drum", isInstrument: false });
    expect(pickTrackIcon(args.type, args.isInstrument)).toBe("drum");
  });

  it("maps audio to audio type with isInstrument:false → waveform glyph", () => {
    const args = iconArgsForKind("audio");
    expect(args).toEqual({ type: "audio", isInstrument: false });
    expect(pickTrackIcon(args.type, args.isInstrument)).toBe("waveform");
  });

  it("maps tone to audio type with isInstrument:false → waveform glyph", () => {
    const args = iconArgsForKind("tone");
    expect(args).toEqual({ type: "audio", isInstrument: false });
    expect(pickTrackIcon(args.type, args.isInstrument)).toBe("waveform");
  });
});
