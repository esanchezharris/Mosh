// SETUP profiles + task-gen hints for the execution-filtered synthesis driver
// (training program Stage 1.3/1.4; pre-registered in docs/bench/PROGRAM_STAGE1_2026-07.md).
//
// Calibration (2026-07-03, cal-01..08) showed the zero-acceptance families all
// share one cause: the fixed session lacked the prerequisite state (no notes, no
// wave clip, no plugin, no annotation, no lyric sheet, no render layer) or the
// request needed a real on-disk file. Profiles fix the former; the driver's
// asset WAVs + per-command task-gen hints fix the latter.
//
// PRE-REGISTERED ANTI-GAMING RULE (§P4): the `eval` profile shares NO entity
// names with any training profile — eval-v2 §A items are synthesized against it
// and must not be answerable by memorizing training-session entities. The golden
// test pins this disjointness.

export type SynthCmd = {
  command: string;
  args: Record<string, unknown>;
  capture?: Record<string, string>;
};

const BASIC: SynthCmd[] = [
  { command: "create_track", args: { name: "Drums", type: "drum" } },
  { command: "create_track", args: { name: "Piano" }, capture: { TPIANO: "trackId" } },
  { command: "create_track", args: { name: "Bass" }, capture: { TBASS: "trackId" } },
  { command: "create_track", args: { name: "Vocal" }, capture: { TVOCAL: "trackId" } },
  { command: "add_midi_clip", args: { trackId: "${TPIANO}", start: 0, length: 4 }, capture: { CPIANO: "clipId" } },
  { command: "create_section", args: { name: "Verse", startBeat: 0, endBeat: 16 } },
];

// State-only enrichment: notes to edit, a wave clip (clip-gain etc.), a loaded
// builtin (plugin-slot commands), an annotation, a lyric sheet with two lines.
// Deliberately NO service-spawning commands — gradeApply replays the profile for
// EVERY proposal, so a service spawn here would tax the whole bulk run.
const RICH: SynthCmd[] = [
  ...BASIC,
  { command: "add_note", args: { clipId: "${CPIANO}", pitch: 60, start: 0, length: 0.5, velocity: 96 } },
  { command: "add_note", args: { clipId: "${CPIANO}", pitch: 64, start: 1, length: 0.5, velocity: 80 } },
  { command: "add_note", args: { clipId: "${CPIANO}", pitch: 67, start: 2, length: 0.5, velocity: 100 } },
  { command: "add_note", args: { clipId: "${CPIANO}", pitch: 72, start: 3, length: 0.5, velocity: 70 } },
  { command: "add_test_tone_clip", args: { trackId: "${TBASS}", seconds: 2, freq: 110 }, capture: { CBASS: "clipId" } },
  { command: "load_builtin", args: { trackId: "${TPIANO}", type: "reverb" } },
  { command: "create_annotation", args: { text: "check the low end here", beat: 8 } },
  { command: "create_lyric_sheet", args: { trackId: "${TVOCAL}", topic: "comeback", mood: "defiant" } },
  { command: "set_lyric_line", args: { trackId: "${TVOCAL}", lineIndex: 0, text: "counted out but I came back louder" } },
  { command: "set_lyric_line", args: { trackId: "${TVOCAL}", lineIndex: 1, seedText: "___ ___ in the cold night ___" } },
];

// Render-layer state without running a render (set_render_param, bypass_layer,
// remove_render_layer, render_layer itself, freeze_layer).
const RENDERS: SynthCmd[] = [
  ...RICH,
  { command: "create_render_layer", args: { clipId: "${CBASS}" } },
];

// Completed render (FakeAdapter — MOSH_ENABLE_SA3=0 in the harness env — so
// wait:true returns in ms): accept_render, reject_render, bounce_layer_to_clip.
const RENDERED: SynthCmd[] = [
  ...RENDERS,
  { command: "render_layer", args: { clipId: "${CBASS}", wait: true } },
];

// Lyric proposals present (accept_lyric_proposal). complete_lyrics spawns the
// lyric service (fake backend headless — deterministic), hence its own profile.
const PROPOSALS: SynthCmd[] = [
  ...RICH,
  { command: "complete_lyrics", args: { trackId: "${TVOCAL}", wait: true } },
];

