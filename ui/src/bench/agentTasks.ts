// MoshAgentBench — the multi-step task suite. Each task is a start state (a
// setup command list replayable on BOTH substrates: the dev mock in vitest and
// the real headless engine via --run-script), a natural-language ask, a set of
// deterministic GOAL predicates over the FINAL snapshot (goalChecks.ts), and a
// par step count for efficiency scoring.
//
// Substrate rules:
// - every setup command is agent-callable (contract-tested), so mock parity and
//   native handlers are both guaranteed by the A1 catalog contract;
// - ${VAR} captures use the run-script syntax (runMockSetup mirrors it in
//   vitest; symbolicRemap handles it on the real engine);
// - nothing nondeterministic in a setup (no real adapters, no recording) —
//   cumulative-prefix replay on the real engine depends on it.
//
// Task-design philosophy (inherits src/bench/cases.ts): relative asks get
// direction+band checks, never exact gold; ambiguous asks must genuinely defer;
// `render` marks compose/mix tasks whose before/after audio is worth ears.

import type { Cmd } from "./cases";
import type { GoalCheck } from "./goalChecks";

export type AgentTaskCategory =
  | "arrange" | "compose-drums" | "compose-melody" | "mix" | "master"
  | "generative" | "lyrics" | "repair" | "ambiguous";

export type AgentTask = {
  readonly id: string;
  readonly category: AgentTaskCategory;
  readonly setup: readonly Cmd[];
  readonly ask: string;
  readonly goals: readonly GoalCheck[];
  /** Reference step count for efficiency scoring (0 on ambiguous tasks). */
  readonly par: number;
  readonly maxSteps?: number;
  /** Defer expected: success = a genuine zero-command deferral. */
  readonly ambiguous?: boolean;
  /** Generative: wait this long after the last step for the async job to land. */
  readonly needsWaitMs?: number;
  /** Render before/after WAVs on the real substrate (the by-ear side channel). */
  readonly render?: boolean;
};

// ── shared seeds ──────────────────────────────────────────────────────────────

export const SEED_EMPTY: Cmd[] = [{ command: "set_tempo", args: { bpm: 120 } }];

/** Vocal / Drums(wave tone) / 808(wave tone) / Keys(midi) — the standard band. */
export const SEED_BAND: Cmd[] = [
  { command: "set_tempo", args: { bpm: 120 } },
  { command: "create_track", args: { name: "Vocal" }, capture: { TVOX: "trackId" } },
  { command: "create_track", args: { name: "Drums" }, capture: { TDRUM: "trackId" } },
  { command: "create_track", args: { name: "808" }, capture: { T808: "trackId" } },
  { command: "create_track", args: { name: "Keys" }, capture: { TKEYS: "trackId" } },
  { command: "add_test_tone_clip", args: { trackId: "${TDRUM}", seconds: 4 }, capture: { CDRUM: "clipId" } },
  { command: "add_test_tone_clip", args: { trackId: "${T808}", seconds: 4, freq: 110 }, capture: { C808: "clipId" } },
  { command: "add_midi_clip", args: { trackId: "${TKEYS}", start: 0, length: 4 }, capture: { CKEYS: "clipId" } },
];

export const SEED_SECTIONS: Cmd[] = [
  ...SEED_BAND,
  { command: "create_section", args: { name: "Intro", startBeat: 0, endBeat: 8 } },
  { command: "create_section", args: { name: "Verse", startBeat: 8, endBeat: 24 } },
  { command: "create_section", args: { name: "Hook", startBeat: 24, endBeat: 40 } },
];

// ── the suite ─────────────────────────────────────────────────────────────────

