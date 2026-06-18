// Golden suite for the simple-helper brain benchmark (scripts/brainBench.mts).
//
// Each case is a short, realistic request a user would make of Moshi-as-helper,
// paired with a DETERMINISTIC rubric (no LLM judge): which command(s) must appear,
// which fixture id they must target, or — for ambiguous/off-topic asks — that the
// model should defer with HUH and emit NO commands (the prompt's explicit rule).
//
// The fixture is a tiny, fixed session so id-grounding is checkable: a model that
// invents an id, picks the wrong track, or fabricates a command fails the rubric.

import type { Snapshot } from "../types";

export const FIXTURE: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    metronome: false,
    key: { tonic: "A", mode: "minor" },
    length: 32,
    editFile: "/tmp/bench.mosh",
  },
  tracks: [
    { id: "t-drums", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
      clips: [{ id: "c-loop", name: "loop", type: "wave", start: 0, length: 8, offset: 0, hasRenderLayer: false }] },
    { id: "t-bass", index: 1, name: "Bass", type: "audio", volumeDb: -3, mute: false, solo: false,
      clips: [] },
    { id: "t-keys", index: 2, name: "Keys", type: "audio", volumeDb: 0, mute: false, solo: false,
      clips: [{ id: "c-midi", name: "chords", type: "midi", start: 0, length: 16, offset: 0, hasRenderLayer: false }] },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
};

// All ids the model may legitimately reference. Any id-valued arg outside this set
// is an invented id → the command is rejected by the scorer.
export const FIXTURE_IDS = new Set<string>([
  ...FIXTURE.tracks.map((t) => t.id),
  ...FIXTURE.tracks.flatMap((t) => t.clips.map((c) => c.id)),
]);

export type BrainCase = {
  id: string;
  request: string;
  // Action cases: the command name(s) that MUST appear (order-independent). A
  // `ref` pins the fixture id the command must target (trackId or clipId arg).
  expect?: { command: string; ref?: string }[];
  // Ambiguous / off-topic: the model should defer (HUH/NUH) and emit NO commands.
  huh?: boolean;
};

export const CASES: BrainCase[] = [
  // ── single, unambiguous actions ───────────────────────────────────────────
  { id: "create-track",   request: "add a new track",                 expect: [{ command: "create_track" }] },
  { id: "rename-bass",    request: 'rename the Bass track to "Sub"',  expect: [{ command: "rename_track", ref: "t-bass" }] },
  { id: "mute-drums",     request: "mute the drums",                  expect: [{ command: "set_track_mute", ref: "t-drums" }] },
  { id: "solo-keys",      request: "solo the keys",                   expect: [{ command: "set_track_solo", ref: "t-keys" }] },
  { id: "louder-bass",    request: "turn the bass up a bit",          expect: [{ command: "set_track_volume", ref: "t-bass" }] },
  { id: "pan-drums",      request: "pan the drums hard left",         expect: [{ command: "set_track_pan", ref: "t-drums" }] },
  { id: "lower-master",   request: "bring the overall volume down",   expect: [{ command: "set_master_volume" }] },
  { id: "midi-on-keys",   request: "add a MIDI clip on the keys",     expect: [{ command: "add_midi_clip", ref: "t-keys" }] },
  { id: "delete-loop",    request: "delete the drum loop",            expect: [{ command: "remove_clip", ref: "c-loop" }] },
  { id: "tempo-90",       request: "set the tempo to 90",             expect: [{ command: "set_tempo" }] },
  { id: "timesig-34",     request: "change to 3/4 time",              expect: [{ command: "set_time_signature" }] },
  { id: "play",           request: "play it",                         expect: [{ command: "set_transport" }] },
  { id: "undo",           request: "undo that",                       expect: [{ command: "undo" }] },
  { id: "redo",           request: "redo it",                         expect: [{ command: "redo" }] },
  { id: "save",           request: "save the project",                expect: [{ command: "save" }] },

  // ── multi-command in one turn ─────────────────────────────────────────────
  { id: "mute-and-duck",  request: "mute the drums and bring the master down",
    expect: [{ command: "set_track_mute", ref: "t-drums" }, { command: "set_master_volume" }] },

  // ── ambiguous / off-topic → defer, no commands ────────────────────────────
  { id: "gibberish",      request: "asdkfj ghjk lqwe",                huh: true },
  { id: "off-topic",      request: "what's the weather like today?",  huh: true },
  { id: "too-vague",      request: "make it better",                  huh: true },
];
