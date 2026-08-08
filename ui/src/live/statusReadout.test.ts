// Unit pins for the live status bar's readout (statusReadout.ts) — SPEC §9's
// context-sensitive line.

import { describe, it, expect } from "vitest";
import { statusReadout } from "./statusReadout";
import { tempoMapFrom } from "../time";
import type { Snapshot, Transport } from "../types";

// 4/4 at 120bpm → 2s per bar, 0.5s per beat.
const MAP = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });
const TRANSPORT: Transport = { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 };

const SNAP = {
  tracks: [{
    id: "t1", index: 0, name: "Drums", type: "drum",
    clips: [
      { id: "c1", name: "loop", type: "midi", start: 0, length: 8, offset: 0, hasRenderLayer: false },
      { id: "c2", name: "fill", type: "midi", start: 8, length: 4, offset: 0, hasRenderLayer: false },
    ],
  }],
} as unknown as Snapshot;

describe("statusReadout", () => {
  it("no selection → the playhead position as bars.beats.16ths", () => {
    expect(statusReadout(SNAP, new Set(), TRANSPORT, MAP)).toBe("Position 1.1.1");
    expect(statusReadout(SNAP, new Set(), { ...TRANSPORT, position: 2.5 }, MAP)).toBe("Position 2.2.1");
  });

  it("one selected clip → name + start + length", () => {
    expect(statusReadout(SNAP, new Set(["c2"]), TRANSPORT, MAP))
      .toBe("Clip: fill — Start 5.1.1 · Length 3.1.1");
  });

  it("several selected clips → a count", () => {
    expect(statusReadout(SNAP, new Set(["c1", "c2"]), TRANSPORT, MAP)).toBe("2 clips selected");
  });

  it("a stale selection id (clip deleted between commands) never crashes", () => {
    expect(statusReadout(SNAP, new Set(["gone"]), TRANSPORT, MAP)).toBe("1 selected");
    expect(statusReadout(null, new Set(["gone"]), TRANSPORT, MAP)).toBe("Position 1.1.1");
  });
});
