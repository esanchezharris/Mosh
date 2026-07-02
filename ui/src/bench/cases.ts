// Moshi-Bench v0 — case set. ~30 NL→command cases graded by EXECUTED STATE on the
// real headless engine (never by text match, never by exact gold args).
//
// Grading philosophy (from the 2026-07 training audit):
// - Relative asks get DIRECTION + TOLERANCE-BAND checks ("bring the drums down" =
//   volumeDb moved down by 1–12 dB), never exact values — the SFT corpus's
//   "turn it up a little"→db:0 defect is the proof case for why exact gold is wrong.
// - Defer cases expect NO commands (ambiguous/impossible asks).
// - Corrective cases can render before/after WAVs so the owner's ears stay paired
//   with the proxy metric (anti-Goodhart).
//
// Setups use engine-deterministic ids (fresh headless engine assigns the same ids
// for the same command prefix — verified) or ${VAR} captures; graders match tracks
// BY NAME so they never depend on id guesses.

export type Cmd = { command: string; args?: Record<string, unknown>; capture?: Record<string, string> };

export type Check =
  | { kind: "tempo"; eq?: number; min?: number; max?: number; tol?: number }
  | { kind: "timeSig"; num: number; den: number }
  | { kind: "trackCount"; delta: number }
  | { kind: "trackExists"; name: string; negate?: boolean }
  | { kind: "trackField"; track: string; field: "volumeDb" | "pan" | "mute" | "solo"; eq?: unknown; min?: number; max?: number; tol?: number }
  | { kind: "trackDelta"; track: string; field: "volumeDb" | "pan"; dir: "down" | "up"; min: number; max: number }
  | { kind: "clipCount"; track: string; delta: number }
  | { kind: "clipStart"; track: string; clipIndex: number; minSec: number; maxSec: number }
  | { kind: "transport"; field: "playing" | "looping"; eq: boolean }
  | { kind: "transportPos"; minSec: number; maxSec: number }
  | { kind: "sectionExists"; name: string; startBeat?: number; endBeat?: number; tolBeats?: number; negate?: boolean }
  | { kind: "pluginOnTrack"; track: string; nameIncludes: string; negate?: boolean }
  | { kind: "cmdOk"; name: string; min: number }
  | { kind: "defer" };

export type BenchCase = {
  id: string;
  area: string;
  utterance: string;
  setup: Cmd[];
  checks: Check[];
  /** Render before/after WAVs for the owner's ears (corrective cases). */
  render?: boolean;
};

// Standard seeded session: Vocal(1010) Drums(1011) 808(1012) Keys(1013), a tone
// clip on Drums and on 808, a MIDI clip on Keys. Ids deterministic by creation order.
const SEED: Cmd[] = [
  { command: "set_tempo", args: { bpm: 120 } },
  { command: "create_track", args: { name: "Vocal" }, capture: { TVOX: "trackId" } },
  { command: "create_track", args: { name: "Drums" }, capture: { TDRUM: "trackId" } },
  { command: "create_track", args: { name: "808" }, capture: { T808: "trackId" } },
  { command: "create_track", args: { name: "Keys" }, capture: { TKEYS: "trackId" } },
  { command: "add_test_tone_clip", args: { trackId: "${TDRUM}", seconds: 4 } },
  { command: "add_test_tone_clip", args: { trackId: "${T808}", seconds: 4, freq: 110 } },
  { command: "add_midi_clip", args: { trackId: "${TKEYS}", start: 0, length: 4 }, capture: { CKEYS: "clipId" } },
];

