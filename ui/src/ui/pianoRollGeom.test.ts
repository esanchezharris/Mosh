import { describe, expect, it } from "vitest";
import { gridBeatsFor } from "./pianoRollGeom";

// The bug this exists to prevent: the grid was sized `ceil(clipBeats) + 4` from the CLIP
// alone, so a short clip in an ~830px viewport produced a 504px grid and the remaining
// ~326px showed the panel's own background — the "empty right third".

const BEAT_PX = 42;

describe("gridBeatsFor", () => {
  it("covers the viewport when the clip is shorter than the panel", () => {
    // 8-beat clip @42px = 336px of content in an 830px viewport.
    const beats = gridBeatsFor({ clipBeats: 8, beatsPerBar: 4, beatPx: BEAT_PX, viewportW: 830 });
    expect(beats * BEAT_PX).toBeGreaterThanOrEqual(830);
  });

  it("covers the CLIP when the clip is longer than the panel", () => {
    const beats = gridBeatsFor({ clipBeats: 64, beatsPerBar: 4, beatPx: BEAT_PX, viewportW: 830 });
    expect(beats).toBeGreaterThanOrEqual(64);
  });

  it("leaves a runway past the end of the clip so notes can be added after it", () => {
    const beats = gridBeatsFor({ clipBeats: 64, beatsPerBar: 4, beatPx: BEAT_PX, viewportW: 830 });
    expect(beats).toBeGreaterThan(64);
  });

  it("always lands on a whole bar", () => {
    for (const [clipBeats, bpb, viewportW] of [[8, 4, 830], [13, 3, 500], [1, 7, 1000], [64, 4, 200]] as const) {
      const beats = gridBeatsFor({ clipBeats, beatsPerBar: bpb, beatPx: BEAT_PX, viewportW });
      expect(beats % bpb, `${clipBeats}b @${bpb}/bar ended mid-bar`).toBe(0);
    }
  });

  it("falls back to the clip rule before the viewport has been measured", () => {
    // viewportW starts at 0; this must stay finite and usable, not collapse to nothing.
    const beats = gridBeatsFor({ clipBeats: 8, beatsPerBar: 4, beatPx: BEAT_PX, viewportW: 0 });
    expect(beats).toBeGreaterThanOrEqual(16);
    expect(Number.isFinite(beats)).toBe(true);
  });

  it("survives degenerate inputs instead of producing NaN/Infinity widths", () => {
    for (const args of [
      { clipBeats: NaN, beatsPerBar: 4, beatPx: BEAT_PX, viewportW: 830 },
      { clipBeats: 8, beatsPerBar: 0, beatPx: BEAT_PX, viewportW: 830 },
      { clipBeats: 8, beatsPerBar: 4, beatPx: 0, viewportW: 830 },
      { clipBeats: 8, beatsPerBar: 4, beatPx: BEAT_PX, viewportW: Infinity },
    ]) {
      const beats = gridBeatsFor(args);
      expect(Number.isFinite(beats), `not finite for ${JSON.stringify(args)}`).toBe(true);
      expect(beats).toBeGreaterThan(0);
    }
  });

  it("keeps the previous floor for a 4/4 clip (no behaviour change where it was already right)", () => {
    // The old rule floored a clip at 8 beats; 4/4 keeps that exactly.
    const beats = gridBeatsFor({ clipBeats: 1, beatsPerBar: 4, beatPx: BEAT_PX, viewportW: 0 });
    expect(beats).toBe(16); // max(8 floor, …) + 8 tail
  });
});
