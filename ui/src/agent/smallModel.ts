// Small Model Mode — a pruned command-schema + system-prompt arm for small local
// models (producer-pal-inspired). The full catalog is 81 commands / ~13k chars; a
// small model steering across it defers on fully-explicit asks (the two r4-cuda
// floor misses: assign_sample 0.333, load_drum_kit 0.333 — both deferral-class).
// This arm prunes the catalog to a core producer surface, simplifies the hottest
// descriptions, and replaces the "unclear → HUH" defer rule with an ACT-by-default
// pair — the intent-level lever PROGRAM_STAGE1 §P9 registers as the next move if
// deferrals survive r5.
//
// EVAL-ONLY for now (evalSft --rules pruned|pruned-examples): like fewshot.ts,
// production adoption only after the A/B wins (docs/bench/SMALL_MODEL_MODE_2026-07.md).
//
// Invariants (pinned in smallModel.test.ts):
// - keep-list ⊇ every command that appears as gold in the frozen eval surfaces
//   (evalA 210 + frozen300) — otherwise the A/B is broken by construction;
// - arg specs are reused BY REFERENCE from AGENT_COMMANDS (desc-only overrides),
//   so the pruned prompt can never drift from validateCommand;
// - same line format as commandCatalogPrompt(), so normalizeCommand's
//   function-call-string recovery behaves identically across arms.

import { AGENT_COMMANDS, type AgentCommand } from "./commands";
import { WORKED_EXAMPLES } from "./fewshot";
import { MUSICAL_TIME_RULE } from "./musicalTime";

// 51 of 81: the 41 eval-gold commands + 10 product-core keeps (clip editing,
// load_builtin, quantize, accept_render). Dropped (30): annotation edits, clip
// cosmetics (rename/gain/mute), take management, plugin micro-management
// (load_plugin/params/reorder/editor), render-lifecycle micro-commands, and the
// lyric-editing sub-surface — none appear as eval gold.
export const SMALL_MODEL_KEEP: readonly string[] = [
  // tracks
  "create_track", "rename_track", "remove_track",
  // sections
  "create_section", "rename_section", "move_section", "remove_section",
  // annotations
  "create_annotation",
  // clips
  "add_test_tone_clip", "import_clip", "add_midi_clip", "move_clip", "trim_clip",
  "split_clip", "duplicate_clip", "remove_clip",
  // sketch
  "sketch_beatbox",
  // MIDI notes
  "add_note", "remove_note", "set_note", "quantize_notes",
  // transport & timing
  "set_tempo", "set_time_signature", "set_metronome", "set_key", "set_transport",
  // recording
  "arm_track", "stop_recording", "set_input_monitor",
  // history
  "undo", "redo", "save",
  // mixer
  "set_track_volume", "set_track_pan", "set_track_mute", "set_track_solo",
  "set_master_volume", "set_master_pan",
  // plugins / sampler
  "load_builtin", "set_track_type", "load_drum_kit", "assign_sample",
  "bypass_plugin", "remove_plugin",
  // generative
  "create_render_layer", "set_render_param", "render_layer", "accept_render", "reject_render",
  // lyrics
  "suggest_next_line", "build_skeleton_from_clip",
];

// desc-ONLY overrides (args untouched — they must stay identical to validation).
// The first two target the measured deferral families head-on; the last two are
// mechanical trims of the longest kept descriptions.
const DESC_OVERRIDES: Record<string, string> = {
  assign_sample:
    "Map an audio file onto a track's sampler at a MIDI note — a named track + file + note is a complete ask, act on it (mode 'drum' = one-shot pad, default; 'melodic' = pitched across the keyboard, note = root)",
  load_drum_kit:
    "Load the built-in drum kit onto a track's sampler — to make an existing track a drum track, pair with set_track_type",
  create_render_layer:
    "Attach a generative re-imagine layer to any clip, optionally scoped by regionStart/regionEnd in seconds",
  set_render_param:
    "Set a render-layer parameter (prompt/noise/seed, transform target/strength, coverage)",
};

const KEEP = new Set(SMALL_MODEL_KEEP);

export const SMALL_MODEL_COMMANDS: AgentCommand[] = AGENT_COMMANDS
  .filter((c) => KEEP.has(c.command))
  .map((c) => (DESC_OVERRIDES[c.command] ? { ...c, desc: DESC_OVERRIDES[c.command] } : c));

/** The pruned catalog rendered for the LLM system prompt — byte-identical line
 *  format to commandCatalogPrompt(), only the content differs. */
export function smallModelCatalogPrompt(): string {
  return SMALL_MODEL_COMMANDS.map((c) => {
    const a = c.args.map((x) => `${x.name}${x.required ? "" : "?"}`).join(", ");
    return `- ${c.command}(${a}) — ${c.desc}`;
  }).join("\n");
}

// Fewer, shorter rules. The load-bearing change vs DEFAULT_RULES is the defer
// pair (ACT by default / HUH only on a genuinely missing or ambiguous value) —
// DEFAULT_RULES' "unclear or needs info you don't have → HUH" reads, to a small
// model, as license to defer on explicit asks.
export const SMALL_MODEL_RULES = [
  "Rules:",
  '- Use the REAL ids from the session for trackId/clipId, always as a JSON string — "trackId": "17", never the bare number 17.',
  MUSICAL_TIME_RULE,
  "- One request can produce several commands (they apply together as one undoable change).",
  "- ACT by default. If the user names the target and the values (e.g. a track + a file + a note), emit the command — do not ask.",
  "- Set intent HUH and ask in `say` ONLY when a required value is missing or two session objects match the request equally.",
  "- To re-imagine part of the song: create_render_layer on the clip with regionStart/regionEnd in seconds (beats × 60 ÷ tempo), then render_layer.",
  "- After edits use intent ACK_GOT_IT (or DONE). Stay in character — never mention JSON, commands, models, or AI.",
].join("\n");

export const SMALL_MODEL_RULES_WITH_EXAMPLES = `${SMALL_MODEL_RULES}\n${WORKED_EXAMPLES}`;
