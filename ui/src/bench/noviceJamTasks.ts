// MoshAgentBench — the P1 "novice-jam" probe suite. Same AgentTask shape as
// agentTasks.ts, same GoalCheck predicates, same seeds — the ONLY thing that
// changes here is the phrasing: 25 asks written the way someone who does not
// know DAW vocabulary would actually talk in a jam session ("slap harder",
// "somewhere to sing", "go back") instead of the expert phrasing in
// agentTasks.ts ("bring the drums down 3dB", "undo that last change").
//
// This is the probe that decides whether the graduated-trust lane defaults ON:
// the mechanical acceptability rubric (./acceptability.ts) grades each run,
// and the owner's real run against a live brain is the actual P1 verdict —
// see docs/agent-bench/ for how to run it. This file is data + goals only, no
// harness changes beyond --suite in scripts/agentBench.mts.
//
// 4 tasks are DELIBERATELY ambiguous/taste-only ("make it sound professional",
// "mix this properly", "make it hit different", "it feels empty in the
// middle") — none of them name an instrument, a direction, or a target, so
// there is no honest action to take. Their goal is the existing `{kind:
// "defer"}` predicate: success = the model asked instead of guessing. A model
// that always complies (never defers) fails all four — proven in
// acceptability.test.ts by running the real grading pipeline against a
// scripted "always comply" brain.

import { SEED_BAND, SEED_EMPTY, type AgentTask } from "./agentTasks";

