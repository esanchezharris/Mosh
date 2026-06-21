// The curated tool catalog Moshi's brain is allowed to call. Phase 1 deliberately
// exposes a high-value, low-blast-radius subset of the ~93 MoshOps commands — no
// project IO, device settings, scans, or anything that could lose the user's work.
// Each entry feeds two consumers: (1) the LLM system prompt (so the brain knows
// what it can do), and (2) client-side validation, so a malformed or unknown
// command is rejected BEFORE it ever reaches the command seam.

export type ArgType = "string" | "number" | "boolean";
export type ArgSpec = { name: string; type: ArgType; required?: boolean; desc?: string };
export type AgentCommand = { command: string; desc: string; args: ArgSpec[] };

const S = (name: string, required = true, desc?: string): ArgSpec => ({ name, type: "string", required, desc });
const N = (name: string, required = true, desc?: string): ArgSpec => ({ name, type: "number", required, desc });
const B = (name: string, required = true, desc?: string): ArgSpec => ({ name, type: "boolean", required, desc });

export const AGENT_COMMANDS: AgentCommand[] = [
  // ── tracks ──────────────────────────────────────────────────────────────
  { command: "create_track", desc: "Add a new track — type 'drum' loads a sampler + drum kit so beats are audible immediately", args: [S("name", false, "track name"), S("type", false, '"audio" (default) | "drum"')] },
  { command: "rename_track", desc: "Rename a track", args: [S("trackId"), S("name")] },
  { command: "remove_track", desc: "Delete a track and its clips", args: [S("trackId")] },

  // ── clips ───────────────────────────────────────────────────────────────
  { command: "add_test_tone_clip", desc: "Drop a test-tone clip on a track (lands at 0)", args: [S("trackId", false), N("seconds", false, "duration in seconds"), N("freq", false, "Hz")] },
  { command: "add_midi_clip", desc: "Add an empty MIDI clip", args: [S("trackId"), N("start", false, "seconds"), N("length", false, "seconds")] },
  { command: "move_clip", desc: "Move a clip to a new start time (and optionally another track)", args: [S("clipId"), S("trackId", false), N("start", true, "seconds")] },
  { command: "trim_clip", desc: "Set a clip's start and length", args: [S("clipId"), N("start"), N("length")] },
  { command: "split_clip", desc: "Split a clip at a time position", args: [S("clipId"), N("time", true, "seconds")] },
  { command: "duplicate_clip", desc: "Duplicate a clip", args: [S("clipId")] },
  { command: "remove_clip", desc: "Delete a clip", args: [S("clipId")] },
  { command: "rename_clip", desc: "Rename a clip", args: [S("clipId"), S("name")] },
  { command: "set_clip_gain", desc: "Set a clip's gain in dB", args: [S("clipId"), N("gainDb")] },
  { command: "set_clip_mute", desc: "Mute/unmute a clip", args: [S("clipId"), B("mute")] },

  // ── embodied capture (Sketch, Phase 0) ───────────────────────────────────
  { command: "sketch_beatbox", desc: "Transduce a recorded beatbox WAV into an editable drum clip at a known BPM (kick/snare/hat on a 16th grid)", args: [S("file", true, "path to the beatbox WAV"), N("bpm", true, "known tempo"), N("bars", false, "loop length, 1-2 bars")] },

  // ── MIDI notes ──────────────────────────────────────────────────────────
  { command: "add_note", desc: "Add a MIDI note (pitch 0-127) to a MIDI clip", args: [S("clipId"), N("pitch"), N("start", true, "beats"), N("length", true, "beats"), N("velocity", false, "0-127")] },
  { command: "remove_note", desc: "Remove a MIDI note by index", args: [S("clipId"), N("noteIndex")] },
  { command: "set_note", desc: "Edit a MIDI note's pitch/start/length/velocity", args: [S("clipId"), N("noteIndex"), N("pitch", false), N("start", false), N("length", false), N("velocity", false)] },
  { command: "quantize_notes", desc: "Quantize a MIDI clip's notes to a grid", args: [S("clipId"), N("division", false, "beats: 1=1/4, 0.5=1/8, 0.25=1/16"), N("strength", false, "0-1")] },

  // ── transport & timing ──────────────────────────────────────────────────
  { command: "set_tempo", desc: "Set the project tempo in BPM", args: [N("bpm")] },
  { command: "set_time_signature", desc: "Set the time signature", args: [N("numerator"), N("denominator")] },
  { command: "set_metronome", desc: "Toggle the metronome click", args: [B("enabled")] },
  { command: "set_key", desc: "Set the project musical key", args: [S("tonic", false, "C, C#, D … B"), S("mode", false, "major | minor | dorian | mixolydian | pentatonic | chromatic")] },
  { command: "set_transport", desc: "Transport: play/stop/record/seek", args: [S("action", false, '"play"|"toggle"|"stop"|"record"|"to_start"|"to_end"'), B("loop", false), N("position", false, "seconds")] },

  // ── recording / takes ─────────────────────────────────────────────────────
  { command: "arm_track", desc: "Arm/disarm a track's input for recording", args: [S("trackId"), B("armed")] },
  { command: "stop_recording", desc: "Stop recording and land the take", args: [B("discardRecordings", false)] },
  { command: "set_input_monitor", desc: "Set a track's input monitoring", args: [S("trackId"), S("mode", false, '"off"|"automatic"|"on"')] },
  { command: "list_takes", desc: "List the take lanes on a clip", args: [S("clipId")] },
  { command: "set_current_take", desc: "Select which take lane is active", args: [S("clipId"), N("takeIndex")] },
  { command: "keep_take", desc: "Keep the current take lane, remove the rest", args: [S("clipId")] },

  // ── history / session ─────────────────────────────────────────────────────
  { command: "undo", desc: "Undo the last change", args: [] },
  { command: "redo", desc: "Redo the last undone change", args: [] },
  { command: "save", desc: "Save the session to disk", args: [] },

  // ── mixer ───────────────────────────────────────────────────────────────
  { command: "set_track_volume", desc: "Set a track's volume in dB", args: [S("trackId"), N("db")] },
  { command: "set_track_pan", desc: "Set a track's pan (-1 left … 1 right)", args: [S("trackId"), N("pan")] },
  { command: "set_track_mute", desc: "Mute/unmute a track", args: [S("trackId"), B("mute")] },
  { command: "set_track_solo", desc: "Solo/unsolo a track", args: [S("trackId"), B("solo")] },
  { command: "set_master_volume", desc: "Set the master volume in dB", args: [N("db")] },
  { command: "set_master_pan", desc: "Set the master pan (-1 left … 1 right)", args: [N("pan")] },

  // ── plugins ─────────────────────────────────────────────────────────────
  { command: "load_builtin", desc: "Add a built-in effect/instrument to a track (type from list_builtins)", args: [S("trackId"), N("index", false, "chain position"), S("type")] },
  { command: "set_track_type", desc: "Set a track's type — 'drum' loads the working sampler + drum kit so its MIDI notes are audible", args: [S("trackId"), S("type", true, '"audio" | "drum"')] },
  { command: "load_drum_kit", desc: "Load the built-in drum kit onto a track's sampler (kick/snare/clap/hats/toms/crash)", args: [S("trackId")] },
  { command: "assign_sample", desc: "Map an audio file to one drum pad/note on a track's sampler (replaces that pad)", args: [S("trackId"), N("note", true, "MIDI pitch 0-127 of the pad"), S("file", true, "audio file path"), S("name", false, "pad label"), N("gainDb", false)] },
  { command: "load_plugin", desc: "Add a scanned VST3/AU plugin to a track (pluginId from list_plugins)", args: [S("trackId"), S("pluginId"), N("index", false, "chain position")] },
  { command: "set_plugin_param", desc: "Set a plugin parameter (0-1) by chain index + param index", args: [S("trackId"), N("index"), N("paramIndex"), N("value", true, "0-1")] },
  { command: "bypass_plugin", desc: "Bypass/enable a plugin in a track's chain", args: [S("trackId"), N("index"), B("bypassed")] },
  { command: "reorder_plugin", desc: "Move a plugin to a new chain position", args: [S("trackId"), N("index"), N("toIndex")] },
  { command: "open_plugin_editor", desc: "Pop out a plugin's native editor window", args: [S("trackId"), N("index")] },
  { command: "remove_plugin", desc: "Remove a plugin from a track's chain", args: [S("trackId"), N("index")] },

  // ── neural (Tier-A) ─────────────────────────────────────────────────────
  { command: "add_neural_insert", desc: "Add the real-time neural insert to a track", args: [S("trackId"), N("index", false)] },
  { command: "set_neural_param", desc: "Set a neural insert param (0-100, ASTD-clamped) by chain index", args: [S("trackId"), N("index", true, "chain position of the neural insert"), S("paramId", true, '"drive" | "tone" | "mix"'), N("value", true, "0-100")] },
  { command: "set_neural_lab_mode", desc: "Unlock the raw (Lab) range on a neural insert", args: [S("trackId"), N("index"), B("on")] },
  { command: "reset_neural", desc: "Reset a neural insert's model state", args: [S("trackId"), N("index")] },

  // ── generative (Tier-B) ─────────────────────────────────────────────────
  { command: "create_render_layer", desc: "Attach a generative re-imagine layer to a wave clip", args: [S("clipId"), S("adapter", false)] },
  { command: "set_render_param", desc: "Set a render-layer parameter (prompt/noise/seed)", args: [S("clipId"), S("prompt", false), N("nl", false, "noise level 0-1"), N("seed", false)] },
  { command: "render_layer", desc: "Run the generative render on a clip's layer", args: [S("clipId")] },
  { command: "accept_render", desc: "Accept a finished render (lands it as a clip)", args: [S("clipId")] },
  { command: "reject_render", desc: "Reject a render", args: [S("clipId")] },
  { command: "bypass_layer", desc: "Bypass/enable a clip's render layer", args: [S("clipId"), B("bypassed")] },
  { command: "freeze_layer", desc: "Freeze a clip's render layer (commit the rendered audio)", args: [S("clipId")] },
  { command: "bounce_layer_to_clip", desc: "Bounce a render layer down to a plain clip", args: [S("clipId")] },
  { command: "remove_render_layer", desc: "Remove a clip's render layer", args: [S("clipId")] },
];

