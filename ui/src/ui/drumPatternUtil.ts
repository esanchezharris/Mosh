// add_drum_pattern (DRM-002) — pure pattern-string DSL parser, the TS twin of
// src/moshops/DrumPattern.h. Golden vectors are mirrored 1:1 between
// tests/test_drum_pattern.cpp and drumPatternUtil.test.ts — keep in lockstep.
// Lane pitches MUST mirror DRUM_LANES (drumGrid.ts) / kDefaultKit (MoshOps.cpp).

import type { MidiNote } from "../types";
import { laneIndexForPitch, stepBeats } from "./drumGrid";

export type DrumPatternStep = { pitch: number; step: number; velocity: number };

export type DrumPatternParse =
  | {
      ok: true;
      stepsPerBar: number;
      bars: number;
      totalSteps: number;
      steps: DrumPatternStep[]; // lanes in input order, steps ascending
      lanePitches: number[]; // every named lane (even all-rest) — drives per-lane replace
    }
  | { ok: false; error: string };

const LANE_PITCHES: Record<string, number> = {
  kick: 36,
  snare: 38,
  clap: 39,
  hat: 42,
  hihat: 42,
  closedhat: 42,
  ch: 42,
  openhat: 46,
  oh: 46,
  lowtom: 45,
  midtom: 47,
  crash: 49,
};

/** GM pitch for a lane key (case-insensitive; spaces/underscores/hyphens stripped),
 *  or -1 if unknown. Integer keys 0..127 are raw pitches (handled by the parser,
 *  BEFORE normalization — stripping '-' would corrupt negative keys). */
export function drumPatternLanePitch(key: string): number {
  const norm = key.toLowerCase().replace(/[\s_-]+/g, "");
  return LANE_PITCHES[norm] ?? -1;
}

const err = (error: string): DrumPatternParse => ({ ok: false, error });

/** Parse a pattern (object {lane: steps} or flat string "lane: steps; lane: steps").
 *  bars == 0 derives bars from the longest lane. */
export function parseDrumPattern(
  pattern: unknown,
  stepsPerBar = 16,
  bars = 0,
  velocity = 100,
): DrumPatternParse {
  if (!Number.isInteger(stepsPerBar) || stepsPerBar < 1 || stepsPerBar > 64)
    return err(`stepsPerBar must be 1-64 (got ${stepsPerBar})`);
  if (!Number.isInteger(bars) || bars < 0 || bars > 16) return err(`bars must be 1-16 (got ${bars})`);
  if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127)
    return err(`velocity must be 1-127 (got ${velocity})`);

  // Normalize both accepted shapes into ordered [laneKey, laneSteps] entries.
  let entries: Array<[string, unknown]>;
  if (typeof pattern === "string") {
    if (!pattern.trim()) return err("empty pattern");
    entries = [];
    for (const part of pattern.split(/[;\n]/)) {
      if (!part.trim()) continue;
      const i = part.indexOf(":");
      if (i < 0) return err(`pattern lane "${part.trim()}" is missing ':' (expected "lane: steps")`);
      entries.push([part.slice(0, i), part.slice(i + 1)]);
    }
  } else if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    entries = Object.entries(pattern as Record<string, unknown>);
  } else {
    return err('pattern must be an object of lanes or a "lane: steps" string');
  }
  if (entries.length === 0) return err("pattern has no lanes");

  type Lane = { key: string; pitch: number; chars: string };
  const lanes: Lane[] = [];
  const seen = new Set<number>();
  for (const [rawKey, rawSteps] of entries) {
    const key = rawKey.trim();
    if (typeof rawSteps !== "string") return err(`lane "${key}" steps must be a string`);
    let pitch: number;
    if (/^-?\d+$/.test(key)) {
      pitch = parseInt(key, 10);
      if (pitch < 0 || pitch > 127) return err(`lane pitch ${key} out of range 0-127`);
    } else {
      pitch = drumPatternLanePitch(key);
      if (pitch < 0) return err(`unknown lane "${key}"`);
    }
    if (seen.has(pitch)) return err(`duplicate lane "${key}" (pitch ${pitch})`);
    seen.add(pitch);
    const chars = rawSteps.replace(/[|\s]+/g, "");
    if (chars.length === 0) return err(`lane "${key}" is empty`);
    for (const c of chars)
      if (c !== "x" && c !== "X" && c !== "." && c !== "-")
        return err(`lane "${key}" has invalid step char "${c}" (use x X . - |)`);
    lanes.push({ key, pitch, chars });
  }

  const longest = Math.max(...lanes.map((l) => l.chars.length));
  const outBars = bars === 0 ? Math.max(1, Math.ceil(longest / stepsPerBar)) : bars;
  if (outBars > 16) return err(`pattern needs ${outBars} bars (max 16)`);
  const totalSteps = stepsPerBar * outBars;
  for (const l of lanes) {
    if (l.chars.length > totalSteps)
      return err(`lane "${l.key}" is ${l.chars.length} steps but the pattern is ${totalSteps}`);
    if (totalSteps % l.chars.length !== 0)
      return err(`lane "${l.key}" (${l.chars.length} steps) doesn't divide the pattern (${totalSteps} steps) — can't tile`);
  }

  const steps: DrumPatternStep[] = [];
  for (const l of lanes)
    for (let s = 0; s < totalSteps; s++) {
      const c = l.chars[s % l.chars.length];
      if (c === "x") steps.push({ pitch: l.pitch, step: s, velocity });
      else if (c === "X") steps.push({ pitch: l.pitch, step: s, velocity: 127 });
    }

  return { ok: true, stepsPerBar, bars: outBars, totalSteps, steps, lanePitches: lanes.map((l) => l.pitch) };
}

