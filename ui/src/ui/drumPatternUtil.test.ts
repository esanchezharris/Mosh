// add_drum_pattern (DRM-002) — pattern-string DSL parser golden vectors.
// These vectors are MIRRORED 1:1 in tests/test_drum_pattern.cpp — the C++
// parser must stay in lockstep (the kDefaultKit ⇄ DRUM_LANES "MUST mirror"
// discipline). Change a vector here → change it there.
import { describe, expect, it } from "vitest";
import { drumPatternLanePitch, parseDrumPattern } from "./drumPatternUtil";
import type { DrumPatternParse } from "./drumPatternUtil";
import { stepBeats } from "./drumGrid";

const okOf = (r: DrumPatternParse) => {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r;
};

const hitsFor = (r: DrumPatternParse, pitch: number): number =>
  okOf(r).steps.filter((s) => s.pitch === pitch).length;

const hasHit = (r: DrumPatternParse, pitch: number, step: number, vel = -1): boolean =>
  okOf(r).steps.some((s) => s.pitch === pitch && s.step === step && (vel < 0 || s.velocity === vel));

// ── golden vector 1: the canonical 3-lane trap grid ─────────────────────────────
describe("parseDrumPattern", () => {
  it("object-form 3-lane grid lands hits at the drum-sequencer steps", () => {
    const r = parseDrumPattern(
      { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
      16, 0, 100,
    );
    const ok = okOf(r);
    expect(ok.stepsPerBar).toBe(16);
    expect(ok.bars).toBe(1);
    expect(ok.totalSteps).toBe(16);
    expect(ok.steps.length).toBe(14); // 4 kicks + 2 snares + 8 hats

    for (const s of [0, 4, 8, 12]) expect(hasHit(r, 36, s, 100)).toBe(true);
    for (const s of [4, 12]) expect(hasHit(r, 38, s, 100)).toBe(true);
    for (const s of [0, 2, 4, 6, 8, 10, 12, 14]) expect(hasHit(r, 42, s, 100)).toBe(true);

    // lanes register in input order (drives per-lane replace)
    expect(ok.lanePitches).toEqual([36, 38, 42]);
    // deterministic ordering: lanes in input order, steps ascending within a lane
    expect(ok.steps[0]).toMatchObject({ pitch: 36, step: 0 });
  });

  // ── golden vector 2: flat-string form ≡ object form ───────────────────────────
  it("flat-string form (';' or newline separated) equals the object form", () => {
    const o = okOf(parseDrumPattern({ kick: "x...x...x...x...", snare: "....x.......x..." }, 16, 0, 100));
    const s = okOf(parseDrumPattern("kick: x...x...x...x...; snare: ....x.......x...", 16, 0, 100));
    const n = okOf(parseDrumPattern("kick: x...x...x...x...\nsnare: ....x.......x...", 16, 0, 100));
    expect(s.steps).toEqual(o.steps);
    expect(n.steps).toEqual(o.steps);
    expect(s.lanePitches).toEqual(o.lanePitches);
  });

  // ── golden vector 3: accent + rest chars ───────────────────────────────────────
  it("'X' accents at 127, 'x' at the default velocity; '.' and '-' are rests", () => {
    const r = parseDrumPattern({ kick: "x-X." }, 4, 0, 90);
    expect(okOf(r).totalSteps).toBe(4);
    expect(okOf(r).steps.length).toBe(2);
    expect(hasHit(r, 36, 0, 90)).toBe(true);
    expect(hasHit(r, 36, 2, 127)).toBe(true);
  });

  // ── golden vector 4: cosmetic separators ───────────────────────────────────────
  it("'|' and whitespace inside a lane are cosmetic", () => {
    const plain = parseDrumPattern({ kick: "x...x...x...x..." }, 16, 0, 100);
    const piped = parseDrumPattern({ kick: " x... | x... | x... | x... " }, 16, 0, 100);
    expect(okOf(piped).steps).toEqual(okOf(plain).steps);
  });

  // ── golden vector 5: tiling ────────────────────────────────────────────────────
  it("a short lane tiles when its length divides the total steps", () => {
    const r = parseDrumPattern({ hat: "x." }, 16, 0, 100);
    expect(okOf(r).steps.length).toBe(8);
    for (const s of [0, 2, 4, 6, 8, 10, 12, 14]) expect(hasHit(r, 42, s)).toBe(true);
  });

  it("a lane whose length does not divide the total steps errors", () => {
    const r = parseDrumPattern({ hat: "x...x...x..." }, 16, 0, 100); // 12 into 16
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it("a lane longer than stepsPerBar x explicit bars errors", () => {
    const r = parseDrumPattern({ kick: "x...x...x...x...x...x...x...x..." }, 16, 1, 100); // 32 into 16
    expect(r.ok).toBe(false);
  });

  // ── golden vector 6: bars derivation ───────────────────────────────────────────
  it("bars derives from the longest lane when not given; short lanes tile across", () => {
    const r = parseDrumPattern(
      { kick: "x...x...x...x...x...x...x...x...", snare: "....x..." }, // 32 chars; 8 chars tiles x4
      16, 0, 100,
    );
    const ok = okOf(r);
    expect(ok.bars).toBe(2);
    expect(ok.totalSteps).toBe(32);
    expect(hitsFor(r, 36)).toBe(8);
    expect(hitsFor(r, 38)).toBe(4);
    expect(hasHit(r, 38, 28)).toBe(true); // last tiled snare: step 4 of the 4th 8-step tile
  });

  // ── golden vector 7: bad chars / unknown lanes name the offender ───────────────
  it("a bad step char errors naming the char", () => {
    const r = parseDrumPattern({ kick: "x..q" }, 4, 0, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("q");
  });

  it("an unknown lane errors naming the lane", () => {
    const r = parseDrumPattern({ cowbell: "x..." }, 4, 0, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cowbell");
  });

  // ── golden vector 8: numeric keys, duplicates ──────────────────────────────────
  it("numeric lane keys are raw MIDI pitches; out-of-range keys error", () => {
    const r = parseDrumPattern({ "47": "x..............." }, 16, 0, 100);
    expect(hasHit(r, 47, 0)).toBe(true);
    expect(okOf(r).lanePitches).toEqual([47]);

    expect(parseDrumPattern({ "128": "x..." }, 4, 0, 100).ok).toBe(false);
    expect(parseDrumPattern({ "-1": "x..." }, 4, 0, 100).ok).toBe(false);
  });

  it("duplicate lanes after aliasing error", () => {
    const r = parseDrumPattern("hat: x...; ch: ....", 4, 0, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("duplicate");
  });

  // ── golden vector 9: all-rest lane registers for per-lane clear ────────────────
  it("an all-rest lane registers its pitch with zero hits", () => {
    const r = parseDrumPattern({ snare: "................" }, 16, 0, 100);
    expect(okOf(r).steps).toEqual([]);
    expect(okOf(r).lanePitches).toEqual([38]);
  });

  // ── golden vector 10: range validation ─────────────────────────────────────────
  it("stepsPerBar, bars and velocity ranges are validated", () => {
    const p = { kick: "x..." };
    expect(parseDrumPattern(p, 0, 0, 100).ok).toBe(false); // stepsPerBar too small
    expect(parseDrumPattern(p, 65, 0, 100).ok).toBe(false); // stepsPerBar too big
    expect(parseDrumPattern(p, 4, 17, 100).ok).toBe(false); // bars too big
    expect(parseDrumPattern(p, 4, -1, 100).ok).toBe(false); // bars negative
    expect(parseDrumPattern(p, 4, 0, 0).ok).toBe(false); // velocity too small
    expect(parseDrumPattern(p, 4, 0, 128).ok).toBe(false); // velocity too big
  });

  // ── golden vector 11: empty / malformed patterns ───────────────────────────────
  it("empty or malformed patterns error", () => {
    expect(parseDrumPattern(undefined, 16, 0, 100).ok).toBe(false); // void
    expect(parseDrumPattern(12, 16, 0, 100).ok).toBe(false); // wrong type
    expect(parseDrumPattern("", 16, 0, 100).ok).toBe(false); // empty string
    expect(parseDrumPattern({}, 16, 0, 100).ok).toBe(false); // no lanes
    expect(parseDrumPattern({ hat: "" }, 16, 0, 100).ok).toBe(false); // empty lane
    expect(parseDrumPattern("kick x...", 16, 0, 100).ok).toBe(false); // no ':' in string form
  });
});

// ── golden vector 12 lives in drumGrid: step→beats math the handler reuses ────────
describe("drumPatternLanePitch", () => {
  it("lane aliases normalize case-insensitively, stripping space/underscore/hyphen", () => {
    expect(drumPatternLanePitch("kick")).toBe(36);
    expect(drumPatternLanePitch("snare")).toBe(38);
    expect(drumPatternLanePitch("clap")).toBe(39);
    expect(drumPatternLanePitch("hat")).toBe(42);
    expect(drumPatternLanePitch("hihat")).toBe(42);
    expect(drumPatternLanePitch("HiHat")).toBe(42);
    expect(drumPatternLanePitch("hi-hat")).toBe(42);
    expect(drumPatternLanePitch("closedhat")).toBe(42);
    expect(drumPatternLanePitch("Closed Hat")).toBe(42);
    expect(drumPatternLanePitch("closed_hat")).toBe(42);
    expect(drumPatternLanePitch("CH")).toBe(42);
    expect(drumPatternLanePitch("openhat")).toBe(46);
    expect(drumPatternLanePitch("Open Hat")).toBe(46);
    expect(drumPatternLanePitch("OH")).toBe(46);
    expect(drumPatternLanePitch("lowtom")).toBe(45);
    expect(drumPatternLanePitch("Low Tom")).toBe(45);
    expect(drumPatternLanePitch("midtom")).toBe(47);
    expect(drumPatternLanePitch("crash")).toBe(49);
    expect(drumPatternLanePitch("cowbell")).toBe(-1);
  });

  it("stepBeats mirrors the C++ drumPatternStepBeats: beatsPerBar / stepsPerBar", () => {
    expect(stepBeats(4, 16)).toBe(0.25);
    expect(stepBeats(3, 16)).toBe(0.1875);
  });
});
