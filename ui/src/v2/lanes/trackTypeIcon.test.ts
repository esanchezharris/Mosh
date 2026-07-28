import { describe, it, expect } from "vitest";
import { pickTrackIcon } from "./TrackLaneList";

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
