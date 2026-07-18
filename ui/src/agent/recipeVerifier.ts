// ── Recipe verifier — a DETERMINISTIC reward over the musical DNA ─────────────
// The reframe (owner): stop rewarding the rendered AUDIO (the composite §12 reward is a
// fuzzy black box the rating probe proved doesn't track taste, ρ≈0). The agent's actual
// output is a RECIPE — the symbolic command program / musical content (notes, pitches,
// grid, key, parts). Because we built the engine, that recipe is fully inspectable, so we
// grade it with RULES — no rendering, no taste-model, no GPU. This is the GEPA `eval_fn` /
// terrarium scoring choke point: verifyRecipe(recipe) → { total 0..1, dims, reasons }.
//
// HARDENED v2: a 6-lens red-team (harden-recipe-verifier workflow) found 24/24 Goodhart
// exploits against v1 — flat-velocity "metronomes", copy-paste bar-clones, kick+hats on
// every 16th, octave-spammed/chord-stab "melodies", tone-clusters, flam-storms. A reward
// you OPTIMIZE against must resist gaming, so v2 adds dynamics (velocity RANGE, not a
// distinct-count a 100-vs-101 decoy defeats), variation (bars must develop, not clone),
// and contour (pitch-CLASS variety + onset-rhythm + interval sanity), and hardens drums
// (anti-saturation + kick/snare collision) and hygiene (flam + cluster). Pure + bridge-free.

import { NOTE_PC, SCALES, isMode, type Mode } from "../musicalKey";

const KICK = 36;
const HAT_PADS = new Set([42, 44, 46]);
const SNARE_PADS = new Set([38, 40]);
const DRUM_RANGE: [number, number] = [35, 81];

export type VNote = { pitch: number; start: number; length: number; velocity: number };
export type VRole = "drums" | "bass" | "melody" | "other";
// PRODUCTION (the owner's reframe — "the recipe includes production"): which REAL sounds a
// track uses. Provenance only (real-library vs bundled-stock vs bare-default), never taste —
// "which kick is best" is learned from owner A/B picks (#56), never hard-coded here.
export type SoundRealness = "real" | "stock" | "default" | "none";
export type VPad = { note: number; realness: "real" | "stock" }; // a drum pad's assigned one-shot
export type VProduction = {
  instrument?: { name: string; realness: SoundRealness }; // melodic/bass hosting instrument (synth / melodic 808)
  pads?: VPad[]; // drum pads with an assigned sample (note → real/stock)
  sampleRealness?: SoundRealness; // a wave-clip voice's source classification
  volumeDb?: number; // mix presence (off-default → the producer mixed)
  pan?: number;
};
export type VTrack = { name: string; role: VRole; notes: VNote[]; production?: VProduction };
// productionObserved: the recipe was built from a COMMAND PROGRAM (sounds are fully visible) —
// a triggered voice with no real sound is then a real omission (an outline) and scored 0.
// Absent/false (snapshot, where the Sampler is opaque; or musical-only test recipes) → a
// voice with no production info is NEUTRAL (never falsely failed).
export type Recipe = { tempo: number; key: { tonic: string; mode: string }; bars: number; tracks: VTrack[]; productionObserved?: boolean };

export type DimScores = {
  parts: number; drums: number; grid: number; key: number; register: number;
  dynamics: number; variation: number; contour: number; density: number; hygiene: number;
  realness: number; kit_coverage: number; mix: number;
};
export type Verdict = { total: number; dims: DimScores; reasons: string[] };

// weights sum to 1 — the three musical anti-gaming dims (dynamics/variation/contour) plus
// the production realness gate carry the conjunction; production COMPLETENESS (kit_coverage,
// mix) adds modest weight. Musical dims still hold 0.89 of the base; realness's real power is
// the GATE (a stock-sound outline is multiplied down hard no matter how good the MIDI).
const WEIGHTS: DimScores = {
  parts: 0.09, drums: 0.15, grid: 0.08, key: 0.12, register: 0.04,
  dynamics: 0.11, variation: 0.11, contour: 0.11, density: 0.04, hygiene: 0.04,
  realness: 0.05, kit_coverage: 0.04, mix: 0.02,
};

