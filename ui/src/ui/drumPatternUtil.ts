// add_drum_pattern (DRM-002) — pure pattern-string DSL parser, the TS twin of
// src/moshops/DrumPattern.h. Golden vectors are mirrored 1:1 between
// tests/test_drum_pattern.cpp and drumPatternUtil.test.ts — keep in lockstep.
// Lane pitches MUST mirror DRUM_LANES (drumGrid.ts) / kDefaultKit (MoshOps.cpp).

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
