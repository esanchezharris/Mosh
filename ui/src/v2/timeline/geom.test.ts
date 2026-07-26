import { describe, it, expect, vi, afterEach } from "vitest";
import { beatToSec, secToBeat, beatsPerBar, contentSeconds } from "./geom";
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

// headW() reads the live --v2-head-w token so JS overlays can't drift from the CSS
// grid (the 212-vs-168 playhead-offset bug). Module-level cache → fresh import per test.
describe("headW", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const mount = () => {
    const el = document.createElement("div");
    el.className = "v2-shell";
    document.body.appendChild(el);
    return el;
  };
  const mockToken = (val: string) =>
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (p: string) => (p === "--v2-head-w" ? val : ""),
    } as unknown as CSSStyleDeclaration);

  it("falls back to the shell.css value (200) when no .v2-shell is mounted", async () => {
    const { headW } = await import("./geom");
    expect(headW()).toBe(200);
  });

  it("reads --v2-head-w from the mounted shell", async () => {
    mount();
    mockToken("240px");
    const { headW } = await import("./geom");
    expect(headW()).toBe(240);
  });

  it("caches a successful read (token is static per session)", async () => {
    mount();
    const spy = mockToken("240px");
    const { headW } = await import("./geom");
    expect(headW()).toBe(240);
    spy.mockReturnValue({ getPropertyValue: () => "999px" } as unknown as CSSStyleDeclaration);
    expect(headW()).toBe(240);
  });

  it("does NOT cache the fallback — a later read picks up the real token", async () => {
    const { headW } = await import("./geom");
    expect(headW()).toBe(200); // pre-mount render
    mount();
    mockToken("240px");
    expect(headW()).toBe(240);
  });
});
