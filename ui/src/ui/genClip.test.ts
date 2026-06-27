import { describe, it, expect } from "vitest";
import { pickGenClip } from "./genClip";
import type { Track, Clip } from "../types";

const clip = (id: string, type: Clip["type"]): Clip =>
  ({ id, name: id, type, start: 0, length: 1, offset: 0, notes: [], hasRenderLayer: false }) as unknown as Clip;
const track = (clips: Clip[]): Track => ({ id: "t1", name: "T", type: "audio", clips } as unknown as Track);

describe("pickGenClip — generative targets any clip type", () => {
  it("returns the SELECTED clip when it's on the track (even MIDI/drum)", () => {
    const t = track([clip("w", "wave"), clip("m", "midi")]);
    expect(pickGenClip(t, "m")?.id).toBe("m"); // a MIDI clip is a valid generative target
  });

  it("falls back to the first clip when nothing is selected", () => {
    const t = track([clip("m", "midi"), clip("w", "wave")]);
    expect(pickGenClip(t, undefined)?.id).toBe("m"); // first clip, not first-WAVE
  });

  it("falls back to the first clip when the selection is on another track", () => {
    const t = track([clip("a", "midi")]);
    expect(pickGenClip(t, "not-here")?.id).toBe("a");
  });

  it("returns undefined only when the track has no clips at all", () => {
    expect(pickGenClip(track([]), "x")).toBeUndefined();
  });
});