// AGT-MEM (M4) — the exact inverse of parseDrumPattern, in the FLAT STRING form (the
// agent catalog only declares the string form for add_drum_pattern, so that's the only
// shape worth serializing to). Used by the "Save pattern to memory" affordance to turn a
// live drum clip's steps back into a verbatim-replayable pattern string for a
// DrumPatternCard, AND by the memory-retrieval renderer to show a saved card's groove.
//
// This is a PURE TS-only addition — parseDrumPattern's semantics are unchanged, so
// src/moshops/DrumPattern.h (the C++ twin) needs no corresponding change; it never has
// to serialize, only parse. The twin-lockstep discipline for THIS file only applies to
// parse golden vectors, which stay untouched.
//
// Contract is a SEMANTIC round-trip, not a byte-identical one: parse(serialize(parse(s)))
// must equal parse(s) (same stepsPerBar/bars/totalSteps/steps/lanePitches), not
// serialize(parse(s)) === s. Concretely this means: (1) a tiled short lane ("kick: x.")
// serializes back out at FULL LENGTH (16 chars for a 16-step bar) — still round-trips
// correctly since the untiled full string parses to the identical step set; (2) '|'
// cosmetic separators are dropped (parseDrumPattern strips them before use, so there is
// nothing to preserve); (3) a lane's original alias ("hihat"/"closedhat"/"ch" all mean
// pitch 42) is NOT preserved — one canonical name per known pitch is emitted instead,
// which still round-trips to the same pitch; (4) velocity is necessarily binary in the
// string format (parseDrumPattern's `velocity` param is one uniform default for every
// "x" in a single parse call — there is no per-step velocity in the string DSL), so any
// hit at velocity 127 serializes as an accent ('X') and everything else as a plain hit
// ('x') — this matches what a re-parse can actually reconstruct.
const CANONICAL_LANE_NAME: Record<number, string> = (() => {
  const rev: Record<number, string> = {};
  // LANE_PITCHES is defined in object-literal order above; the FIRST alias seen for a
  // given pitch becomes canonical (kick/snare/clap/hat/openhat/lowtom/midtom/crash —
  // never the later hihat/closedhat/ch/oh aliases).
  for (const [name, pitch] of Object.entries(LANE_PITCHES)) if (!(pitch in rev)) rev[pitch] = name;
  return rev;
})();