export const AGENT_COMMAND_MAP = new Map(AGENT_COMMANDS.map((c) => [c.command, c]));

/** Validate a planned command against the curated catalog. Returns an error
 *  string, or null if valid. Unknown commands and bad arg types are rejected
 *  here, before anything reaches the command seam. */
export function validateCommand(command: string, args: Record<string, unknown>): string | null {
  const spec = AGENT_COMMAND_MAP.get(command);
  if (!spec) return `not an allowed command: "${command}"`;
  for (const a of spec.args) {
    const v = args[a.name];
    if (v === undefined || v === null) {
      if (a.required) return `${command}: missing required "${a.name}"`;
      continue;
    }
    if (a.type === "number" && typeof v !== "number") return `${command}: "${a.name}" must be a number`;
    if (a.type === "boolean" && typeof v !== "boolean") return `${command}: "${a.name}" must be true/false`;
    if (a.type === "string" && typeof v !== "string") return `${command}: "${a.name}" must be a string`;
  }
  return null;
}

/** The catalog rendered for the LLM system prompt. */
export function commandCatalogPrompt(): string {
  return AGENT_COMMANDS.map((c) => {
    const a = c.args.map((x) => `${x.name}${x.required ? "" : "?"}`).join(", ");
    return `- ${c.command}(${a}) — ${c.desc}`;
  }).join("\n");
}