// ── production: real-vs-stock classifier (provenance, NEVER taste) ─────────────
// "stock" = the bundled mosh-kit (the only sounds the engine auto-provides); "real" = any
// other path (the owner's musica/Splice library, or an imported file). By exclusion of the
// known stock set — never an allowlist of "good" sounds.
const STOCK_KIT_DIRMARK = "drumkits/mosh-kit";
const STOCK_KIT_FILES = new Set(["kick.wav", "snare.wav", "clap.wav", "hat_closed.wav", "hat_open.wav", "tom_low.wav", "tom_mid.wav", "crash.wav"]);
const DEFAULT_INSTRUMENTS = new Set(["4osc", "4OSC Synth", "sampler", "Sampler"]); // bare auto-loaded built-ins
const KIT_PAD_PITCHES = [36, 38, 39, 42, 46, 45, 47, 49]; // bundled kDefaultKit GM pitches

export function classifySample(path: string): "real" | "stock" {
  const p = (path || "").replace(/\\/g, "/");
  const base = (p.split("/").pop() || "").toLowerCase();
  if (p.includes(STOCK_KIT_DIRMARK)) return "stock";
  if (STOCK_KIT_FILES.has(base)) return "stock";
  return "real";
}
export function classifyInstrument(name: string): SoundRealness {
  return DEFAULT_INSTRUMENTS.has(name) ? "default" : "real";
}

/** The declared mode resolved into the six-mode `set_key` domain. Out-of-domain strings
 *  keep v2's coarse major-prefix heuristic (everything else read as minor) so grading never
 *  silently flips for a string the domain doesn't cover — the engine's `set_key` validates,
 *  but a raw command program reaching `recipeFromProgram` may carry anything. */
const modeOf = (mode: string): Mode => {
  const m = (mode || "").toLowerCase();
  return isMode(m) ? m : m.startsWith("maj") ? "major" : "minor";
};
const tonicPc = (tonic: string): number => NOTE_PC[tonic] ?? 9;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pc = (p: number) => ((p % 12) + 12) % 12;
const GRID = 0.25, GRID_TOL = 0.06;
const onGrid = (s: number) => Math.abs(s - Math.round(s / GRID) * GRID) <= GRID_TOL;
const nearBeat = (s: number, beatInBar: number, bars: number) => { for (let b = 0; b < bars; b++) if (Math.abs(s - (b * 4 + beatInBar)) <= GRID_TOL) return true; return false; };
const barOf = (s: number) => Math.floor(s / 4);
const slot16 = (s: number) => Math.round((((s % 4) + 4) % 4) / GRID); // 16th slot within a bar (0..15)

const tracksOf = (r: Recipe, role: VRole) => r.tracks.filter((t) => t.role === role);
const notesOf = (r: Recipe, role: VRole): VNote[] => tracksOf(r, role).flatMap((t) => t.notes);
const melodicTracks = (r: Recipe) => r.tracks.filter((t) => (t.role === "bass" || t.role === "melody" || t.role === "other") && t.notes.length);

// ── structural dimensions ─────────────────────────────────────────────────────

function scoreParts(r: Recipe, reasons: string[]): number {
  const want: VRole[] = ["drums", "bass", "melody"];
  let have = 0;
  for (const role of want) { if (notesOf(r, role).length > 0) have++; else reasons.push(`parts: missing/empty ${role}`); }
  return have / want.length;
}

