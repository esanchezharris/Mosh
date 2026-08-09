import { describe, expect, it } from "vitest";
import type { Clip } from "../types";
import { midiPointerIsBlank } from "./midiBlankHit";

const clip: Clip = {
  id: "m1", name: "Keys", type: "midi", start: 0, length: 4, offset: 0,
  hasRenderLayer: false,
  notes: [{ i: 0, pitch: 60, start: 0, length: 1, velocity: 100 }],
};

describe("MIDI clip blank-area hit testing", () => {
  it("distinguishes a rendered note from surrounding blank canvas", () => {
    expect(midiPointerIsBlank(clip, 20, 30, 400, 60, 0.5, false)).toBe(false);
    expect(midiPointerIsBlank(clip, 300, 5, 400, 60, 0.5, false)).toBe(true);
  });
});
