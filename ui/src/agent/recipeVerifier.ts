// ── Recipe verifier — a DETERMINISTIC reward over the musical DNA ─────────────
// The reframe (owner): stop rewarding the rendered AUDIO (the composite §12 reward is a
// fuzzy black box that the rating probe proved doesn't track taste, ρ≈0). The agent's
// actual output is a RECIPE — the symbolic command program / musical content (notes,
// pitches, grid, key, parts). Because we built the engine, that recipe is fully
// inspectable, so we can grade it with RULES — no rendering, no taste-model, no GPU.
//
// This is the GEPA `eval_fn` / terrarium scoring choke point: verifyRecipe(recipe) →
// { total 0..1, dims, reasons }. It grades musical CORRECTNESS (the large, deterministically
// checkable core of "is this a competent beat"), NOT subjective taste — and it's
// interpretable + debuggable + fast, which the audio reward never was. GEPA then evolves
// the beat-build agent's prompts to maximize this; later it can serve as an RL reward
// (a VALID one for what it checks). Pure + bridge-free → unit-testable and embeddable.

// music constants (self-contained domain facts; mirror beatSpecs)
const SEMITONE: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6,
  Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const KICK = 36, SNARE = 38;
const HAT_PADS = new Set([42, 44, 46]); // closed/pedal/open hats
const SNARE_PADS = new Set([38, 40]); // acoustic + electric snare
const DRUM_RANGE: [number, number] = [35, 81]; // GM percussion

export type VNote = { pitch: number; start: number; length: number; velocity: number };
export type VRole = "drums" | "bass" | "melody" | "other";
export type VTrack = { name: string; role: VRole; notes: VNote[] };
export type Recipe = { tempo: number; key: { tonic: string; mode: string }; bars: number; tracks: VTrack[] };

export type DimScores = {
  parts: number; drums: number; grid: number; key: number; register: number; density: number; hygiene: number;
};
export type Verdict = { total: number; dims: DimScores; reasons: string[] };

// weights sum to 1 — drums/key/grid carry the musicality; hygiene is a small backstop
const WEIGHTS: DimScores = { parts: 0.15, drums: 0.22, grid: 0.18, key: 0.2, register: 0.1, density: 0.1, hygiene: 0.05 };

const scaleSet = (mode: string): Set<number> => new Set(mode.toLowerCase().startsWith("maj") ? MAJOR : MINOR);
const tonicPc = (tonic: string): number => SEMITONE[tonic] ?? 9;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const GRID = 0.25; // 16th-note grid (beats)
const GRID_TOL = 0.06; // on-grid if within this many beats of a 16th

const onGrid = (start: number) => Math.abs(start - Math.round(start / GRID) * GRID) <= GRID_TOL;
const nearBeat = (start: number, beatInBar: number, bars: number) => {
  for (let b = 0; b < bars; b++) if (Math.abs(start - (b * 4 + beatInBar)) <= GRID_TOL) return true;
  return false;
};

const tracksOf = (r: Recipe, role: VRole) => r.tracks.filter((t) => t.role === role);
const notesOf = (r: Recipe, role: VRole): VNote[] => tracksOf(r, role).flatMap((t) => t.notes);

// ── dimensions ────────────────────────────────────────────────────────────────

function scoreParts(r: Recipe, reasons: string[]): number {
  const want: VRole[] = ["drums", "bass", "melody"];
  let have = 0;
  for (const role of want) {
    const n = notesOf(r, role).length;
    if (n > 0) have++;
    else reasons.push(`parts: missing/empty ${role}`);
  }
  return have / want.length;
}

function scoreDrums(r: Recipe, reasons: string[]): number {
  const notes = notesOf(r, "drums");
  if (notes.length === 0) { reasons.push("drums: no drum part"); return 0; }
  const bars = Math.max(1, r.bars);
  const kicks = notes.filter((n) => n.pitch === KICK);
  const snares = notes.filter((n) => SNARE_PADS.has(n.pitch));
  const hats = notes.filter((n) => HAT_PADS.has(n.pitch));

  // kick anchors the downbeat: fraction of bars with a kick on beat 1
  let kickBars = 0;
  for (let b = 0; b < bars; b++) if (kicks.some((k) => Math.abs(k.start - b * 4) <= GRID_TOL)) kickBars++;
  const kickDownbeat = kicks.length ? kickBars / bars : 0;
  // snare on the backbeat (beats 2 & 4 → 0-indexed 1 & 3)
  const snareBackbeat = snares.length ? snares.filter((s) => nearBeat(s.start, 1, bars) || nearBeat(s.start, 3, bars)).length / snares.length : 0;
  // hats subdivide: aim for ≥ 8th notes (≥ 8 per bar → 1.0)
  const hatsSubdiv = clamp01(hats.length / (bars * 8));
  // only GM pads
  const padsValid = notes.filter((n) => n.pitch >= DRUM_RANGE[0] && n.pitch <= DRUM_RANGE[1]).length / notes.length;

  if (!kicks.length) reasons.push("drums: no kick (36)");
  if (!snares.length) reasons.push("drums: no snare (38/40)");
  if (!hats.length) reasons.push("drums: no hats (42/44/46)");
  if (kicks.length && kickDownbeat < 0.5) reasons.push("drums: kick not anchoring the downbeat");
  if (snares.length && snareBackbeat < 0.5) reasons.push("drums: snare off the backbeat");

  return mean([kickDownbeat, snareBackbeat, hatsSubdiv, padsValid]);
}

