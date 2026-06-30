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

const SEMITONE: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6,
  Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const KICK = 36;
const HAT_PADS = new Set([42, 44, 46]);
const SNARE_PADS = new Set([38, 40]);
const DRUM_RANGE: [number, number] = [35, 81];

export type VNote = { pitch: number; start: number; length: number; velocity: number };
export type VRole = "drums" | "bass" | "melody" | "other";
export type VTrack = { name: string; role: VRole; notes: VNote[] };
export type Recipe = { tempo: number; key: { tonic: string; mode: string }; bars: number; tracks: VTrack[] };

export type DimScores = {
  parts: number; drums: number; grid: number; key: number; register: number;
  dynamics: number; variation: number; contour: number; density: number; hygiene: number;
};
export type Verdict = { total: number; dims: DimScores; reasons: string[] };

// weights sum to 1 — the three anti-gaming dims (dynamics/variation/contour) together
// carry as much as the structural core, so a robotic/clone/atonal beat can't win
const WEIGHTS: DimScores = {
  parts: 0.1, drums: 0.17, grid: 0.09, key: 0.13, register: 0.05,
  dynamics: 0.12, variation: 0.12, contour: 0.12, density: 0.05, hygiene: 0.05,
};

const scaleSet = (mode: string): Set<number> => new Set(mode.toLowerCase().startsWith("maj") ? MAJOR : MINOR);
const tonicPc = (tonic: string): number => SEMITONE[tonic] ?? 9;
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

function scoreKey(r: Recipe, reasons: string[]): number {
  const scale = scaleSet(r.key.mode);
  const tonic = tonicPc(r.key.tonic);
  const mel = melodicTracks(r).flatMap((t) => t.notes);
  if (!mel.length) { reasons.push("key: no melodic content to check"); return 0; }
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

// ── aggregate ───────────────────────────────────────────────────────────────

// Musical quality is a CONJUNCTION, not a sum: a flat-velocity / copy-paste / atonal beat
// is bad no matter how clean its structure. A weighted sum lets gaming trade 2 bad dims
// against 8 good ones (a metronome still scored ~0.76). So gate the weighted base by the
// three "must-have" musical dims — each near-zero multiplies the total down hard. floor
// keeps a single soft dim from over-punishing while still crushing a true 0.
const GATE_DIMS: (keyof DimScores)[] = ["dynamics", "variation", "contour"];
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
  };
  const base = (Object.keys(WEIGHTS) as (keyof DimScores)[]).reduce((s, k) => s + WEIGHTS[k] * dims[k], 0);
  const gate = GATE_DIMS.reduce((g, k) => g * (GATE_FLOOR + (1 - GATE_FLOOR) * dims[k]), 1);
  return { total: Math.round(base * gate * 1e6) / 1e6, dims, reasons };
}

// ── snapshot → recipe (to score real beat-build output) ───────────────────────

type SnapTrack = { name?: string; type?: string; clips?: { notes?: VNote[] }[] };
type SnapLike = { session?: { tempo?: number; key?: { tonic?: string; mode?: string } }; tracks?: SnapTrack[] };

function inferRole(t: SnapTrack, notes: VNote[]): VRole {
  if ((t.type ?? "") === "drum") return "drums";
  if (/808|bass|sub/i.test(t.name ?? "")) return "bass";
  if (!notes.length) return "other";
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)] < 52 ? "bass" : "melody";
}

/** Build a Recipe from a mock/native snapshot so verifyRecipe can grade a generated beat. */
export function recipeFromSnapshot(snap: SnapLike, bars?: number): Recipe {
  const tracks: VTrack[] = (snap.tracks ?? []).map((t) => {
    const notes: VNote[] = (t.clips ?? []).flatMap((c) => c.notes ?? []);
    return { name: t.name ?? "", role: inferRole(t, notes), notes };
  });
  const maxBeat = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.start + n.length)));
  return {
    tempo: snap.session?.tempo ?? 120,
    key: { tonic: snap.session?.key?.tonic ?? "C", mode: snap.session?.key?.mode ?? "minor" },
    bars: bars ?? Math.max(1, Math.ceil(maxBeat / 4)),
    tracks,
  };
}