export const AGENT_TASKS: readonly AgentTask[] = [
  // ── arrange ─────────────────────────────────────────────────────────────────
  {
    id: "arr-clear-middle", category: "arrange",
    setup: [
      ...SEED_BAND,
      { command: "add_test_tone_clip", args: { trackId: "${TVOX}", seconds: 4 }, capture: { CVOX: "clipId" } },
      { command: "move_clip", args: { clipId: "${CVOX}", start: 5 } },
    ],
    ask: "wipe out everything between 4 and 8 seconds across the whole arrangement",
    goals: [{ kind: "timeRangeEmpty", startSec: 4, endSec: 8 }, { kind: "cmdOk", name: "delete_time_range", min: 1 }],
    par: 1,
  },
  {
    id: "arr-close-gap", category: "arrange",
    setup: [
      ...SEED_BAND,
      { command: "add_test_tone_clip", args: { trackId: "${TDRUM}", seconds: 4 }, capture: { CD2: "clipId" } },
      { command: "move_clip", args: { clipId: "${CD2}", start: 8 } },
    ],
    ask: "cut the dead space between 4 and 8 seconds and pull everything after it back",
    goals: [{ kind: "cmdOk", name: "delete_time_range", min: 1 }, { kind: "clipStart", track: "Drums", clipIndex: 1, minSec: 3.9, maxSec: 4.1 }],
    par: 1,
  },
  {
    id: "arr-loop-first-second", category: "arrange",
    setup: SEED_BAND,
    ask: "loop just the first second of the drum clip's audio inside the clip",
    goals: [{ kind: "clipField", track: "Drums", clipIndex: 0, field: "loopEnabled", eq: true }, { kind: "cmdOk", name: "set_clip_loop", min: 1 }],
    par: 1,
  },
  {
    id: "arr-split-dup", category: "arrange",
    setup: SEED_BAND,
    ask: "split the 808 clip down the middle and duplicate the back half so it repeats",
    goals: [{ kind: "clipCount", track: "808", delta: 2 }, { kind: "cmdOk", name: "split_clip", min: 1 }, { kind: "cmdOk", name: "duplicate_clip", min: 1 }],
    par: 2,
  },
  {
    id: "arr-map-sections", category: "arrange",
    setup: SEED_BAND,
    ask: "map the song out: intro for the first 8 beats, verse from 8 to 24, hook from 24 to 40",
    goals: [
      { kind: "sectionExists", name: "Intro", startBeat: 0, endBeat: 8, tolBeats: 1 },
      { kind: "sectionExists", name: "Verse", startBeat: 8, endBeat: 24, tolBeats: 1 },
      { kind: "sectionExists", name: "Hook", startBeat: 24, endBeat: 40, tolBeats: 1 },
    ],
    par: 1,
  },
  {
    id: "arr-move-trim", category: "arrange",
    setup: SEED_BAND,
    ask: "move the drum clip to start at bar 2 and make it exactly 2 seconds long",
    goals: [
      { kind: "clipStart", track: "Drums", clipIndex: 0, minSec: 1.9, maxSec: 2.1 },
      { kind: "clipField", track: "Drums", clipIndex: 0, field: "length", eq: 2, tol: 0.05 },
    ],
    par: 1,
  },

  // ── compose: drums ──────────────────────────────────────────────────────────
  {
    id: "drums-boombap", category: "compose-drums",
    setup: SEED_EMPTY,
    ask: "give me two bars of a boom-bap drum groove at 90 bpm",
    goals: [
      { kind: "tempo", eq: 90 },
      { kind: "trackCount", delta: 1 },
      { kind: "cmdOk", name: "add_drum_pattern", min: 1 },
      { kind: "midiNoteCount", track: "Drums", min: 8 },
    ],
    par: 1, render: true,
  },
  {
    id: "drums-new-hats", category: "compose-drums",
    setup: SEED_BAND, // "Drums" here is a WAVE track — a drum pattern needs a new drum track
    ask: "lay some steady 8th-note hats down",
    goals: [{ kind: "cmdOk", name: "add_drum_pattern", min: 1 }, { kind: "trackCount", delta: 1 }],
    par: 1,
  },
  {
    id: "drums-trap-sketch", category: "compose-drums",
    setup: SEED_EMPTY,
    ask: "start a trap sketch at 140 — rolling 16th hats, sparse kick, snare on beat 3",
    goals: [
      { kind: "tempo", eq: 140 },
      { kind: "cmdOk", name: "add_drum_pattern", min: 1 },
      { kind: "midiNoteCount", track: "Drums", min: 16 },
    ],
    par: 1, render: true,
  },
  {
    id: "drums-mute-hat-lane", category: "compose-drums",
    setup: [
      ...SEED_EMPTY,
      { command: "add_drum_pattern", args: { pattern: "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x." } },
    ],
    ask: "the hats are way too much — kill just the hat lane, keep the rest",
    goals: [{ kind: "cmdOk", name: "set_drum_lane", min: 1 }],
    par: 1,
  },

  // ── compose: melody ─────────────────────────────────────────────────────────
  {
    id: "mel-bass-in-key", category: "compose-melody",
    setup: [
      ...SEED_BAND,
      { command: "set_key", args: { tonic: "A", mode: "minor" } },
      { command: "add_midi_clip", args: { trackId: "${T808}", start: 0, length: 4 }, capture: { C808M: "clipId" } },
    ],
    ask: "write a simple one-bar bassline into the 808's midi clip",
    goals: [{ kind: "cmdOk", name: "add_note", min: 3 }, { kind: "notesInKey", track: "808", tonic: "A", mode: "minor", minNotes: 3 }],
    par: 1, render: true,
  },
  {
    id: "mel-keys-in-key", category: "compose-melody",
    setup: [...SEED_BAND, { command: "set_key", args: { tonic: "C", mode: "major" } }],
    ask: "put a gentle four-note melody in the keys clip — keep it in key",
    goals: [{ kind: "cmdOk", name: "add_note", min: 4 }, { kind: "notesInKey", track: "Keys", tonic: "C", mode: "major", minNotes: 4 }],
    par: 1,
  },
  {
    id: "mel-quantize", category: "compose-melody",
    setup: [
      ...SEED_BAND,
      { command: "add_note", args: { clipId: "${CKEYS}", pitch: 60, start: 0.13, length: 0.5 } },
      { command: "add_note", args: { clipId: "${CKEYS}", pitch: 64, start: 1.07, length: 0.5 } },
      { command: "add_note", args: { clipId: "${CKEYS}", pitch: 67, start: 2.21, length: 0.5 } },
      { command: "add_note", args: { clipId: "${CKEYS}", pitch: 72, start: 3.02, length: 0.5 } },
    ],
    ask: "tighten up the keys timing to the grid",
    goals: [{ kind: "cmdOk", name: "quantize_notes", min: 1 }],
    par: 1,
  },
  {
    id: "mel-set-key", category: "compose-melody",
    setup: SEED_BAND,
    ask: "put us in D minor",
    goals: [{ kind: "sessionKey", tonic: "D", mode: "minor" }],
    par: 1,
  },

  // ── mix ─────────────────────────────────────────────────────────────────────
  {
    id: "mix-balance", category: "mix",
    setup: SEED_BAND,
    ask: "drop the drums about 3 dB and nudge the keys a bit to the right",
    goals: [
      { kind: "trackDelta", track: "Drums", field: "volumeDb", dir: "down", min: 1.5, max: 6 },
      { kind: "trackField", track: "Keys", field: "pan", min: 0.05, max: 0.6 },
    ],
    par: 1, render: true,
  },
  {
    id: "mix-vocal-space", category: "mix",
    setup: SEED_BAND,
    ask: "give the vocal some room — a reverb send — and tuck the drums about 2 dB",
    goals: [
      { kind: "busCountDelta", delta: 1 },
      { kind: "sendExists", track: "Vocal" },
      { kind: "trackDelta", track: "Drums", field: "volumeDb", dir: "down", min: 1, max: 4 },
    ],
    par: 2,
  },
  {
    id: "mix-submix", category: "mix",
    setup: SEED_BAND,
    ask: "route the drums and the 808 into a new track called Rhythm so I can treat them as one",
    goals: [{ kind: "trackExists", name: "Rhythm" }, { kind: "cmdOk", name: "set_track_output", min: 2 }],
    par: 2,
  },
  {
    id: "mix-clip-not-fader", category: "mix",
    setup: SEED_BAND,
    ask: "the drum CLIP itself is too hot — take the clip down about 6 dB but leave the fader alone",
    goals: [
      { kind: "clipField", track: "Drums", clipIndex: 0, field: "gainDb", eq: -6, tol: 2 },
      { kind: "trackField", track: "Drums", field: "volumeDb", eq: 0, tol: 0.01 },
    ],
    par: 1, render: true,
  },
  {
    id: "mix-cleanup", category: "mix",
    setup: [
      ...SEED_BAND,
      { command: "set_track_mute", args: { trackId: "${TVOX}", mute: true } },
      { command: "set_track_solo", args: { trackId: "${T808}", solo: true } },
    ],
    ask: "clear the solos and mutes so everything plays",
    goals: [
      { kind: "trackField", track: "Vocal", field: "mute", eq: false },
      { kind: "trackField", track: "808", field: "solo", eq: false },
    ],
    par: 1,
  },

  // ── master ──────────────────────────────────────────────────────────────────
  {
    id: "master-glue", category: "master",
    setup: SEED_BAND,
    ask: "put a gentle compressor on the master bus to glue the mix",
    goals: [{ kind: "masterChainContains", nameIncludes: "comp" }],
    par: 1, render: true,
  },
  {
    id: "master-eq-before-comp", category: "master",
    setup: [...SEED_BAND, { command: "load_master_builtin", args: { type: "compressor" } }],
    ask: "add an EQ on the master before the compressor",
    goals: [{ kind: "masterChainContains", nameIncludes: "eq" }, { kind: "masterChainOrder", first: "eq", then: "comp" }],
    par: 1,
  },
  {
    id: "master-trim", category: "master",
    setup: SEED_BAND,
    ask: "the whole mix is running hot — pull the master down a couple dB",
    goals: [{ kind: "masterDelta", field: "volumeDb", dir: "down", min: 1, max: 6 }],
    par: 1,
  },

  // ── generative (fake adapter on both substrates) ────────────────────────────
  {
    id: "gen-lofi", category: "generative",
    setup: SEED_BAND,
    ask: "make the drum clip lo-fi",
    goals: [{ kind: "cmdOkAny", names: ["compile_render", "create_render_layer"], min: 1 }],
    par: 1, needsWaitMs: 400,
  },
  {
    id: "gen-reimagine-subtle", category: "generative",
    setup: SEED_BAND,
    ask: "re-imagine the 808 clip, but keep it close to my original",
    goals: [
      { kind: "cmdOkAny", names: ["compile_render", "create_render_layer"], min: 1 },
      { kind: "clipField", track: "808", clipIndex: 0, field: "hasRenderLayer", eq: true },
    ],
    par: 2, needsWaitMs: 400,
  },
  {
    id: "gen-run-render", category: "generative",
    setup: [...SEED_BAND, { command: "create_render_layer", args: { clipId: "${CDRUM}" } }],
    ask: "run the render on the drum clip",
    goals: [{ kind: "cmdOk", name: "render_layer", min: 1 }],
    par: 1, needsWaitMs: 600,
  },

  // ── lyrics ──────────────────────────────────────────────────────────────────
  {
    id: "lyr-start-sheet", category: "lyrics",
    setup: SEED_BAND,
    ask: "start a lyric sheet on the vocal track — moody, about neon nights",
    goals: [{ kind: "cmdOk", name: "create_lyric_sheet", min: 1 }],
    par: 1,
  },
  {
    id: "lyr-first-line", category: "lyrics",
    setup: [...SEED_BAND, { command: "create_lyric_sheet", args: { trackId: "${TVOX}" } }],
    ask: "write 'city lights burning cold' as the first line of the vocal's lyrics",
    goals: [{ kind: "cmdOk", name: "set_lyric_line", min: 1 }],
    par: 1,
  },

  // ── repair ──────────────────────────────────────────────────────────────────
  {
    id: "rep-clipping-808", category: "repair",
    setup: [
      ...SEED_BAND,
      { command: "set_track_volume", args: { trackId: "${T808}", db: 9 } },
      { command: "set_clip_gain", args: { clipId: "${C808}", gainDb: 12 } },
    ],
    ask: "the 808 is clipping hard — fix it",
    goals: [
      { kind: "netTrackLevelDelta", track: "808", dir: "down", minDb: 6 },
      { kind: "trackField", track: "808", field: "mute", eq: false }, // muting is not a fix
    ],
    par: 1, render: true,
  },
  {
    id: "rep-move-comp", category: "repair",
    setup: [...SEED_BAND, { command: "load_builtin", args: { trackId: "${TKEYS}", type: "compressor" } }],
    ask: "I meant that compressor for the drums, not the keys — sort it out",
    goals: [
      { kind: "pluginOnTrack", track: "Keys", nameIncludes: "comp", negate: true },
      { kind: "pluginOnTrack", track: "Drums", nameIncludes: "comp" },
    ],
    par: 2,
  },
  {
    id: "rep-rogue-tempo", category: "repair",
    setup: [...SEED_BAND, { command: "insert_tempo_change", args: { time: 4, bpm: 200 } }],
    ask: "the song randomly takes off at 4 seconds — get rid of that",
    goals: [{ kind: "tempoMapPoint", time: 4, negate: true }, { kind: "cmdOk", name: "remove_tempo_change", min: 1 }],
    par: 1,
  },

  // ── ambiguous (must genuinely defer) ────────────────────────────────────────
  { id: "amb-make-better", category: "ambiguous", setup: SEED_BAND, ask: "make it better", goals: [{ kind: "defer" }], par: 0, ambiguous: true },
  {
    id: "amb-delete-bad", category: "ambiguous",
    setup: [...SEED_BAND, { command: "add_test_tone_clip", args: { trackId: "${TDRUM}", seconds: 2 } }],
    ask: "delete the bad one",
    goals: [{ kind: "defer" }], par: 0, ambiguous: true,
  },
  { id: "amb-fix-timing", category: "ambiguous", setup: SEED_BAND, ask: "fix the timing", goals: [{ kind: "defer" }], par: 0, ambiguous: true },
  { id: "amb-upload", category: "ambiguous", setup: SEED_BAND, ask: "master this and upload it to spotify for me", goals: [{ kind: "defer" }], par: 0, ambiguous: true },
];

export function taskById(id: string): AgentTask {
  const t = AGENT_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no agent task "${id}"`);
  return t;
}