function scoreGrid(r: Recipe, reasons: string[]): number {
  const all = r.tracks.flatMap((t) => t.notes);
  if (!all.length) return 0;
  const on = all.filter((n) => onGrid(n.start)).length;
  const frac = on / all.length;
  if (frac < 0.8) reasons.push(`grid: ${Math.round((1 - frac) * 100)}% of notes off the 16th grid`);
  return frac;
}

function scoreKey(r: Recipe, reasons: string[]): number {
  const scale = scaleSet(r.key.mode);
  const tonic = tonicPc(r.key.tonic);
  const mel = [...notesOf(r, "bass"), ...notesOf(r, "melody"), ...notesOf(r, "other")];
  if (!mel.length) { reasons.push("key: no melodic content to check"); return 0; }
  const inKey = mel.filter((n) => scale.has(((n.pitch - tonic) % 12 + 12) % 12)).length;
  const frac = inKey / mel.length;
  if (frac < 0.85) reasons.push(`key: ${Math.round((1 - frac) * 100)}% of melodic notes out of ${r.key.tonic} ${r.key.mode}`);
  return frac;
}

function scoreRegister(r: Recipe, reasons: string[]): number {
  const checks: number[] = [];
  const bass = notesOf(r, "bass");
  if (bass.length) {
    const ok = bass.filter((n) => n.pitch >= 21 && n.pitch <= 55).length / bass.length; // low register
    if (ok < 0.8) reasons.push("register: bass notes out of the bass register");
    checks.push(ok);
  }
  const mel = notesOf(r, "melody");
  if (mel.length) {
    const ok = mel.filter((n) => n.pitch >= 48 && n.pitch <= 100).length / mel.length; // mid/high
    if (ok < 0.8) reasons.push("register: lead notes out of the melodic register");
    checks.push(ok);
  }
  const drums = notesOf(r, "drums");
  if (drums.length) checks.push(drums.filter((n) => n.pitch >= DRUM_RANGE[0] && n.pitch <= DRUM_RANGE[1]).length / drums.length);
  return checks.length ? mean(checks) : 0;
}

function scoreDensity(r: Recipe, reasons: string[]): number {
  const bars = Math.max(1, r.bars);
  const band = (n: number, lo: number, hi: number) => (n < lo ? clamp01(n / Math.max(1, lo)) : n > hi ? clamp01(hi / n) : 1);
  const perPart: number[] = [];
  for (const role of ["drums", "bass", "melody"] as VRole[]) {
    const notes = notesOf(r, role);
    if (!notes.length) continue; // counted by parts, not here
    const perBar = notes.length / bars;
    const [lo, hi] = role === "drums" ? [3, 24] : role === "bass" ? [1, 12] : [1, 16];
    const dens = band(perBar, lo, hi);
    const distinct = new Set(notes.map((n) => n.pitch)).size;
    const variety = role === "drums" ? clamp01(distinct / 2) : clamp01(distinct / 3); // monotone → low
    if (dens < 0.5) reasons.push(`density: ${role} too ${perBar < lo ? "sparse" : "busy"} (${perBar.toFixed(1)}/bar)`);
    if (variety < 0.5) reasons.push(`density: ${role} monotone (${distinct} distinct pitches)`);
    perPart.push(mean([dens, variety]));
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
  const seen = new Set<string>(); let dups = 0;
  for (const n of all) { const k = `${n.pitch}@${n.start.toFixed(3)}`; if (seen.has(k)) dups++; else seen.add(k); }
  if (oor) { penalty += 0.5; reasons.push(`hygiene: ${oor} out-of-range pitches`); }
  if (badLen) { penalty += 0.3; reasons.push(`hygiene: ${badLen} zero/negative-length notes`); }
  if (emptyClips) { penalty += 0.1 * emptyClips; reasons.push(`hygiene: ${emptyClips} empty track(s)`); }
  if (dups > all.length * 0.1) { penalty += 0.3; reasons.push(`hygiene: ${dups} duplicate notes (spam)`); }
  return clamp01(1 - penalty);
}

// ── aggregate ───────────────────────────────────────────────────────────────

/** Grade a recipe's musical DNA deterministically. Pure. */
export function verifyRecipe(r: Recipe): Verdict {
  const reasons: string[] = [];
  const dims: DimScores = {
    parts: scoreParts(r, reasons),
    drums: scoreDrums(r, reasons),
    grid: scoreGrid(r, reasons),
    key: scoreKey(r, reasons),
    register: scoreRegister(r, reasons),
    density: scoreDensity(r, reasons),
    hygiene: scoreHygiene(r, reasons),
  };
  const total = (Object.keys(WEIGHTS) as (keyof DimScores)[]).reduce((s, k) => s + WEIGHTS[k] * dims[k], 0);
  return { total: Math.round(total * 1e6) / 1e6, dims, reasons };
}

// ── snapshot → recipe (to score real beat-build output) ───────────────────────

type SnapTrack = { name?: string; type?: string; clips?: { notes?: VNote[] }[] };
type SnapLike = { session?: { tempo?: number; key?: { tonic?: string; mode?: string } }; tracks?: SnapTrack[] };

/** Infer a track's role: drum-type → drums; else low median pitch → bass; else melody. */
function inferRole(t: SnapTrack, notes: VNote[]): VRole {
  if ((t.type ?? "") === "drum") return "drums";
  if (/808|bass|sub/i.test(t.name ?? "")) return "bass";
  if (!notes.length) return "other";
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const median = pitches[Math.floor(pitches.length / 2)];
  return median < 52 ? "bass" : "melody";
}

/** Build a Recipe from a mock/native snapshot so verifyRecipe can grade a generated beat.
 *  `bars` defaults from the longest clip's note span (rounded up to a bar). */
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