function scoreDrums(r: Recipe, reasons: string[]): number {
  const notes = notesOf(r, "drums");
  if (notes.length === 0) { reasons.push("drums: no drum part"); return 0; }
  const bars = Math.max(1, r.bars);
  const kicks = notes.filter((n) => n.pitch === KICK);
  const snares = notes.filter((n) => SNARE_PADS.has(n.pitch));
  const hats = notes.filter((n) => HAT_PADS.has(n.pitch));

  // kick anchors beat 1 — but NOT by being on every slot (occupancy gate kills the wall)
  let kickBars = 0;
  for (let b = 0; b < bars; b++) if (kicks.some((k) => Math.abs(k.start - b * 4) <= GRID_TOL)) kickBars++;
  const kickPerBar = kicks.length / bars;
  const kickSparse = kickPerBar <= 6 ? 1 : clamp01((16 - kickPerBar) / 10); // >6/bar ramps down; ~16/bar (wall) → 0
  const kickAnchor = kicks.length ? (kickBars / bars) * kickSparse : 0;
  // snare on the backbeat (2 & 4)
  const snareBackbeat = snares.length ? snares.filter((s) => nearBeat(s.start, 1, bars) || nearBeat(s.start, 3, bars)).length / snares.length : 0;
  // hats: a SWEET SPOT (~4–12/bar). too few → not subdividing; too many → machine-gun
  const hatsPerBar = hats.length / bars;
  const hatsSweet = hatsPerBar < 2 ? clamp01(hatsPerBar / 2) : hatsPerBar <= 12 ? 1 : clamp01((24 - hatsPerBar) / 12);
  const padsValid = notes.filter((n) => n.pitch >= DRUM_RANGE[0] && n.pitch <= DRUM_RANGE[1]).length / notes.length;
  // kick/snare collision (kick buries the backbeat snare → mud)
  const collisions = snares.filter((s) => kicks.some((k) => Math.abs(k.start - s.start) <= GRID_TOL)).length;
  const noCollision = snares.length ? 1 - collisions / snares.length : 1;

  if (!kicks.length) reasons.push("drums: no kick (36)");
  if (!snares.length) reasons.push("drums: no snare (38/40)");
  if (!hats.length) reasons.push("drums: no hats (42/44/46)");
  if (kickPerBar > 8) reasons.push(`drums: kick on too many slots (${kickPerBar.toFixed(0)}/bar — a wall, not an anchor)`);
  if (hatsPerBar > 14) reasons.push(`drums: machine-gun hats (${hatsPerBar.toFixed(0)}/bar)`);
  if (noCollision < 0.8) reasons.push("drums: kick buries the backbeat snare (collision)");

  return mean([kickAnchor, snareBackbeat, hatsSweet, padsValid, noCollision]);
}

function scoreGrid(r: Recipe, reasons: string[]): number {
  const all = r.tracks.flatMap((t) => t.notes);
  if (!all.length) return 0;
  const frac = all.filter((n) => onGrid(n.start)).length / all.length;
  if (frac < 0.8) reasons.push(`grid: ${Math.round((1 - frac) * 100)}% of notes off the 16th grid`);
  return frac;
}

// A chromatic key declares NO pitch constraint, so there is nothing to verify — every pitch
// is trivially "in scale". Scoring that 1.0 would pay the agent this dimension's full 0.12 of
// weight for REMOVING its own constraint (it authors `set_key`, so the exploit is reachable),
// which is exactly the Goodhart class v2 was hardened against. So chromatic takes the file's
// established "can't measure → neutral" value, the same 0.7 dynamics/variation/realness use.
const KEY_UNVERIFIABLE = 0.7;

function scoreKey(r: Recipe, reasons: string[]): number {
  const mode = modeOf(r.key.mode);
  const mel = melodicTracks(r).flatMap((t) => t.notes);
  if (!mel.length) { reasons.push("key: no melodic content to check"); return 0; }
  if (mode === "chromatic") { reasons.push("key: chromatic declares no pitch constraint — key left unscored"); return KEY_UNVERIFIABLE; }
  const scale = new Set(SCALES[mode]);
  const tonic = tonicPc(r.key.tonic);
  const frac = mel.filter((n) => scale.has(pc(n.pitch - tonic))).length / mel.length;
  if (frac < 0.85) reasons.push(`key: ${Math.round((1 - frac) * 100)}% of melodic notes out of ${r.key.tonic} ${r.key.mode}`);
  return frac;
}

function scoreRegister(r: Recipe, reasons: string[]): number {
  const checks: number[] = [];
  const bass = notesOf(r, "bass");
  if (bass.length) { const ok = bass.filter((n) => n.pitch >= 21 && n.pitch <= 55).length / bass.length; if (ok < 0.8) reasons.push("register: bass out of the bass register"); checks.push(ok); }
  const mel = notesOf(r, "melody");
  if (mel.length) { const ok = mel.filter((n) => n.pitch >= 48 && n.pitch <= 100).length / mel.length; if (ok < 0.8) reasons.push("register: lead out of the melodic register"); checks.push(ok); }
  const drums = notesOf(r, "drums");
  if (drums.length) checks.push(drums.filter((n) => n.pitch >= DRUM_RANGE[0] && n.pitch <= DRUM_RANGE[1]).length / drums.length);
  return checks.length ? mean(checks) : 0;
}