// Eval-only profile for frozen-eval-v2 §A synthesis (§P4): different track/clip/
// section/annotation names, different structure, different lyric content. Never
// used for training rows.
const EVAL: SynthCmd[] = [
  { command: "create_track", args: { name: "Kick", type: "drum" } },
  { command: "create_track", args: { name: "Keys" }, capture: { TKEYS: "trackId" } },
  { command: "create_track", args: { name: "Sub" }, capture: { TSUB: "trackId" } },
  { command: "create_track", args: { name: "Lead" }, capture: { TLEAD: "trackId" } },
  { command: "add_midi_clip", args: { trackId: "${TKEYS}", start: 4, length: 8 }, capture: { CKEYS: "clipId" } },
  { command: "add_note", args: { clipId: "${CKEYS}", pitch: 55, start: 0, length: 1, velocity: 90 } },
  { command: "add_note", args: { clipId: "${CKEYS}", pitch: 58, start: 2, length: 1, velocity: 110 } },
  { command: "add_note", args: { clipId: "${CKEYS}", pitch: 62, start: 4, length: 0.5, velocity: 64 } },
  { command: "add_test_tone_clip", args: { trackId: "${TSUB}", seconds: 3, freq: 55 }, capture: { CSUB: "clipId" } },
  { command: "load_builtin", args: { trackId: "${TKEYS}", type: "delay" } },
  { command: "create_section", args: { name: "Drop", startBeat: 0, endBeat: 32 } },
  { command: "create_annotation", args: { text: "tighten this transition", beat: 16 } },
  { command: "create_lyric_sheet", args: { trackId: "${TLEAD}", topic: "midnight drive", mood: "wistful" } },
  { command: "set_lyric_line", args: { trackId: "${TLEAD}", lineIndex: 0, text: "taillights paint the highway red" } },
  { command: "create_render_layer", args: { clipId: "${CSUB}" } },
  { command: "render_layer", args: { clipId: "${CSUB}", wait: true } },
];

export const SETUP_PROFILES: Record<string, SynthCmd[]> = {
  basic: BASIC,
  rich: RICH,
  renders: RENDERS,
  rendered: RENDERED,
  proposals: PROPOSALS,
  eval: EVAL,
};

export const TRAINING_PROFILE_NAMES = ["basic", "rich", "renders", "rendered", "proposals"] as const;

// Per-command task-gen hints. These shape the INVENTED USER REQUESTS only (the
// task-gen call) — they never reach the answering model or the kept row, so
// there is no leakage into training beyond a realistic user request.
export function taskgenHint(command: string, assets: { loop: string; kick: string; beatbox: string }): string | undefined {
  switch (command) {
    case "import_clip":
      return `The user's audio files on disk (these really exist — use these exact paths): ${assets.loop}, ${assets.kick}.`;
    case "assign_sample":
      return `The user's audio files on disk (these really exist — use these exact paths): ${assets.kick}, ${assets.loop}. Requests map a file onto a drum pad / sampler note.`;
    case "sketch_beatbox":
      return `The user recorded a beatbox take at ${assets.beatbox} (this file really exists — use this exact path), around 90 BPM.`;
    case "load_builtin":
      return `Built-in effects/instruments users ask for by name: 4OSC (synth), Reverb, Delay, EQ, Mosh AutoTune, Mosh OTT, Mosh X-FDBK.`;
    case "set_note":
    case "remove_note":
      return `The Piano clip contains 4 MIDI notes (users refer to them by position: first note, last note, the third one…).`;
    case "quantize_notes":
      return `Users phrase the grid musically: "to 16ths", "to eighth notes", "snap it to the grid".`;
    case "load_plugin":
      return `Users name a scanned third-party VST3 they know is installed (e.g. Serum, OTT, Vital).`;
    default:
      return undefined;
  }
}

// Negative-mode task-gen system prompt (§P3): absent-entity pairs with a short
// clarifying ask and an optional grounded twin.
export const NEG_TASKGEN_SYS =
  "You invent training pairs for a DAW assistant's grounding behavior. Given the live session and one " +
  "command spec, write PAIRS: 'absent' = a realistic user request that references a track/clip/section/" +
  "file that does NOT exist in this session (the correct behavior is to ask, not act — never mention any " +
  "entity that IS in the session); 'ask' = the assistant's short clarifying question (12 words max); " +
  "'grounded' = the same request re-targeted at an entity that DOES exist in the session. Never mention " +
  'command names or APIs. Respond ONLY as JSON: {"pairs":[{"absent":"...","ask":"...","grounded":"..."}]}.';
