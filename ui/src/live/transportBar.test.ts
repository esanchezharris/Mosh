// Unit pins for the live control bar's pure helpers (transportBar.ts).

import { describe, it, expect } from "vitest";
import { loopToggleArgs } from "./transportBar";
import type { Transport } from "../types";

const T = (over: Partial<Transport>): Transport => ({
  playing: false, recording: false, position: 0,
  looping: false, loopStart: 0, loopEnd: 0, ...over,
});

describe("loopToggleArgs", () => {
  it("toggling OFF is always just loop:false — the range survives for the next ON", () => {
    expect(loopToggleArgs(T({ looping: true, loopStart: 2, loopEnd: 6 }), 2))
      .toEqual({ loop: false });
  });

  it("toggling ON re-arms the existing range", () => {
    expect(loopToggleArgs(T({ looping: false, loopStart: 2, loopEnd: 6 }), 2))
      .toEqual({ loop: true, loopStart: 2, loopEnd: 6 });
  });

  it("toggling ON with a collapsed loop defaults to the first four bars", () => {
    // barSec 2s (4/4 at 120bpm) → 4 bars = 8s. A zero-length loop is invisible;
    // Live's loop is always a range.
    expect(loopToggleArgs(T({ looping: false, loopStart: 0, loopEnd: 0 }), 2))
      .toEqual({ loop: true, loopStart: 0, loopEnd: 8 });
  });

  it("a degenerate bar length still yields a sane range (never negative/zero)", () => {
    const args = loopToggleArgs(T({ looping: false }), 0) as { loopEnd: number };
    expect(args.loopEnd).toBeGreaterThan(0);
  });
});
