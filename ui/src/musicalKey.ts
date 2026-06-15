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
