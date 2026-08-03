// add_drum_pattern (DRM-002) — pattern-string DSL parser golden vectors.
// These vectors are MIRRORED 1:1 in tests/test_drum_pattern.cpp — the C++
// parser must stay in lockstep (the kDefaultKit ⇄ DRUM_LANES "MUST mirror"
// discipline). Change a vector here → change it there.
import { describe, expect, it } from "vitest";
import {
  drumPatternLanePitch, drumPatternLaneName, parseDrumPattern, serializeDrumPattern, drumPatternFromNotes, normalizeDrumVelocity,
} from "./drumPatternUtil";
import type { DrumPatternParse } from "./drumPatternUtil";
import { stepBeats } from "./drumGrid";
import type { MidiNote } from "../types";

const note = (pitch: number, start: number, velocity = 100, length = 0.25, i = 0): MidiNote =>
  ({ i, pitch, start, length, velocity });

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

  // ── golden vector 10b: agent-scale velocity normalizes at the command boundary ──
  // (MIRRORED in MoshOps.cpp cmdAddDrumPattern — the parser contract itself stays
  // integer 1-127 in both languages.)
  it("normalizeDrumVelocity maps agent shapes onto MIDI without hiding garbage", () => {
    expect(normalizeDrumVelocity(0.78)).toBe(99); // 0-1 scale from a model
    expect(normalizeDrumVelocity(0.004)).toBe(1); // floor of the audible range
    expect(normalizeDrumVelocity(100.4)).toBe(100); // fractional MIDI rounds
    expect(normalizeDrumVelocity(100)).toBe(100); // integers untouched
    expect(normalizeDrumVelocity(0)).toBe(0); // still fails loud downstream
    expect(normalizeDrumVelocity(200.2)).toBe(200); // out of range still fails downstream
    const p = { kick: "x..." };
    const r = parseDrumPattern(p, 4, 0, normalizeDrumVelocity(0.78));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps[0].velocity).toBe(99);
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

// ── AGT-MEM (M4): serializeDrumPattern — the exact inverse, flat-string form ───────
describe("serializeDrumPattern", () => {
  // Semantic round-trip: parse(serialize(parse(s))) ≡ parse(s). NOT serialize(parse(s))
  // === s — see serializeDrumPattern's own header comment for why (tiling expands,
  // aliases canonicalize, '|' cosmetics never survive parsing to begin with).
  const roundTrips = (s: string, stepsPerBar = 16, bars = 0, velocity = 100) => {
    const first = okOf(parseDrumPattern(s, stepsPerBar, bars, velocity));
    const out = serializeDrumPattern(first);
    const second = okOf(parseDrumPattern(out, stepsPerBar, bars, velocity));
    expect(second).toEqual(first);
    return out;
  };

  it("round-trips the canonical 3-lane trap grid", () => {
    roundTrips("kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.");
  });

  it("emits a canonical lane name (not necessarily the input alias), still round-tripping", () => {
    const out = roundTrips("ch: x...x...x...x...", 16, 0, 100); // "ch" aliases to hat/42
    expect(out.startsWith("hat:")).toBe(true); // canonical name, not "ch"
  });

  it("round-trips accents (X = velocity 127) distinctly from plain hits", () => {
    const out = roundTrips("kick: x-X.", 4, 0, 90);
    expect(out).toBe("kick: x.X.");
  });

  it("round-trips rests ('.' and '-' both normalize to '.')", () => {
    const out = roundTrips("kick: x-x-", 4, 0, 100);
    expect(out).toBe("kick: x.x.");
  });

  it("a tiled short lane serializes at FULL LENGTH, but still round-trips to the same steps", () => {
    const out = roundTrips("hat: x.", 16, 0, 100);
    expect(out).toBe("hat: x.x.x.x.x.x.x.x."); // 16 chars, not the original 2
  });

  it("drops '|' cosmetic separators canonically", () => {
    const out = roundTrips(" x... | x... | x... | x... ".replace(/^/, "kick: "), 16, 0, 100);
    expect(out).not.toContain("|");
    expect(out).toBe("kick: x...x...x...x...");
  });

  it("round-trips a raw numeric-pitch lane (an unmapped pitch, e.g. a custom pad)", () => {
    const out = roundTrips("60: x...............", 16, 0, 100); // 60 has no LANE_PITCHES alias
    expect(out).toBe("60: x...............");
  });

  it("round-trips an all-rest lane (registers its pitch with zero hits)", () => {
    const out = roundTrips("snare: ................", 16, 0, 100);
    expect(out).toBe("snare: ................");
  });

  it("preserves multi-lane order (lanePitches order), not alphabetical", () => {
    const out = roundTrips("hat: x...x...x...x...; kick: x.x.x.x.x.x.x.x.; snare: ....x.......x...", 16, 0, 100);
    const lanes = out.split("; ").map((l) => l.split(":")[0]);
    expect(lanes).toEqual(["hat", "kick", "snare"]); // input order, not re-sorted
  });

  it("round-trips a multi-bar pattern (bars derived from the longest lane)", () => {
    roundTrips("kick: x...x...x...x...x...x...x...x...; snare: ....x...", 16, 0, 100);
  });

  it("drumPatternLaneName: known pitches map to their canonical alias; unknown pitches fall back to the number", () => {
    expect(drumPatternLaneName(36)).toBe("kick");
    expect(drumPatternLaneName(38)).toBe("snare");
    expect(drumPatternLaneName(39)).toBe("clap");
    expect(drumPatternLaneName(42)).toBe("hat"); // canonical alias, not hihat/closedhat/ch
    expect(drumPatternLaneName(46)).toBe("openhat"); // canonical alias, not oh
    expect(drumPatternLaneName(45)).toBe("lowtom");
    expect(drumPatternLaneName(47)).toBe("midtom");
    expect(drumPatternLaneName(49)).toBe("crash");
    expect(drumPatternLaneName(55)).toBe("55"); // unknown -> raw pitch string
  });
});

// ── AGT-MEM (M4): drumPatternFromNotes — reads a live clip's notes into pattern shape ─
describe("drumPatternFromNotes", () => {
  it("quantizes notes onto the 16-step grid at their nearest step (kick on beats, hats on 8ths)", () => {
    // 4/4 bar, 16 steps/bar -> stepBeats(4,16) = 0.25 beats/step.
    const notes = [
      note(36, 0), note(36, 1), note(36, 2), note(36, 3), // kick on every beat: steps 0,4,8,12
      note(42, 0), note(42, 0.5), note(42, 1), note(42, 1.5), // hats on 8ths: steps 0,2,4,6
    ];
    const p = drumPatternFromNotes(notes, 4, 16);
    expect(p.stepsPerBar).toBe(16);
    expect(p.totalSteps).toBe(16);
    expect(p.lanePitches).toEqual([36, 42]); // first-encountered order
    const kickSteps = p.steps.filter((s) => s.pitch === 36).map((s) => s.step);
    expect(kickSteps).toEqual([0, 4, 8, 12]);
    const hatSteps = p.steps.filter((s) => s.pitch === 42).map((s) => s.step);
    expect(hatSteps).toEqual([0, 2, 4, 6]);
  });

  it("round-trips through serializeDrumPattern back into an equivalent add_drum_pattern-ready string", () => {
    const notes = [note(36, 0, 100), note(36, 2, 127), note(38, 1, 100)];
    const built = drumPatternFromNotes(notes, 4, 16);
    const patternString = serializeDrumPattern(built);
    const reparsed = parseDrumPattern(patternString, built.stepsPerBar, 0, 100);
    if (!reparsed.ok) throw new Error(reparsed.error);
    expect(reparsed.steps).toEqual(built.steps);
    expect(reparsed.lanePitches).toEqual(built.lanePitches);
    expect(reparsed.totalSteps).toBe(built.totalSteps);
  });

  it("skips notes on unrecognized (non-drum-lane) pitches", () => {
    const p = drumPatternFromNotes([note(36, 0), note(60, 0)], 4, 16); // 60 is not a drum lane
    expect(p.lanePitches).toEqual([36]);
    expect(p.steps).toEqual([{ pitch: 36, step: 0, velocity: 100 }]);
  });

  it("snaps a slightly-off-grid note to its nearest step (round-to-nearest, unbounded)", () => {
    // sb = 0.25 beats/step; 0.13 beats is closer to step 1 (0.25) than step 0 (0.0).
    const p = drumPatternFromNotes([note(36, 0.13)], 4, 16);
    expect(p.steps).toEqual([{ pitch: 36, step: 1, velocity: 100 }]);
  });

  it("first note wins a cell when two notes land on the same lane+step", () => {
    const p = drumPatternFromNotes([note(36, 0, 60), note(36, 0.02, 127)], 4, 16); // both quantize to step 0
    expect(p.steps).toEqual([{ pitch: 36, step: 0, velocity: 60 }]);
  });

  it("derives bars from the furthest hit, rounding up to a full bar", () => {
    const p = drumPatternFromNotes([note(36, 4.5)], 4, 16); // beat 4.5 of bar 2 -> step 18
    expect(p.totalSteps).toBe(32); // 2 bars @ 16 steps
    expect(p.steps).toEqual([{ pitch: 36, step: 18, velocity: 100 }]);
  });

  it("an empty note list produces an empty (1-bar) pattern with no lanes", () => {
    const p = drumPatternFromNotes([], 4, 16);
    expect(p.lanePitches).toEqual([]);
    expect(p.steps).toEqual([]);
    expect(p.totalSteps).toBe(16);
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
