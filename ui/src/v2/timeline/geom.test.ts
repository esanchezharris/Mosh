import { describe, it, expect } from "vitest";
import { beatToSec, secToBeat, beatsPerBar, contentSeconds, cssPx, headW, laneH } from "./geom";
import type { Snapshot } from "../../types";

// Minimal snapshot stub for the pure geometry helpers.
const snap = (over: Partial<Snapshot["session"]> = {}, rest: Partial<Snapshot> = {}): Snapshot =>
  ({
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, key: { tonic: "C", mode: "major" } as never, editFile: "", ...over },
    tracks: [],
    transport: { playing: false, position: 0, loop: false } as never,
    ...rest,
  }) as Snapshot;

describe("timeline geom", () => {
  it("beatToSec / secToBeat round-trip at 120bpm 4/4 (0.5s per beat)", () => {
    const s = snap();
    expect(beatToSec(s, 1)).toBeCloseTo(0.5, 6);
    expect(secToBeat(s, 0.5)).toBeCloseTo(1, 6);
    for (const b of [0, 4, 7.25, 32]) expect(secToBeat(s, beatToSec(s, b))).toBeCloseTo(b, 6);
  });

  it("respects tempo (60bpm → 1s per quarter)", () => {
    const s = snap({ tempo: 60 });
    expect(beatToSec(s, 1)).toBeCloseTo(1, 6);
    expect(secToBeat(s, 2)).toBeCloseTo(2, 6);
  });

  it("beatsPerBar reads the time-sig numerator (default 4)", () => {
    expect(beatsPerBar(snap())).toBe(4);
    expect(beatsPerBar(snap({ timeSigNumerator: 3 }))).toBe(3);
  });

  it("contentSeconds stretches to cover the last section end", () => {
    const s = snap({}, { sections: [{ id: "x", name: "Outro", startBeat: 0, endBeat: 200 }] });
    // 200 beats * 0.5s = 100s, plus tail, so well past the 32s floor.
    expect(contentSeconds(s)).toBeGreaterThanOrEqual(100);
  });
});

// Regression guard for the +44px playhead bug: header/lane geometry must be read from the
// CSS token, never a hardcoded JS mirror. Fallbacks MUST equal the current shell.css tokens.
describe("timeline geom — head/lane geometry single-sourced from CSS", () => {
  it("falls back to the current --v2-head-w / --v2-lane-h token values", () => {
    expect(headW(null)).toBe(168); // must equal --v2-head-w in shell.css
    expect(laneH(null)).toBe(64);  // must equal --v2-lane-h in shell.css
    expect(cssPx("--v2-nonexistent", null, 42)).toBe(42);
  });

  it("reads the live CSS custom property off the nearest .v2-shell", () => {
    // jsdom builds vary in resolving custom properties via getComputedStyle; probe first.
    const probe = document.createElement("div");
    probe.style.setProperty("--probe", "5px");
    document.body.appendChild(probe);
    const resolves = parseFloat(getComputedStyle(probe).getPropertyValue("--probe")) === 5;
    probe.remove();
    if (!resolves) return;

    const shell = document.createElement("div");
    shell.className = "v2-shell";
    shell.style.setProperty("--v2-head-w", "200px");
    shell.style.setProperty("--v2-lane-h", "80px");
    const child = document.createElement("div");
    shell.appendChild(child);
    document.body.appendChild(shell);
    expect(headW(child)).toBe(200);
    expect(laneH(child)).toBe(80);
    shell.remove();
  });
});