export const BENCH_CASES: BenchCase[] = [
  // ── session / tempo ───────────────────────────────────────────────────────────
  { id: "tempo-plain", area: "session", utterance: "set the tempo to 128", setup: SEED, checks: [{ kind: "tempo", eq: 128 }] },
  { id: "tempo-slang", area: "session", utterance: "this needs to sit at like 140, trap tempo", setup: SEED, checks: [{ kind: "tempo", eq: 140 }] },
  { id: "tempo-relative", area: "session", utterance: "bump the tempo up a little", setup: SEED, checks: [{ kind: "tempo", min: 121, max: 140 }] },
  { id: "timesig", area: "session", utterance: "switch us to 3/4 time", setup: SEED, checks: [{ kind: "timeSig", num: 3, den: 4 }] },
  {
    id: "undo-tempo",
    area: "session",
    utterance: "undo that last change",
    setup: [...SEED, { command: "set_tempo", args: { bpm: 174 } }],
    checks: [{ kind: "tempo", eq: 120 }],
  },
  // ── tracks ────────────────────────────────────────────────────────────────────
  { id: "track-create", area: "tracks", utterance: "make me a new track called Guitar", setup: SEED, checks: [{ kind: "trackExists", name: "Guitar" }, { kind: "trackCount", delta: 1 }] },
  { id: "track-create-drum", area: "tracks", utterance: "add a drum track for my hats", setup: SEED, checks: [{ kind: "trackCount", delta: 1 }] },
  { id: "track-rename", area: "tracks", utterance: "rename the Keys track to Piano", setup: SEED, checks: [{ kind: "trackExists", name: "Piano" }, { kind: "trackExists", name: "Keys", negate: true }] },
  { id: "track-remove", area: "tracks", utterance: "get rid of the Vocal track", setup: SEED, checks: [{ kind: "trackExists", name: "Vocal", negate: true }, { kind: "trackCount", delta: -1 }] },
  // ── mixer (tolerance-band by design) ──────────────────────────────────────────
  { id: "vol-down-relative", area: "mixer", utterance: "the Drums are too loud, bring them down", setup: SEED, checks: [{ kind: "trackDelta", track: "Drums", field: "volumeDb", dir: "down", min: 1, max: 15 }] },
  {
    id: "vol-up-relative",
    area: "mixer",
    utterance: "I can barely hear the 808, turn it up",
    setup: [...SEED, { command: "set_track_volume", args: { trackId: "${T808}", db: -12 } }],
    checks: [{ kind: "trackDelta", track: "808", field: "volumeDb", dir: "up", min: 1, max: 18 }],
  },
  { id: "vol-absolute", area: "mixer", utterance: "set the Keys to -6 dB", setup: SEED, checks: [{ kind: "trackField", track: "Keys", field: "volumeDb", eq: -6, tol: 0.25 }] },
  { id: "pan-hard-left", area: "mixer", utterance: "pan the Keys hard left", setup: SEED, checks: [{ kind: "trackField", track: "Keys", field: "pan", max: -0.7 }] },
  {
    id: "pan-recenter",
    area: "mixer",
    utterance: "bring the keys back toward the center",
    setup: [...SEED, { command: "set_track_pan", args: { trackId: "${TKEYS}", pan: -0.9 } }],
    checks: [{ kind: "trackField", track: "Keys", field: "pan", min: -0.25, max: 0.25 }],
  },
  { id: "mute", area: "mixer", utterance: "mute the vocal", setup: SEED, checks: [{ kind: "trackField", track: "Vocal", field: "mute", eq: true }] },
  { id: "solo", area: "mixer", utterance: "solo the drums for me", setup: SEED, checks: [{ kind: "trackField", track: "Drums", field: "solo", eq: true }] },
  {
    id: "unmute-all",
    area: "mixer",
    utterance: "unmute everything",
    setup: [...SEED, { command: "set_track_mute", args: { trackId: "${TVOX}", mute: true } }, { command: "set_track_mute", args: { trackId: "${TKEYS}", mute: true } }],
    checks: [{ kind: "trackField", track: "Vocal", field: "mute", eq: false }, { kind: "trackField", track: "Keys", field: "mute", eq: false }],
  },
  // ── clips ─────────────────────────────────────────────────────────────────────
  { id: "clip-add-midi", area: "clips", utterance: "add a midi clip on the Keys track", setup: SEED, checks: [{ kind: "clipCount", track: "Keys", delta: 1 }] },
  { id: "clip-add-tone", area: "clips", utterance: "drop a test tone on the Vocal track", setup: SEED, checks: [{ kind: "clipCount", track: "Vocal", delta: 1 }] },
  { id: "clip-move", area: "clips", utterance: "move the drum clip so it starts at bar 3", setup: SEED, checks: [{ kind: "clipStart", track: "Drums", clipIndex: 0, minSec: 3.5, maxSec: 4.5 }] },
  { id: "clip-split", area: "clips", utterance: "split the 808 clip down the middle", setup: SEED, checks: [{ kind: "clipCount", track: "808", delta: 1 }] },
  // ── notes ─────────────────────────────────────────────────────────────────────
  { id: "notes-populate", area: "notes", utterance: "write a quick little four note melody into the keys clip", setup: SEED, checks: [{ kind: "cmdOk", name: "add_note", min: 3 }] },
  // ── transport ─────────────────────────────────────────────────────────────────
  { id: "transport-play", area: "transport", utterance: "play it", setup: SEED, checks: [{ kind: "transport", field: "playing", eq: true }] },
  {
    id: "transport-stop",
    area: "transport",
    utterance: "stop playback",
    setup: [...SEED, { command: "set_transport", args: { action: "play" } }],
    checks: [{ kind: "transport", field: "playing", eq: false }],
  },
  { id: "transport-seek", area: "transport", utterance: "jump to bar 5", setup: SEED, checks: [{ kind: "transportPos", minSec: 7.5, maxSec: 8.5 }] },
  // NOTE (audit finding): the catalog cannot express a loop REGION (set_transport
  // has only a loop boolean + position) — grading loop-on only. Catalog-extension
  // candidate for the follow-ups.
  { id: "transport-loop-on", area: "transport", utterance: "turn looping on", setup: SEED, checks: [{ kind: "transport", field: "looping", eq: true }] },
  // ── sections ──────────────────────────────────────────────────────────────────
  { id: "section-create", area: "sections", utterance: "mark beats 0 to 16 as the Intro", setup: SEED, checks: [{ kind: "sectionExists", name: "Intro", startBeat: 0, endBeat: 16, tolBeats: 1 }] },
  {
    id: "section-rename",
    area: "sections",
    utterance: "rename the Intro section to Cold Open",
    setup: [...SEED, { command: "create_section", args: { name: "Intro", startBeat: 0, endBeat: 16 } }],
    checks: [{ kind: "sectionExists", name: "Cold Open" }, { kind: "sectionExists", name: "Intro", negate: true }],
  },
  // ── built-in FX ───────────────────────────────────────────────────────────────
  { id: "fx-ott", area: "fx", utterance: "slap some OTT style compression on the Drums", setup: SEED, checks: [{ kind: "pluginOnTrack", track: "Drums", nameIncludes: "ott" }] },
  { id: "fx-autotune", area: "fx", utterance: "put autotune on the vocal", setup: SEED, checks: [{ kind: "pluginOnTrack", track: "Vocal", nameIncludes: "tune" }] },
  // ── defer (ambiguous / impossible) ────────────────────────────────────────────
  { id: "defer-ambiguous", area: "defer", utterance: "make that louder", setup: SEED, checks: [{ kind: "defer" }] },
  { id: "defer-vague", area: "defer", utterance: "make it sound better", setup: SEED, checks: [{ kind: "defer" }] },
  { id: "defer-impossible", area: "defer", utterance: "email this beat to my label", setup: SEED, checks: [{ kind: "defer" }] },
  // ── corrective (rendered for the owner's ears) ────────────────────────────────
  {
    id: "corr-drums-drowning",
    area: "corrective",
    utterance: "the drums are drowning everything, fix the balance",
    setup: [...SEED, { command: "set_track_volume", args: { trackId: "${TDRUM}", db: 9 } }],
    checks: [{ kind: "trackDelta", track: "Drums", field: "volumeDb", dir: "down", min: 3, max: 20 }],
    render: true,
  },
  {
    id: "corr-808-lost",
    area: "corrective",
    utterance: "the 808 is getting completely lost, sort it out",
    setup: [...SEED, { command: "set_track_volume", args: { trackId: "${T808}", db: -18 } }],
    checks: [{ kind: "trackDelta", track: "808", field: "volumeDb", dir: "up", min: 3, max: 24 }],
    render: true,
  },
];