// ── anti-gaming dimensions (added in v2) ───────────────────────────────────────

/** Velocity dynamics: per-part velocity RANGE (max−min). Flat = robotic. Range-based
 *  (not distinct-count) so a 100-vs-101 two-velocity decoy can't fake it. */
function scoreDynamics(r: Recipe, reasons: string[]): number {
  const parts = r.tracks.filter((t) => t.notes.length >= 4);
  if (!parts.length) return 0.7; // too few notes to judge → neutral
  const s = mean(parts.map((t) => {
    const v = t.notes.map((n) => n.velocity);
    return clamp01((Math.max(...v) - Math.min(...v)) / 20); // ~20+ spread → full
  }));
  if (s < 0.4) reasons.push("dynamics: flat velocities (robotic — no accents/ghost notes)");
  return s;
}

const barSig = (notes: VNote[]) => notes.map((n) => `${n.pitch}:${slot16(n.start)}`).sort().join(",");

/** Development: bars must differ, not be copy-paste clones. Measured on melodic parts
 *  (drums may repeat); all-identical bars → 0, fully developing → 1. */
function scoreVariation(r: Recipe, reasons: string[]): number {
  const mel = melodicTracks(r);
  if (!mel.length || r.bars < 2) return 0.7; // can't measure
  const s = mean(mel.map((t) => {
    const byBar: VNote[][] = Array.from({ length: r.bars }, () => []);
    for (const n of t.notes) { const b = barOf(n.start); if (b >= 0 && b < r.bars) byBar[b].push(n); }
    const distinct = new Set(byBar.map(barSig)).size;
    return (distinct - 1) / (r.bars - 1); // 1 distinct (clone) → 0; all distinct → 1
  }));
  if (s < 0.4) reasons.push("variation: bars are copy-paste clones (no development/turnaround)");
  return s;
}

/** Melodic sanity: pitch-CLASS variety (octave-spam → low), onset-rhythm (chord-stab →
 *  low), interval sanity (octave-pinball/random-leap → low). 0.3·mean + 0.7·min so any
 *  single degenerate trait (the red-team's three melody exploits) tanks the dimension. */
function scoreContour(r: Recipe, reasons: string[]): number {
  const mel = melodicTracks(r);
  if (!mel.length) return 0;
  const s = mean(mel.map((t) => {
    const notes = [...t.notes].sort((a, b) => a.start - b.start);
    const pcVar = clamp01(new Set(notes.map((n) => pc(n.pitch))).size / 3);               // distinct pitch classes
    const onset = clamp01(new Set(notes.map((n) => Math.round(n.start / GRID))).size / (r.bars * 2)); // rhythmic events
    let steps = 0, leaps = 0;
    for (let i = 1; i < notes.length; i++) { const d = Math.abs(notes[i].pitch - notes[i - 1].pitch); if (d === 0) continue; if (d <= 12) steps++; else leaps++; }
    const interval = steps + leaps ? steps / (steps + leaps) : 0.5;                         // mostly within an octave
    const sub = [pcVar, onset, interval];
    return 0.3 * mean(sub) + 0.7 * Math.min(...sub);
  }));
  if (s < 0.5) reasons.push("contour: non-melodic (octave-spam / chord-stab / random leaps)");
  return s;
}

function scoreDensity(r: Recipe, reasons: string[]): number {
  const bars = Math.max(1, r.bars);
  const band = (n: number, lo: number, hi: number) => (n < lo ? clamp01(n / Math.max(1, lo)) : n > hi ? clamp01(hi / n) : 1);
  const perPart: number[] = [];
  for (const role of ["drums", "bass", "melody"] as VRole[]) {
    const notes = notesOf(r, role);
    if (!notes.length) continue;
    const perBar = notes.length / bars;
    const [lo, hi] = role === "drums" ? [3, 24] : role === "bass" ? [1, 12] : [1, 16];
    const dens = band(perBar, lo, hi);
    if (dens < 0.5) reasons.push(`density: ${role} too ${perBar < lo ? "sparse" : "busy"} (${perBar.toFixed(1)}/bar)`);
    perPart.push(dens);
  }
  return perPart.length ? mean(perPart) : 0;
}

