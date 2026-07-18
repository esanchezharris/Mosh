// Musical-key domains for the UI — kept IN LOCKSTEP with ui/src/vendor/voice.js.
// The contract (set_key command + snapshot session.key + voice.setKey) requires
// these to match the voice module's NOTE_PC and SCALES keys EXACTLY, so Moshi can
// always snap his earcons into the chosen key.
//
//   voice.js NOTE_PC = { C:0, 'C#':1, Db:1, D:2, 'D#':3, Eb:3, E:4, F:5, 'F#':6,
//                        Gb:6, G:7, 'G#':8, Ab:8, A:9, 'A#':10, Bb:10, B:11 }
//   voice.js SCALES  = { major, minor, dorian, mixolydian, pentatonic, chromatic }
//
// TONICS uses one canonical spelling per pitch-class (the sharp side) so the
// dropdown is unambiguous; every value here is a valid NOTE_PC key in voice.js.

export const TONICS = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;
export type Tonic = (typeof TONICS)[number];

export const MODES = [
  "major", "minor", "dorian", "mixolydian", "pentatonic", "chromatic",
] as const;
export type Mode = (typeof MODES)[number];

// Backend-defaulted fallback (also the voice.js construction default: A minor).
export const DEFAULT_KEY = { tonic: "A", mode: "minor" } as const;

// ─── pitch domain (SCL-001) ──────────────────────────────────────────────────
// The two voice.js tables, mirrored as data instead of only as prose above, so
// the piano roll can shade in-scale rows and scale-lock can snap entered notes.
// musicalKey.test.ts PARSES ui/src/vendor/voice.js and asserts both tables match
// it exactly — "in lockstep" is executable here, not aspirational.
//
// Scale-lock is an INPUT AID applied before a command is sent (the snap-to-grid
// precedent), so it constrains newly entered notes and can never rewrite notes
// the producer didn't touch — reality-model invariant 88.

/** Pitch class per tonic spelling, enharmonics included (voice.js NOTE_PC). */
export const NOTE_PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6,
  Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

/** Semitone offsets from the tonic (voice.js SCALES). `pentatonic` is MINOR pentatonic. */
export const SCALES: Record<Mode, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** A resolved key: tonic pitch-class (0–11) + mode. */
export type ResolvedKey = { tonic: number; mode: Mode };

export const isMode = (m: unknown): m is Mode =>
  typeof m === "string" && Object.prototype.hasOwnProperty.call(SCALES, m);

/** Pitch class of a MIDI pitch, always 0–11 (safe for negatives). */
export const pitchClass = (pitch: number) => ((Math.round(pitch) % 12) + 12) % 12;

/** "C4", "F#3" — MIDI 60 is C4, the convention the piano-roll key sidebar uses. */
export const noteName = (pitch: number) =>
  `${TONICS[pitchClass(pitch)]}${Math.floor(Math.round(pitch) / 12) - 1}`;

/**
 * Resolve a snapshot `session.key` into numeric form. Unknown/missing values
 * fall back to the backend default (A minor) rather than throwing, so shading
 * always has something coherent to draw.
 */
export function resolveKey(key?: { tonic?: string; mode?: string }): ResolvedKey {
  const tonic = NOTE_PC[key?.tonic ?? ""] ?? NOTE_PC[DEFAULT_KEY.tonic];
  return { tonic, mode: isMode(key?.mode) ? key.mode : DEFAULT_KEY.mode };
}

/**
 * 12-slot membership table: `mask[pc]` is true when that pitch class is in the
 * key. Built once per key and reused across all ~61 visible piano-roll rows.
 */
export function scaleMask(key: ResolvedKey): boolean[] {
  const mask = new Array<boolean>(12).fill(false);
  for (const off of SCALES[key.mode]) mask[(key.tonic + off) % 12] = true;
  return mask;
}

export const inScale = (pitch: number, mask: boolean[]) => mask[pitchClass(pitch)];

/**
 * Nearest in-scale pitch. A pitch exactly between two scale tones is always a
 * semitone from each; those ties resolve DOWNWARD, so the result depends only
 * on the pitch — never on which direction the producer dragged from. Clamps to
 * the MIDI range, and returns the input unchanged for a chromatic scale (whose
 * mask is all-true) or a degenerate all-false mask.
 */
export function snapToScale(pitch: number, mask: boolean[]): number {
  // `|| 0` keeps the "always in range" promise total: NaN would otherwise pass
  // straight through both the clamp and the search loop and be returned as-is.
  const p = Math.max(0, Math.min(127, Math.round(pitch) || 0));
  if (mask[pitchClass(p)]) return p;
  for (let d = 1; d <= 6; d++) {
    const down = p - d;
    if (down >= 0 && mask[pitchClass(down)]) return down;
    const up = p + d;
    if (up <= 127 && mask[pitchClass(up)]) return up;
  }
  return p; // no scale tone reachable — behave chromatically, never invent a pitch
}

/** Human label for a key, e.g. "F# minor". */
export const keyLabel = (key: { tonic?: string; mode?: string }) =>
  `${key.tonic ?? DEFAULT_KEY.tonic} ${key.mode ?? DEFAULT_KEY.mode}`;
