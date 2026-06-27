import { describe, it, expect } from "vitest";
import { buildExportArgs, hasLoopRegion } from "./exportArgs";

// G1: the ExportControls form must be able to ask export_audio for a sub-range (the
// transport's loop region) and to extend the render past the range so reverb/delay
// tails ring out. buildExportArgs is the pure arg-shaper the form calls; it stays on
// the seam (the result is the literal args object handed to exec("export_audio", …)).

describe("buildExportArgs", () => {
  const fmt = { format: "wav" as const, bitDepth: 24 };

  it("full range with no tail carries only format/bitDepth (no range/tail keys)", () => {
    const a = buildExportArgs({ ...fmt, range: "full", includeTail: false, tailSeconds: 2, loop: { loopStart: 4, loopEnd: 8 } });
    expect(a).toEqual({ format: "wav", bitDepth: 24 });
  });

  it("loop range passes range:'loop' so the backend uses the transport loop region", () => {
    const a = buildExportArgs({ ...fmt, range: "loop", includeTail: false, tailSeconds: 2, loop: { loopStart: 4, loopEnd: 8 } });
    expect(a.range).toBe("loop");
    expect(a.start).toBeUndefined();
    expect(a.end).toBeUndefined();
  });

  it("includeTail attaches the tail flag and tailSeconds", () => {
    const a = buildExportArgs({ ...fmt, range: "loop", includeTail: true, tailSeconds: 3, loop: { loopStart: 4, loopEnd: 8 } });
    expect(a.range).toBe("loop");
    expect(a.includeTail).toBe(true);
    expect(a.tailSeconds).toBe(3);
  });

  it("tail flag is omitted (not sent false) when includeTail is off", () => {
    const a = buildExportArgs({ ...fmt, range: "loop", includeTail: false, tailSeconds: 3, loop: { loopStart: 4, loopEnd: 8 } });
    expect("includeTail" in a).toBe(false);
    expect("tailSeconds" in a).toBe(false);
  });
});

describe("hasLoopRegion", () => {
  it("true for a non-empty loop region", () => {
    expect(hasLoopRegion({ loopStart: 4, loopEnd: 8 })).toBe(true);
  });
  it("false when start == end (no region set)", () => {
    expect(hasLoopRegion({ loopStart: 0, loopEnd: 0 })).toBe(false);
  });
  it("false when end is before start", () => {
    expect(hasLoopRegion({ loopStart: 8, loopEnd: 4 })).toBe(false);
  });
});