/** A short, human-readable summary of an executed command, for Monster changes. */
export function describeCommand(command: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string | number | boolean | undefined>;
  switch (command) {
    case "create_track": return `Added ${a.type === "drum" ? "drum " : ""}track${a.name ? ` "${a.name}"` : ""}`;
    case "rename_track": return `Renamed track to "${a.name}"`;
    case "remove_track": return `Removed a track`;
    case "add_test_tone_clip": return `Added a test tone`;
    case "add_midi_clip": return `Added a MIDI clip`;
    case "move_clip": return `Moved a clip to ${a.start}s`;
    case "trim_clip": return `Trimmed a clip`;
    case "split_clip": return `Split a clip at ${a.time}s`;
    case "duplicate_clip": return `Duplicated a clip`;
    case "remove_clip": return `Removed a clip`;
    case "rename_clip": return `Renamed a clip to "${a.name}"`;
    case "set_clip_gain": return `Set clip gain to ${a.gainDb} dB`;
    case "set_clip_mute": return a.mute ? `Muted a clip` : `Unmuted a clip`;
    case "sketch_beatbox": return `Turned a beatbox into a drum clip`;
    case "add_note": return `Added a note`;
    case "remove_note": return `Removed a note`;
    case "set_note": return `Edited a note`;
    case "quantize_notes": return `Quantized notes${a.division != null ? ` (${a.division}-beat grid)` : ""}`;
    case "set_tempo": return `Set tempo to ${a.bpm} BPM`;
    case "set_time_signature": return `Set time signature to ${a.numerator}/${a.denominator}`;
    case "set_metronome": return a.enabled ? `Turned the metronome on` : `Turned the metronome off`;
    case "set_key": return `Set key to ${a.tonic ?? ""} ${a.mode ?? ""}`.trim();
    case "set_transport": return a.action === "record" ? `Recording` : a.action === "stop" ? `Stopped` : a.action === "to_start" ? `Back to the start` : `Transport`;
    case "arm_track": return a.armed ? `Armed a track` : `Disarmed a track`;
    case "stop_recording": return `Stopped recording`;
    case "set_input_monitor": return `Set input monitoring`;
    case "list_takes": return `Listed the takes`;
    case "set_current_take": return `Switched to take ${a.takeIndex}`;
    case "keep_take": return `Kept the take`;
    case "undo": return `Undid the last change`;
    case "redo": return `Redid a change`;
    case "save": return `Saved the session`;
    case "set_track_volume": return `Set track volume to ${a.db} dB`;
    case "set_track_pan": return `Set track pan to ${a.pan}`;
    case "set_track_mute": return a.mute ? `Muted a track` : `Unmuted a track`;
    case "set_track_solo": return a.solo ? `Soloed a track` : `Unsoloed a track`;
    case "set_master_volume": return `Set master volume to ${a.db} dB`;
    case "set_master_pan": return `Set master pan to ${a.pan}`;
    case "load_builtin": return `Added ${a.type}`;
    case "set_track_type": return a.type === "drum" ? `Made it a drum track` : `Made it an audio track`;
    case "load_drum_kit": return `Loaded the drum kit`;
    case "assign_sample": return `Assigned a sample to a pad`;
    case "load_plugin": return `Added a plugin`;
    case "set_plugin_param": return `Tweaked a plugin parameter`;
    case "bypass_plugin": return a.bypassed ? `Bypassed a plugin` : `Enabled a plugin`;
    case "reorder_plugin": return `Reordered a plugin`;
    case "open_plugin_editor": return `Opened a plugin editor`;
    case "remove_plugin": return `Removed a plugin`;
    case "add_neural_insert": return `Added a neural insert`;
    case "set_neural_param": return `Set neural ${a.paramId} to ${a.value}`;
    case "set_neural_lab_mode": return a.on ? `Unlocked neural Lab mode` : `Locked neural Lab mode`;
    case "reset_neural": return `Reset the neural insert`;
    case "create_render_layer": return `Attached a generative layer`;
    case "set_render_param": return `Set a render parameter`;
    case "render_layer": return `Started a render`;
    case "accept_render": return `Accepted a render`;
    case "reject_render": return `Rejected a render`;
    case "bypass_layer": return a.bypassed ? `Bypassed a render layer` : `Enabled a render layer`;
    case "freeze_layer": return `Froze a render layer`;
    case "bounce_layer_to_clip": return `Bounced a layer to a clip`;
    case "remove_render_layer": return `Removed a render layer`;
    default: return command.replace(/_/g, " ");
  }
}