/** The lane label serializeDrumPattern emits for a pitch: its canonical name if known,
 *  else the raw MIDI pitch number (mirroring the parser's "integer keys are raw
 *  pitches" rule) — always something parseDrumPattern can read straight back. */
export function drumPatternLaneName(pitch: number): string {
  return CANONICAL_LANE_NAME[pitch] ?? String(pitch);
}

export type SerializableDrumPattern = {
  stepsPerBar: number;
  totalSteps: number;
  steps: readonly DrumPatternStep[];
  lanePitches: readonly number[];
};

/** Serializes a parsed pattern (or any equivalent step data — e.g. read live off a drum
 *  clip's notes) back to the flat "lane: steps; lane: steps" string form. Lane order
 *  mirrors `lanePitches` (parseDrumPattern's own "lanes in input order" contract), so a
 *  re-parse reproduces steps in the identical order too. An all-rest lane (present in
 *  `lanePitches` but with zero steps) serializes to an all-'.' lane, preserving its
 *  presence for per-lane-replace semantics. */
export function serializeDrumPattern(p: SerializableDrumPattern): string {
  const lines = p.lanePitches.map((pitch) => {
    const velocityAtStep = new Map<number, number>();
    for (const s of p.steps) if (s.pitch === pitch) velocityAtStep.set(s.step, s.velocity);
    let chars = "";
    for (let i = 0; i < p.totalSteps; i++) {
      const v = velocityAtStep.get(i);
      chars += v === undefined ? "." : v >= 127 ? "X" : "x";
    }
    return `${drumPatternLaneName(pitch)}: ${chars}`;
  });
  return lines.join("; ");
}

// AGT-MEM (M4) — the OTHER direction: reads a live drum clip's MIDI notes into the same
// step-shape serializeDrumPattern expects, for the "Save pattern to memory" affordance.
// Reuses drumGrid.ts's stepBeats/laneIndexForPitch (the identical beat math + known-
// lane-pitch set the drum-grid EDITOR itself uses) rather than re-deriving it here, so
// what gets saved matches what's visually on the grid. A note off-lane (not a recognized
// GM drum pitch) is skipped; every ON-lane note snaps to its NEAREST step (round-to-
// nearest, unbounded — unlike drumGrid.ts's cellForNote, which only searches a fixed
// step RANGE and so can reject a note as "off-grid" when nothing in range is close
// enough, this function has no such range limit, so round-to-nearest always finds a
// step and there is no separate off-grid case to reject).
export function drumPatternFromNotes(
  notes: readonly MidiNote[],
  beatsPerBar: number,
  stepsPerBar = 16,
): SerializableDrumPattern {
  const sb = stepBeats(beatsPerBar, stepsPerBar);
  const hitAt = new Map<string, number>(); // `${pitch}:${step}` -> velocity (first note wins the cell)
  const lanePitches: number[] = [];
  const seenPitch = new Set<number>();
  let maxStep = -1;
  for (const n of notes) {
    if (laneIndexForPitch(n.pitch) < 0) continue;
    const step = Math.max(0, Math.round(n.start / sb));
    const key = `${n.pitch}:${step}`;
    if (!hitAt.has(key)) hitAt.set(key, n.velocity);
    if (!seenPitch.has(n.pitch)) { seenPitch.add(n.pitch); lanePitches.push(n.pitch); }
    if (step > maxStep) maxStep = step;
  }
  const bars = maxStep < 0 ? 1 : Math.max(1, Math.ceil((maxStep + 1) / stepsPerBar));
  const totalSteps = stepsPerBar * bars;
  const steps: DrumPatternStep[] = [];
  for (const [key, velocity] of hitAt) {
    const sep = key.lastIndexOf(":");
    steps.push({ pitch: Number(key.slice(0, sep)), step: Number(key.slice(sep + 1)), velocity });
  }
  // Deterministic order (matches parseDrumPattern's own contract): lanes in
  // first-encountered order, steps ascending within a lane.
  steps.sort((a, b) => lanePitches.indexOf(a.pitch) - lanePitches.indexOf(b.pitch) || a.step - b.step);
  return { stepsPerBar, totalSteps, steps, lanePitches };
}