function scoreHygiene(r: Recipe, reasons: string[]): number {
  const all = r.tracks.flatMap((t) => t.notes);
  if (!all.length) { reasons.push("hygiene: no notes at all"); return 0; }
  let penalty = 0;
  const oor = all.filter((n) => n.pitch < 0 || n.pitch > 127).length;
  const badLen = all.filter((n) => !(n.length > 0)).length;
  const emptyClips = r.tracks.filter((t) => t.notes.length === 0).length;
  // flam-spam: same pitch within <0.1 beat of another (micro-offset stacks defeat pitch@start dedup)
  let flam = 0;
  for (const t of r.tracks) {
    const byPitch = new Map<number, number[]>();
    for (const n of t.notes) { const a = byPitch.get(n.pitch) ?? []; a.push(n.start); byPitch.set(n.pitch, a); }
    for (const starts of byPitch.values()) { starts.sort((a, b) => a - b); for (let i = 1; i < starts.length; i++) if (starts[i] - starts[i - 1] < 0.1) flam++; }
  }
  // tone-cluster: >4 notes sharing one onset on a single track (a smear, not a chord)
  let cluster = 0;
  for (const t of r.tracks) { const byStart = new Map<number, number>(); for (const n of t.notes) byStart.set(n.start, (byStart.get(n.start) ?? 0) + 1); for (const c of byStart.values()) if (c > 4) cluster++; }
  if (oor) { penalty += 0.5; reasons.push(`hygiene: ${oor} out-of-range pitches`); }
  if (badLen) { penalty += 0.3; reasons.push(`hygiene: ${badLen} zero/negative-length notes`); }
  if (emptyClips) { penalty += 0.1 * emptyClips; reasons.push(`hygiene: ${emptyClips} empty track(s)`); }
  if (flam > 2) { penalty += 0.4; reasons.push(`hygiene: ${flam} flam/micro-offset stacks (spam)`); }
  if (cluster) { penalty += 0.4; reasons.push(`hygiene: ${cluster} tone-cluster onset(s) (>4 notes at once)`); }
  return clamp01(1 - penalty);
}

// ── production dimensions (presence/realness only — never taste) ───────────────

const DRUM_CORES: [string, number[]][] = [["kick", [36]], ["snare", [38, 40]], ["hat", [42, 44, 46]]];
const playedPitches = (t: VTrack): Set<number> => new Set(t.notes.map((n) => n.pitch));
const padRealness = (prod: VProduction | undefined, note: number): "real" | "stock" | undefined => prod?.pads?.find((p) => p.note === note)?.realness;
const hasDrumProd = (t: VTrack): boolean => !!(t.production?.pads && t.production.pads.length);
const hasVoiceProd = (t: VTrack): boolean => !!(t.production && (t.production.instrument || (t.production.pads && t.production.pads.length) || t.production.sampleRealness));
const voiceIsReal = (t: VTrack): boolean =>
  t.production?.instrument?.realness === "real" ||
  t.production?.sampleRealness === "real" ||
  !!t.production?.pads?.some((p) => p.realness === "real");

/** realness — the owner's complaint operationalized, a GATE. Fraction of TRIGGERED voices
 *  backed by a REAL sound (a real one-shot per played drum pad; a real instrument/sample
 *  for melodic). A stock/outline beat → ~0 → the gate crushes the total even with perfect
 *  MIDI. Unobservable voices (snapshot, no `productionObserved`) are skipped (neutral). */
function scoreRealness(r: Recipe, reasons: string[]): number {
  const observed = !!r.productionObserved;
  const units: number[] = [];
  for (const t of r.tracks) {
    if (!t.notes.length) continue;
    if (t.role === "drums") {
      if (!hasDrumProd(t) && !observed) continue; // Sampler opaque in the snapshot → neutral
      for (const note of playedPitches(t)) {
        if (note < DRUM_RANGE[0] || note > DRUM_RANGE[1]) continue;
        units.push(padRealness(t.production, note) === "real" ? 1 : 0); // a TRIGGERED pad must be real
      }
    } else {
      if (!hasVoiceProd(t) && !observed) continue;
      units.push(voiceIsReal(t) ? 1 : 0);
    }
  }
  if (!units.length) return 0.7;
  const s = mean(units);
  if (s < 0.5) reasons.push("realness: stock/outline sounds — real one-shots/instruments not used");
  return s;
}

