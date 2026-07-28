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
  | "generative" | "lyrics" | "repair" | "ambiguous"
  // Conversational categories — tasks with `followUps`, where the thing measured is
  // behaviour ACROSS turns (did it ask before acting, does it track what "the other
  // one" refers to, can it read the damage it just did). See CONVERSATIONAL below.
  | "converse-clarify" | "converse-correct" | "converse-session" | "converse-recover";

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
  /** Conversational tasks: the user turns that follow `ask`, in order. `ask` is
   *  turn 0, so every existing task is already a valid one-turn conversation and
   *  needed no edit when this landed.
   *
   *  These are LITERAL strings, never a model playing the user. A model-driven
   *  user would make the suite nondeterministic — the one property that makes
   *  these numbers worth anything. The price is real and worth stating: we can
   *  check THAT the agent asked and what it did with the answer, but not whether
   *  the question it asked was a good one. Judging question quality needs a judge,
   *  and that is a separate problem.
   *
   *  Consequence for authoring: a follow-up must make sense as a reply to any
   *  reasonable question the agent might ask, because it is sent verbatim
   *  regardless. Write answers, not replies to one imagined question. */
  readonly followUps?: readonly { readonly say: string }[];
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

  // ── CONVERSATIONAL ──────────────────────────────────────────────────────────
  // Tasks with `followUps`: several user turns against ONE accumulating session.
  // These measure the things a single ask structurally cannot reach — whether the
  // agent asks before guessing, whether it tracks what "that" and "the other one"
  // refer to, and whether it can read the mess it just made.
  //
  // Authoring rules, learned the hard way from the `ambiguous` category:
  //   • the opening ask must be GENUINELY ambiguous, or `askedAtTurn` punishes an
  //     agent for being sensibly decisive;
  //   • follow-ups are sent VERBATIM whatever the agent asked, so write them as
  //     answers that stand on their own, not as replies to one imagined question;
  //   • correction tasks assert the FINAL state, so an agent that fixes via `undo`
  //     and one that fixes by re-setting the value both pass — the user cares that
  //     it ends right, not which lever moved.

  // ── converse-clarify: ask first, then act on the answer ─────────────────────
  {
    id: "conv-clarify-louder", category: "converse-clarify",
    setup: SEED_BAND,
    ask: "make it louder",                       // four tracks: genuinely unanswerable
    followUps: [{ say: "the drums — bring them up about 3 dB" }],
    goals: [
      { kind: "askedAtTurn", turn: 0 },
      { kind: "actedAtTurn", turn: 1 },
      { kind: "trackDelta", track: "Drums", field: "volumeDb", dir: "up", min: 1.5, max: 5 },
    ],
    par: 2,
  },
  {
    id: "conv-clarify-trim", category: "converse-clarify",
    setup: SEED_BAND,
    ask: "trim it",                              // which clip, which end, by how much
    followUps: [{ say: "the 808 clip — take a second off the end so it's 3 seconds long" }],
    goals: [
      { kind: "askedAtTurn", turn: 0 },
      { kind: "actedAtTurn", turn: 1 },
      { kind: "clipField", track: "808", clipIndex: 0, field: "length", min: 2.6, max: 3.4 },
    ],
    par: 2,
  },
  {
    // THREE turns, and the agent must stay hands-off across both of the first two.
    // This is the one that exercises `noCommandsBeforeTurn` for real: an agent that
    // half-guesses after the first clarification still fails, which is the correct
    // reading of "don't touch my session until you know what I mean".
    id: "conv-clarify-two-step", category: "converse-clarify",
    setup: SEED_BAND,
    ask: "can you clean this up",
    followUps: [
      { say: "the levels are all over the place" },
      { say: "just balance the 808 against the drums — pull the 808 down about 4 dB" },
    ],
    goals: [
      { kind: "askedAtTurn", turn: 0 },
      { kind: "noCommandsBeforeTurn", turn: 2 },
      { kind: "actedAtTurn", turn: 2 },
      { kind: "trackDelta", track: "808", field: "volumeDb", dir: "down", min: 2, max: 6 },
    ],
    par: 3,
  },

  // ── converse-correct: it acted, the user corrects it ────────────────────────
  {
    // The stacking trap. An agent that treats turn 1 as a NEW relative instruction
    // lands at -11; only one that reads "make it 3" as a correction of its own -8
    // ends at -3. Pure state check, so undo-then-reset and set-outright both pass.
    id: "conv-correct-too-much", category: "converse-correct",
    setup: SEED_BAND,
    ask: "drop the drums 8 dB",
    followUps: [{ say: "that's way too much — make it 3 dB down from where it started, not 8" }],
    goals: [
      { kind: "actedAtTurn", turn: 0 },
      { kind: "actedAtTurn", turn: 1 },
      { kind: "trackField", track: "Drums", field: "volumeDb", eq: -3, tol: 1 },
    ],
    par: 2,
  },
  {
    // Referent tracking: "the other one" is only resolvable from turn 0's own action.
    // Both halves are asserted — moving Keys up while leaving the 808 hot is the
    // failure this is built to catch (it looks like success if you only check Keys).
    id: "conv-correct-wrong-track", category: "converse-correct",
    setup: SEED_BAND,
    ask: "bring up the bass a few dB",
    followUps: [{ say: "no — I meant the Keys, not the 808. Put the 808 back to 0 and lift the Keys instead" }],
    goals: [
      { kind: "actedAtTurn", turn: 1 },
      { kind: "trackField", track: "808", field: "volumeDb", eq: 0, tol: 0.6 },
      { kind: "trackDelta", track: "Keys", field: "volumeDb", dir: "up", min: 1, max: 8 },
    ],
    par: 2,
  },
  {
    id: "conv-correct-undo", category: "converse-correct",
    setup: SEED_BAND,
    ask: "duplicate the keys clip",
    followUps: [{ say: "actually, undo that — I didn't want the copy" }],
    goals: [
      { kind: "actedAtTurn", turn: 0 },
      { kind: "actedAtTurn", turn: 1 },
      { kind: "clipCount", track: "Keys", delta: 0 },   // duplicated, then put back
    ],
    par: 2,
  },

  // ── converse-session: a real multi-turn build, graded on the end state ──────
  {
    // The Bass track and its empty clip are SEEDED, deliberately. Asking a
    // single-shot seat to create a track, add a clip to it and then add notes to
    // that clip in one reply is structurally impossible, not hard: the trackId and
    // clipId do not exist until the earlier commands run, so the later ones cannot
    // reference them. (The first draft did exactly this and failed identically on
    // every seat — the signature of an unsatisfiable task, not a difficult one.
    // It is the same shape the loop was built for; see mix-vocal-space.) Seeding
    // them keeps the final turn a pure add_note ×4, which is the musical judgment
    // this task is actually about.
    id: "conv-session-beat", category: "converse-session",
    setup: [
      ...SEED_EMPTY,
      { command: "create_track", args: { name: "Bass" }, capture: { TBASS: "trackId" } },
      { command: "add_midi_clip", args: { trackId: "${TBASS}", start: 0, length: 4 }, capture: { CBASS: "clipId" } },
    ],
    ask: "let's start a beat at 92 bpm",
    followUps: [
      { say: "make a drum track and give me a boom-bap pattern on it" },
      { say: "set the key to A minor" },
      { say: "now put a simple 4-note bassline in that key on the Bass track" },
    ],
    goals: [
      { kind: "tempo", eq: 92 },
      { kind: "cmdOk", name: "add_drum_pattern", min: 1 },
      { kind: "sessionKey", tonic: "A", mode: "minor" },
      { kind: "notesInKey", track: "Bass", tonic: "A", mode: "minor", minNotes: 3 },
    ],
    par: 4, maxSteps: 12, render: true,
  },
  {
    id: "conv-session-arrange", category: "converse-session",
    setup: SEED_BAND,
    ask: "map this out — intro, verse, hook",
    followUps: [
      { say: "the hook should start at bar 9 and run 8 bars" },
      { say: "now move the 808 clip to start at 4 seconds" },
    ],
    goals: [
      { kind: "sectionExists", name: "Hook" },
      { kind: "sectionExists", name: "Verse" },
      { kind: "clipStart", track: "808", clipIndex: 0, minSec: 3.8, maxSec: 4.2 },
    ],
    par: 3, maxSteps: 10,
  },
  {
    id: "conv-session-mix", category: "converse-session",
    setup: SEED_BAND,
    ask: "give the vocal some space",
    followUps: [
      { say: "yeah, a reverb return is fine — send the vocal to it" },
      { say: "and tuck the drums down a couple dB so the vocal sits on top" },
    ],
    goals: [
      { kind: "busCountDelta", delta: 1 },
      { kind: "sendExists", track: "Vocal" },
      { kind: "trackDelta", track: "Drums", field: "volumeDb", dir: "down", min: 1, max: 5 },
    ],
    par: 3, maxSteps: 10,
  },

  // ── converse-recover: the user reports damage the agent itself caused ───────
  {
    // Turn 0 leaves the 808 hot; turn 1 says so WITHOUT naming the fix. The failure
    // this catches is piling on (lifting everything else to compensate) instead of
    // reading its own change — netTrackLevelDelta sees fader and clip gain together,
    // so either honest fix passes and "turn everything else up" does not.
    id: "conv-recover-clipping", category: "converse-recover",
    setup: SEED_BAND,
    ask: "push the 808 way up, like 10 dB",
    followUps: [{ say: "whoa, that's clipping now — fix just the 808, leave everything else alone" }],
    goals: [
      { kind: "actedAtTurn", turn: 1 },
      // Back to roughly where it started — NOT "5 dB below the original", which is
      // what the first draft of this task demanded and nobody asked for. That draft
      // failed a run that correctly restored the level (Δ0.0) while passing nothing,
      // i.e. it was unsatisfiable in the direction of the right answer. Graded from
      // the pre-task baseline, so undo and re-set both land here.
      { kind: "trackField", track: "808", field: "volumeDb", eq: 0, tol: 3 },
      { kind: "trackField", track: "Drums", field: "volumeDb", eq: 0, tol: 0.6 },
    ],
    par: 2,
  },
  {
    id: "conv-recover-solo", category: "converse-recover",
    setup: SEED_BAND,
    ask: "solo the vocal so I can hear it on its own",
    followUps: [{ say: "ok I'm done checking — I can't hear anything else, put it back" }],
    goals: [
      { kind: "actedAtTurn", turn: 0 },
      { kind: "actedAtTurn", turn: 1 },
      { kind: "trackField", track: "Vocal", field: "solo", eq: false },
    ],
    par: 2,
  },
  {
    id: "conv-recover-tempo", category: "converse-recover",
    setup: SEED_BAND,
    ask: "speed it way up",
    followUps: [{ say: "too fast — put it back to 120" }],
    goals: [
      { kind: "actedAtTurn", turn: 1 },
      { kind: "tempo", eq: 120 },
    ],
    par: 2,
  },
];

/** Tasks that span several user turns (the `converse-*` categories). */
export const CONVERSATIONAL_TASKS: readonly AgentTask[] =
  AGENT_TASKS.filter((t) => (t.followUps?.length ?? 0) > 0);

/** The 34-task single-turn suite every scoreboard from 2026-07-18 onward measured.
 *
 *  Conversational tasks are OPT-IN (`--suite conversational|all`) rather than folded
 *  into the default run, and the reason is comparability, not tidiness: `success` is
 *  a percentage of whatever ran, so silently growing the suite would make every
 *  scoreboard recorded after that point incomparable to every one before it — while
 *  still LOOKING like the same metric. The two suites answer different questions and
 *  get reported as different numbers. */
export const SINGLE_TURN_TASKS: readonly AgentTask[] =
  AGENT_TASKS.filter((t) => (t.followUps?.length ?? 0) === 0);

export type SuiteName = "single" | "conversational" | "all";
export const suiteTasks = (suite: SuiteName): readonly AgentTask[] =>
  suite === "conversational" ? CONVERSATIONAL_TASKS : suite === "all" ? AGENT_TASKS : SINGLE_TURN_TASKS;

export function taskById(id: string): AgentTask {
  const t = AGENT_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no agent task "${id}"`);
  return t;
}