export const NOVICE_JAM_TASKS: readonly AgentTask[] = [
  // ── mix ─────────────────────────────────────────────────────────────────────
  {
    id: "nj-drums-slap", category: "mix",
    setup: SEED_BAND,
    ask: "make the drums slap harder",
    goals: [{ kind: "trackDelta", track: "Drums", field: "volumeDb", dir: "up", min: 1, max: 8 }],
    par: 1,
  },
  {
    id: "nj-vocal-too-quiet", category: "mix",
    setup: SEED_BAND,
    ask: "the singing is too quiet, bring it up a little",
    goals: [{ kind: "trackDelta", track: "Vocal", field: "volumeDb", dir: "up", min: 1, max: 8 }],
    par: 1,
  },
  {
    id: "nj-guitar-echo", category: "mix",
    setup: [...SEED_BAND, { command: "create_track", args: { name: "Guitar" }, capture: { TGTR: "trackId" } }],
    ask: "put that spacey echo on the guitar",
    goals: [{ kind: "pluginOnTrack", track: "Guitar", nameIncludes: "delay" }],
    par: 1,
  },
  {
    id: "nj-reverb-vocal-room", category: "mix",
    setup: SEED_BAND,
    ask: "the vocals feel dry, put them in a room or something",
    goals: [{ kind: "busCountDelta", delta: 1 }, { kind: "sendExists", track: "Vocal" }],
    par: 2,
  },
  {
    id: "nj-clear-solo-mute", category: "mix",
    setup: [
      ...SEED_BAND,
      { command: "set_track_mute", args: { trackId: "${TVOX}", mute: true } },
      { command: "set_track_solo", args: { trackId: "${T808}", solo: true } },
    ],
    ask: "why can't i hear everything — something's muted or soloed, fix it",
    goals: [
      { kind: "trackField", track: "Vocal", field: "mute", eq: false },
      { kind: "trackField", track: "808", field: "solo", eq: false },
    ],
    par: 1,
  },

  // ── arrange ─────────────────────────────────────────────────────────────────
  {
    id: "nj-somewhere-to-sing", category: "arrange",
    setup: SEED_EMPTY,
    ask: "give me somewhere to sing",
    goals: [{ kind: "trackCount", delta: 1 }],
    par: 1,
  },
  {
    id: "nj-start-over", category: "arrange",
    setup: [...SEED_BAND, { command: "set_transport", args: { position: 10 } }],
    ask: "start it over from the top",
    goals: [{ kind: "transportPos", minSec: 0, maxSec: 0.5 }],
    par: 1,
  },
  {
    id: "nj-make-faster", category: "arrange",
    setup: SEED_EMPTY,
    ask: "make it faster",
    goals: [{ kind: "tempo", min: 121, max: 170 }],
    par: 1,
  },
  {
    id: "nj-fill-the-gap", category: "arrange",
    setup: [
      ...SEED_BAND,
      { command: "add_test_tone_clip", args: { trackId: "${TDRUM}", seconds: 4 }, capture: { CD2: "clipId" } },
      { command: "move_clip", args: { clipId: "${CD2}", start: 8 } },
    ],
    ask: "there's a big silent gap in the drums around 4 to 8 seconds, close it up so the next part comes right after",
    goals: [{ kind: "cmdOk", name: "delete_time_range", min: 1 }, { kind: "clipStart", track: "Drums", clipIndex: 1, minSec: 3.9, maxSec: 4.1 }],
    par: 1,
  },
  {
    id: "nj-repeat-that-part", category: "arrange",
    setup: SEED_BAND,
    ask: "the 808 part is good, just repeat it again right after itself",
    goals: [{ kind: "clipCount", track: "808", delta: 1 }, { kind: "cmdOk", name: "duplicate_clip", min: 1 }],
    par: 1,
  },

  // ── compose: drums ──────────────────────────────────────────────────────────
  {
    id: "nj-drums-groove", category: "compose-drums",
    setup: SEED_EMPTY,
    ask: "gimme a beat, something with some bounce to it",
    goals: [{ kind: "trackCount", delta: 1 }, { kind: "cmdOk", name: "add_drum_pattern", min: 1 }, { kind: "midiNoteCount", track: "Drums", min: 8 }],
    par: 1, render: true,
  },
  {
    id: "nj-hats-more", category: "compose-drums",
    setup: SEED_BAND, // "Drums" here is a WAVE track — a drum pattern needs a new drum track
    ask: "the drums feel flat, add some hats or something on top",
    goals: [{ kind: "cmdOk", name: "add_drum_pattern", min: 1 }, { kind: "trackCount", delta: 1 }],
    par: 1,
  },

  // ── compose: melody ─────────────────────────────────────────────────────────
  {
    id: "nj-bassline-simple", category: "compose-melody",
    setup: [
      ...SEED_BAND,
      { command: "set_key", args: { tonic: "A", mode: "minor" } },
      { command: "add_midi_clip", args: { trackId: "${T808}", start: 0, length: 4 }, capture: { C808M: "clipId" } },
    ],
    ask: "throw a simple bassline under it, keep it in the key we're in",
    goals: [{ kind: "cmdOk", name: "add_note", min: 3 }, { kind: "notesInKey", track: "808", tonic: "A", mode: "minor", minNotes: 3 }],
    par: 1,
  },
  {
    id: "nj-melody-idea", category: "compose-melody",
    setup: [...SEED_BAND, { command: "set_key", args: { tonic: "C", mode: "major" } }],
    ask: "give the keys a little melody idea, nothing fancy, keep it in key",
    goals: [{ kind: "cmdOk", name: "add_note", min: 3 }, { kind: "notesInKey", track: "Keys", tonic: "C", mode: "major", minNotes: 3 }],
    par: 1,
  },

  // ── master ──────────────────────────────────────────────────────────────────
  {
    id: "nj-glue-it-together", category: "master",
    setup: SEED_BAND,
    ask: "can you glue this together so it sounds like one thing",
    goals: [{ kind: "masterChainContains", nameIncludes: "comp" }],
    par: 1, render: true,
  },
  {
    id: "nj-master-too-loud", category: "master",
    setup: SEED_BAND,
    ask: "the whole thing is blasting my ears, turn it down a bit",
    goals: [{ kind: "masterDelta", field: "volumeDb", dir: "down", min: 1, max: 6 }],
    par: 1,
  },

  // ── generative (fake adapter on both substrates) ────────────────────────────
  {
    id: "nj-weird-ai-flavor", category: "generative",
    setup: SEED_BAND,
    ask: "run this drum loop through one of those AI filters, give it some character",
    goals: [{ kind: "cmdOkAny", names: ["compile_render", "create_render_layer"], min: 1 }],
    par: 1, needsWaitMs: 400,
  },

  // ── lyrics ──────────────────────────────────────────────────────────────────
  {
    id: "nj-write-some-words", category: "lyrics",
    setup: SEED_BAND,
    ask: "help me start some lyrics for the hook, something about missing someone",
    goals: [{ kind: "cmdOk", name: "create_lyric_sheet", min: 1 }],
    par: 1,
  },
  {
    id: "nj-first-line-lyrics", category: "lyrics",
    setup: [...SEED_BAND, { command: "create_lyric_sheet", args: { trackId: "${TVOX}" } }],
    ask: "put 'nobody said forever' as the opening line",
    goals: [{ kind: "cmdOk", name: "set_lyric_line", min: 1 }],
    par: 1,
  },

  // ── repair ──────────────────────────────────────────────────────────────────
  {
    id: "nj-808-too-hot", category: "repair",
    setup: [
      ...SEED_BAND,
      { command: "set_track_volume", args: { trackId: "${T808}", db: 9 } },
      { command: "set_clip_gain", args: { clipId: "${C808}", gainDb: 12 } },
    ],
    ask: "the 808 is way too hot, it's peaking — fix it",
    goals: [
      { kind: "netTrackLevelDelta", track: "808", dir: "down", minDb: 6 },
      { kind: "trackField", track: "808", field: "mute", eq: false }, // muting is not a fix
    ],
    par: 1, render: true,
  },
  {
    id: "nj-undo-hate", category: "repair",
    setup: [...SEED_BAND, { command: "set_tempo", args: { bpm: 174 } }],
    ask: "i hate what i just did, go back",
    goals: [{ kind: "tempo", eq: 120 }, { kind: "cmdOk", name: "undo", min: 1 }],
    par: 1,
  },

  // ── ambiguous (must genuinely defer — taste-only, no honest action) ────────
  { id: "nj-amb-professional", category: "ambiguous", setup: SEED_BAND, ask: "make it sound professional", goals: [{ kind: "defer" }], par: 0, ambiguous: true },
  { id: "nj-amb-mix-properly", category: "ambiguous", setup: SEED_BAND, ask: "mix this properly", goals: [{ kind: "defer" }], par: 0, ambiguous: true },
  { id: "nj-amb-hit-different", category: "ambiguous", setup: SEED_BAND, ask: "make it hit different", goals: [{ kind: "defer" }], par: 0, ambiguous: true },
  { id: "nj-amb-empty-middle", category: "ambiguous", setup: SEED_BAND, ask: "it feels empty in the middle", goals: [{ kind: "defer" }], par: 0, ambiguous: true },
];

export function noviceJamTaskById(id: string): AgentTask {
  const t = NOVICE_JAM_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no novice-jam task "${id}"`);
  return t;
}