/** kit_coverage — completeness. Are the EXPECTED triggered voices sound-backed (kick+snare+
 *  hat each have a one-shot, bass present, melody present)? Credits stock-OR-real (a complete
 *  stock beat covers but is still crushed by realness). Never timbre/taste. */
function scoreKitCoverage(r: Recipe, reasons: string[]): number {
  const observed = !!r.productionObserved;
  const checks: number[] = [];
  for (const t of r.tracks) {
    if (!t.notes.length) continue;
    if (t.role === "drums") {
      if (!hasDrumProd(t) && !observed) continue;
      const played = playedPitches(t);
      for (const [, notes] of DRUM_CORES) {
        const triggered = notes.some((n) => played.has(n));
        if (!triggered) { checks.push(0.5); continue; } // absent voice → neutral
        const backed = notes.some((n) => padRealness(t.production, n) !== undefined); // has ANY sample
        checks.push(backed ? 1 : 0);
      }
    } else if (t.role === "bass") {
      if (!hasVoiceProd(t) && !observed) continue;
      checks.push(hasVoiceProd(t) ? 1 : 0);
    } else if (t.role === "melody") {
      if (!t.production?.instrument && !observed) continue;
      checks.push(t.production?.instrument ? 1 : 0);
    }
  }
  if (!checks.length) return 0.7;
  const s = mean(checks);
  if (s < 0.6) reasons.push("kit_coverage: not every voice is sound-backed (incomplete production)");
  return s;
}

/** mix — light completeness: did the producer touch levels/pan at all (off the engine
 *  default)? Presence only — never a target value. 0.5 floor (untouched mix is fine). */
function scoreMix(r: Recipe, reasons: string[]): number {
  const voices = r.tracks.filter((t) => t.notes.length);
  if (!voices.length) return 0.7;
  const moved = voices.map((t) => (Math.abs(t.production?.volumeDb ?? 0) > 0.01 || Math.abs(t.production?.pan ?? 0) > 0.01) ? 1 : 0);
  const s = clamp01(0.5 + 0.5 * mean(moved));
  if (s <= 0.5) reasons.push("mix: levels left at default (no mix moves)");
  return s;
}

// ── aggregate ───────────────────────────────────────────────────────────────

// Quality is a CONJUNCTION, not a sum: a flat-velocity / copy-paste / atonal / STOCK-SOUND
// beat is bad no matter how clean its structure. A weighted sum lets gaming trade bad dims
// against good ones. So gate the weighted base by the three "must-have" musical dims PLUS
// realness — each near-zero multiplies the total down hard. floor keeps a single soft dim
// from over-punishing while still crushing a true 0 (an all-stock beat → realness≈0 → ~0.45).
const GATE_DIMS: (keyof DimScores)[] = ["dynamics", "variation", "contour", "realness"];
const GATE_FLOOR = 0.5;

/** Grade a recipe's musical DNA deterministically. Pure. */
export function verifyRecipe(r: Recipe): Verdict {
  const reasons: string[] = [];
  const dims: DimScores = {
    parts: scoreParts(r, reasons),
    drums: scoreDrums(r, reasons),
    grid: scoreGrid(r, reasons),
    key: scoreKey(r, reasons),
    register: scoreRegister(r, reasons),
    dynamics: scoreDynamics(r, reasons),
    variation: scoreVariation(r, reasons),
    contour: scoreContour(r, reasons),
    density: scoreDensity(r, reasons),
    hygiene: scoreHygiene(r, reasons),
    realness: scoreRealness(r, reasons),
    kit_coverage: scoreKitCoverage(r, reasons),
    mix: scoreMix(r, reasons),
  };
  const base = (Object.keys(WEIGHTS) as (keyof DimScores)[]).reduce((s, k) => s + WEIGHTS[k] * dims[k], 0);
  const gate = GATE_DIMS.reduce((g, k) => g * (GATE_FLOOR + (1 - GATE_FLOOR) * dims[k]), 1);
  return { total: Math.round(base * gate * 1e6) / 1e6, dims, reasons };
}

// ── snapshot → recipe (to score real beat-build output) ───────────────────────

type SnapPlugin = { name?: string; isInstrument?: boolean };
type SnapTrack = { name?: string; type?: string; volumeDb?: number; pan?: number; plugins?: SnapPlugin[]; clips?: { notes?: VNote[]; sourceFile?: string }[] };
type SnapLike = { session?: { tempo?: number; key?: { tonic?: string; mode?: string } }; tracks?: SnapTrack[] };

function inferRoleFrom(name: string, type: string, notes: VNote[]): VRole {
  if (type === "drum") return "drums";
  if (/808|bass|sub/i.test(name)) return "bass";
  if (!notes.length) return "other";
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)] < 52 ? "bass" : "melody";
}

/** A melodic track with notes but no recorded instrument still plays (the engine auto-loads
 *  4OSC) — mark it the bare default so realness counts it as stock, not unknown. Mutates. */
function normalizeProduction(tracks: VTrack[]): void {
  for (const t of tracks) {
    if (t.production?.pads) t.production.pads.sort((a, b) => a.note - b.note);
    if ((t.role === "melody" || t.role === "bass") && t.notes.length && !(t.production?.instrument) && !(t.production?.pads?.length) && !(t.production?.sampleRealness)) {
      t.production = { ...(t.production ?? {}), instrument: { name: "4osc", realness: "default" } };
    }
  }
}

/** Build a Recipe from a mock/native snapshot so verifyRecipe can grade a generated beat.
 *  Production is populated from what the snapshot exposes (instrument plugins, wave source,
 *  mix). The Sampler's per-pad drum samples are OPAQUE in the snapshot, so drum-pad realness
 *  is left unobserved here (productionObserved=false → neutral); the command-program path is
 *  the one that sees drum samples (recipeFromProgram). */
export function recipeFromSnapshot(snap: SnapLike, bars?: number): Recipe {
  const tracks: VTrack[] = (snap.tracks ?? []).map((t) => {
    const notes: VNote[] = (t.clips ?? []).flatMap((c) => c.notes ?? []);
    const role = inferRoleFrom(t.name ?? "", t.type ?? "", notes);
    const prod: VProduction = {};
    const inst = (t.plugins ?? []).find((p) => p.isInstrument && p.name);
    if (inst?.name) prod.instrument = { name: inst.name, realness: classifyInstrument(inst.name) };
    const wave = (t.clips ?? []).map((c) => c.sourceFile).filter((f): f is string => !!f);
    if (wave.length) prod.sampleRealness = wave.some((f) => classifySample(f) === "real") ? "real" : "stock";
    if (typeof t.volumeDb === "number") prod.volumeDb = t.volumeDb;
    if (typeof t.pan === "number") prod.pan = t.pan;
    const track: VTrack = { name: t.name ?? "", role, notes };
    if (Object.keys(prod).length) track.production = prod;
    return track;
  });
  normalizeProduction(tracks);
  const maxBeat = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.start + n.length)));
  return {
    tempo: snap.session?.tempo ?? 120,
    key: { tonic: snap.session?.key?.tonic ?? "C", mode: snap.session?.key?.mode ?? "minor" },
    bars: bars ?? Math.max(1, Math.ceil(maxBeat / 4)),
    tracks,
  };
}

// ── command program → recipe (the TRAINING path: production fully observable) ──
// Mirrors recipe_verifier.py recipe_from_program. Parses the beat-build program (note
// commands + production commands) so the GRPO/SFT reward grades the symbolic DNA AND the
// sound choices. productionObserved=true → a triggered voice with no real sound is scored 0.

type ProgCmd = { command?: string; args?: Record<string, unknown>; capture?: Record<string, string> };

export function recipeFromProgram(commands: ProgCmd[], bars?: number): Recipe {
  let tempo = 120;
  let key = { tonic: "C", mode: "minor" };
  type TR = VTrack & { _type?: string; _pads?: Map<number, "real" | "stock"> };
  const tracks: TR[] = [];
  const varToTrack = new Map<string, TR>();
  const idToTrack = new Map<string, TR>();
  const resolve = (ref: unknown): TR | undefined => {
    if (typeof ref !== "string") return undefined;
    const v = ref.startsWith("${") && ref.endsWith("}") ? ref.slice(2, -1) : ref;
    return varToTrack.get(v) ?? idToTrack.get(v) ?? varToTrack.get(ref) ?? idToTrack.get(ref);
  };
  const num = (x: unknown, d: number) => { const n = Number(x); return Number.isFinite(n) ? n : d; };
  const prodOf = (t: TR): VProduction => (t.production ??= {});

  for (const c of commands) {
    const cmd = c.command;
    const args = (c.args ?? {}) as Record<string, unknown>;
    const cap = c.capture ?? {};
    if (cmd === "set_tempo") tempo = num(args.bpm ?? args.tempo, tempo);
    else if (cmd === "set_key") key = { tonic: String(args.tonic ?? key.tonic), mode: String(args.mode ?? key.mode) };
    else if (cmd === "create_track" || cmd === "create_group") {
      const tr: TR = { name: String(args.name ?? "track"), _type: String(args.type ?? ""), role: "other", notes: [], _pads: new Map() };
      tracks.push(tr);
      for (const [v, field] of Object.entries(cap)) if (field === "trackId" || field === "id") varToTrack.set(v, tr);
      if (typeof args.id === "string") idToTrack.set(args.id, tr);
    } else if (cmd === "add_midi_clip") {
      const tr = resolve(args.trackId) ?? tracks[tracks.length - 1];
      if (tr) for (const [v, field] of Object.entries(cap)) if (field === "clipId" || field === "id") varToTrack.set(v, tr);
    } else if (cmd === "add_note") {
      const tr = resolve(args.clipId) ?? resolve(args.trackId) ?? tracks[tracks.length - 1];
      if (tr && args.pitch != null && args.start != null) tr.notes.push({ pitch: Math.trunc(num(args.pitch, 0)), start: num(args.start, 0), length: num(args.length, 0.25), velocity: Math.trunc(num(args.velocity, 100)) });
    } else if (cmd === "assign_sample") {
      const tr = resolve(args.trackId);
      if (tr) {
        const rn = classifySample(String(args.file ?? ""));
        if (String(args.mode ?? "drum") === "melodic") prodOf(tr).instrument = { name: String(args.name ?? "808"), realness: rn };
        else tr._pads!.set(Math.trunc(num(args.note, 60)), rn);
      }
    } else if (cmd === "load_drum_kit") {
      const tr = resolve(args.trackId);
      if (tr) for (const n of KIT_PAD_PITCHES) if (!tr._pads!.has(n)) tr._pads!.set(n, "stock");
    } else if (cmd === "load_plugin") {
      const tr = resolve(args.trackId);
      if (tr) { const nm = String(args.pluginId ?? args.name ?? ""); prodOf(tr).instrument = { name: nm, realness: classifyInstrument(nm) }; }
    } else if (cmd === "load_builtin") {
      const tr = resolve(args.trackId);
      if (tr) { const ty = String(args.type ?? ""); prodOf(tr).instrument = { name: ty, realness: classifyInstrument(ty) }; }
    } else if (cmd === "set_track_volume") {
      const tr = resolve(args.trackId);
      if (tr) prodOf(tr).volumeDb = num(args.db ?? args.value ?? args.volumeDb, 0);
    } else if (cmd === "set_track_pan") {
      const tr = resolve(args.trackId);
      if (tr) prodOf(tr).pan = num(args.pan, 0);
    }
  }

  const finalTracks: VTrack[] = tracks.map((tr) => {
    const role = inferRoleFrom(tr.name, tr._type ?? "", tr.notes);
    const pads = tr._pads && tr._pads.size ? [...tr._pads.entries()].map(([note, realness]) => ({ note, realness })) : undefined;
    const prod: VProduction | undefined = (tr.production || pads) ? { ...(tr.production ?? {}), ...(pads ? { pads } : {}) } : undefined;
    const out: VTrack = { name: tr.name, role, notes: tr.notes };
    if (prod) out.production = prod;
    return out;
  });
  normalizeProduction(finalTracks);
  const maxBeat = Math.max(0, ...finalTracks.flatMap((t) => t.notes.map((n) => n.start + n.length)));
  return { tempo, key, bars: bars ?? Math.max(1, Math.ceil(maxBeat / 4)), tracks: finalTracks, productionObserved: true };
}
