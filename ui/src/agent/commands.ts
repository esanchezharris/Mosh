// The curated tool catalog Moshi's brain is allowed to call. A deliberately
// high-value, low-blast-radius subset of the ~93 MoshOps commands — no project IO
// that could lose the user's work, no device settings, no raw scans.
//
// SINGLE SOURCE OF TRUTH: each entry carries everything its three consumers need —
//   desc      → the LLM system prompt (commandCatalogPrompt)
//   args      → client-side validation (validateCommand), the hallucination gate
//   summary   → the human changelog line (describeCommand)
//   confirm   → destructive ops that need a spoken "yes" (REQUIRES_CONFIRM)
// so adding a command is ONE object literal and the three can never drift.
//
// EVERY arg name here MUST match what the C++ handler reads in MoshOps.cpp — see the
// `catalog ↔ backend arg contract` test, which parses the .cpp and fails on drift.

export type ArgType = "string" | "number" | "boolean";
export type ArgSpec = { name: string; type: ArgType; required?: boolean; desc?: string };
type DescArgs = Record<string, string | number | boolean | undefined>;
export type AgentCommand = {
  command: string;
  desc: string;
  args: ArgSpec[];
  // true → always confirm; a predicate → confirm only for certain args (e.g.
  // export_audio only when it would overwrite an explicit file).
  confirm?: boolean | ((a: DescArgs) => boolean);
  summary?: (a: DescArgs) => string;
};

const S = (name: string, required = true, desc?: string): ArgSpec => ({ name, type: "string", required, desc });
const N = (name: string, required = true, desc?: string): ArgSpec => ({ name, type: "number", required, desc });
const B = (name: string, required = true, desc?: string): ArgSpec => ({ name, type: "boolean", required, desc });

export const AGENT_COMMANDS: AgentCommand[] = [
  // ── session / history ─────────────────────────────────────────────────────
  { command: "undo", desc: "Undo the last change", args: [], summary: () => "Undid the last change" },
  { command: "redo", desc: "Redo the last undone change", args: [], summary: () => "Redid a change" },
  { command: "save", desc: "Save the session to disk", args: [], summary: () => "Saved the session" },

  // ── tracks ──────────────────────────────────────────────────────────────
  { command: "create_track", desc: "Add a new audio track", args: [S("name", false, "track name")], summary: (a) => `Added track${a.name ? ` "${a.name}"` : ""}` },
  { command: "rename_track", desc: "Rename a track", args: [S("trackId"), S("name")], summary: (a) => `Renamed track to "${a.name}"` },
  { command: "remove_track", desc: "Delete a track and its clips", args: [S("trackId")], summary: () => "Removed a track" },

  // ── clips ───────────────────────────────────────────────────────────────
  { command: "add_test_tone_clip", desc: "Drop a test-tone clip on a track", args: [S("trackId", false), N("seconds", false, "duration in seconds"), N("freq", false, "tone frequency in Hz")], summary: () => "Added a test tone" },
  { command: "add_midi_clip", desc: "Add an empty MIDI clip", args: [S("trackId"), N("start", false, "seconds"), N("length", false, "length in beats")], summary: () => "Added a MIDI clip" },
  { command: "move_clip", desc: "Move a clip to a new start time (and optionally another track)", args: [S("clipId"), S("trackId", false), N("start", true, "seconds")], summary: (a) => `Moved a clip to ${a.start}s` },
  { command: "trim_clip", desc: "Set a clip's start and length", args: [S("clipId"), N("start"), N("length")], summary: () => "Trimmed a clip" },
  { command: "split_clip", desc: "Split a clip at a time position", args: [S("clipId"), N("time", true, "seconds")], summary: (a) => `Split a clip at ${a.time}s` },
  { command: "duplicate_clip", desc: "Duplicate a clip", args: [S("clipId")], summary: () => "Duplicated a clip" },
  { command: "rename_clip", desc: "Rename a clip", args: [S("clipId"), S("name")], summary: (a) => `Renamed a clip to "${a.name}"` },
  { command: "remove_clip", desc: "Delete a clip", args: [S("clipId")], summary: () => "Removed a clip" },
  { command: "set_clip_gain", desc: "Set a clip's gain in dB", args: [S("clipId"), N("gainDb")], summary: (a) => `Set clip gain to ${a.gainDb} dB` },
  { command: "set_clip_mute", desc: "Mute/unmute a clip", args: [S("clipId"), B("mute")], summary: (a) => (a.mute ? "Muted a clip" : "Unmuted a clip") },

  // ── MIDI notes ──────────────────────────────────────────────────────────
  { command: "add_note", desc: "Add a MIDI note (pitch 0-127) to a MIDI clip", args: [S("clipId"), N("pitch"), N("start", true, "beats"), N("length", true, "beats"), N("velocity", false, "0-127")], summary: () => "Added a note" },
  { command: "remove_note", desc: "Remove a MIDI note by index", args: [S("clipId"), N("noteIndex")], summary: () => "Removed a note" },
  { command: "set_note", desc: "Edit a MIDI note's pitch/start/length/velocity", args: [S("clipId"), N("noteIndex"), N("pitch", false), N("start", false), N("length", false), N("velocity", false)], summary: () => "Edited a note" },
  { command: "quantize_notes", desc: "Quantize a MIDI clip's notes to a grid", args: [S("clipId"), N("division", true, "grid in beats — 1 = 1/4, 0.5 = 1/8, 0.25 = 1/16"), N("strength", false, "0-1")], summary: () => "Quantized notes" },

  // ── transport & timing ──────────────────────────────────────────────────
  { command: "set_tempo", desc: "Set the project tempo in BPM", args: [N("bpm")], summary: (a) => `Set tempo to ${a.bpm} BPM` },
  { command: "set_time_signature", desc: "Set the time signature", args: [N("numerator"), N("denominator")], summary: (a) => `Set time signature to ${a.numerator}/${a.denominator}` },
  { command: "set_key", desc: "Set the project's musical key (tonic and/or mode)", args: [S("tonic", false, '"C".."B" incl. sharps/flats'), S("mode", false, '"major" | "minor" | "dorian" | "mixolydian" | "pentatonic" | "chromatic"')], summary: (a) => `Set the key${a.tonic ? ` to ${a.tonic}` : ""}${a.mode ? ` ${a.mode}` : ""}` },
  { command: "set_metronome", desc: "Toggle the metronome click", args: [B("enabled")], summary: (a) => (a.enabled ? "Turned the metronome on" : "Turned the metronome off") },
  { command: "set_transport", desc: "Play/pause/stop/record, seek, or set the loop region", args: [S("action", false, '"toggle" (play/pause) | "stop" | "record" | "to_start" | "to_end"'), N("position", false, "seek to seconds"), B("loop", false, "enable loop"), N("loopStart", false, "seconds"), N("loopEnd", false, "seconds")], summary: (a) => (a.action === "record" ? "Started recording" : a.action === "stop" ? "Stopped" : a.loop ? "Set the loop region" : a.action === "toggle" ? "Toggled playback" : "Moved the playhead") },

  // ── mixer ───────────────────────────────────────────────────────────────
  { command: "set_track_volume", desc: "Set a track's volume in dB", args: [S("trackId"), N("db")], summary: (a) => `Set track volume to ${a.db} dB` },
  { command: "set_track_pan", desc: "Set a track's pan (-1 left … 1 right)", args: [S("trackId"), N("pan")], summary: (a) => `Set track pan to ${a.pan}` },
  { command: "set_track_mute", desc: "Mute/unmute a track", args: [S("trackId"), B("mute")], summary: (a) => (a.mute ? "Muted a track" : "Unmuted a track") },
  { command: "set_track_solo", desc: "Solo/unsolo a track", args: [S("trackId"), B("solo")], summary: (a) => (a.solo ? "Soloed a track" : "Unsoloed a track") },
  { command: "set_master_volume", desc: "Set the master volume in dB", args: [N("db")], summary: (a) => `Set master volume to ${a.db} dB` },
  { command: "set_master_pan", desc: "Set the master pan (-1 left … 1 right)", args: [N("pan")], summary: (a) => `Set master pan to ${a.pan}` },

  // ── plugins ─────────────────────────────────────────────────────────────
  { command: "load_builtin", desc: "Add a built-in effect/instrument to a track (type from list_builtins)", args: [S("trackId"), N("index", false, "chain position"), S("type")], summary: (a) => `Added ${a.type}` },
  { command: "load_plugin", desc: "Add a scanned VST3/AU plugin to a track BY NAME (use the exact name from the available-plugins list)", args: [S("trackId"), S("pluginId", true, "exact plugin name"), N("index", false, "chain position")], summary: (a) => `Added ${a.pluginId}` },
  { command: "set_plugin_param", desc: "Set a plugin parameter (0-1) by chain index + param index", args: [S("trackId"), N("index"), N("paramIndex"), N("value", true, "0-1")], summary: () => "Tweaked a plugin parameter" },
  { command: "bypass_plugin", desc: "Bypass/enable a plugin in a track's chain", args: [S("trackId"), N("index"), B("bypassed")], summary: (a) => (a.bypassed ? "Bypassed a plugin" : "Enabled a plugin") },
  { command: "reorder_plugin", desc: "Move a plugin to a new position in a track's chain", args: [S("trackId"), N("index"), N("toIndex")], summary: () => "Reordered a plugin" },
  { command: "open_plugin_editor", desc: "Pop out a plugin's native editor window", args: [S("trackId"), N("index")], summary: () => "Opened a plugin editor" },
  { command: "remove_plugin", desc: "Remove a plugin from a track's chain", args: [S("trackId"), N("index")], summary: () => "Removed a plugin" },

  // ── neural (Tier-A) ─────────────────────────────────────────────────────
  { command: "add_neural_insert", desc: "Add the real-time neural insert to a track", args: [S("trackId"), N("index", false)], summary: () => "Added a neural insert" },
  { command: "set_neural_param", desc: "Set a neural insert param (0-100, ASTD-clamped)", args: [S("trackId"), S("paramId", true, '"drive" | "mix"'), N("value", true, "0-100"), N("index", false, "chain position of the insert")], summary: (a) => `Set neural ${a.paramId} to ${a.value}` },
  { command: "set_neural_lab_mode", desc: "Unlock the neural insert's raw (Lab) range", args: [S("trackId"), B("on"), N("index", false)], summary: (a) => (a.on ? "Unlocked neural Lab mode" : "Locked neural to safe range") },
  { command: "reset_neural", desc: "Reset the neural model's internal state", args: [S("trackId"), N("index", false)], summary: () => "Reset the neural model" },

  // ── generative (Tier-B) ─────────────────────────────────────────────────
  { command: "create_render_layer", desc: "Attach a generative re-imagine layer to a wave clip", args: [S("clipId"), S("adapter", false)], summary: () => "Attached a generative layer" },
  { command: "set_render_param", desc: "Set render-layer parameters (seed bump = new take)", args: [S("clipId"), N("seed", false, "change to get a new take"), S("prompt", false), N("nl", false, "0-1 noise level"), B("lab", false, "unlock raw ASTD range")], summary: () => "Set a render parameter" },
  { command: "render_layer", desc: "Run the generative render on a clip's layer", args: [S("clipId")], summary: () => "Started a render" },
  { command: "cancel_render", desc: "Cancel an in-flight generative render", args: [S("clipId"), S("jobId", false)], summary: () => "Cancelled a render" },
  { command: "accept_render", desc: "Accept a finished render (lands it as a clip)", args: [S("clipId")], summary: () => "Accepted a render" },
  { command: "reject_render", desc: "Reject a render", args: [S("clipId")], summary: () => "Rejected a render" },
  { command: "bypass_layer", desc: "Bypass/enable a clip's generative render layer", args: [S("clipId"), B("bypassed")], summary: (a) => (a.bypassed ? "Bypassed a generative layer" : "Enabled a generative layer") },
  { command: "freeze_layer", desc: "Freeze a render as durable audio", args: [S("clipId")], summary: () => "Froze a render" },
  { command: "bounce_layer_to_clip", desc: "Bounce a render down to a plain clip", args: [S("clipId")], summary: () => "Bounced a render to a clip" },
  { command: "remove_render_layer", desc: "Remove a clip's generative layer", args: [S("clipId")], summary: () => "Removed a generative layer" },

  // ── export ──────────────────────────────────────────────────────────────
  // Omit `file` for a safe timestamped export; a given `file` may overwrite, so
  // that variant is gated behind a spoken confirmation (see commandNeedsConfirm).
  { command: "export_audio", desc: "Export/bounce the mix to an audio file (omit file for a safe timestamped name)", args: [S("file", false, "path — omit for a safe timestamped file"), S("format", false, '"wav" | "aiff" | "flac"'), N("bitDepth", false), S("renderMode", false, '"auto" | "fast" | "realtime"'), N("sampleRate", false)], confirm: (a) => Boolean(a.file), summary: () => "Exported the mix" },
];

export const AGENT_COMMAND_MAP = new Map(AGENT_COMMANDS.map((c) => [c.command, c]));

/** Does this command (with these args) need a spoken "yes" before it runs? */
export function commandNeedsConfirm(command: string, args: Record<string, unknown>): boolean {
  const c = AGENT_COMMAND_MAP.get(command);
  if (!c?.confirm) return false;
  return typeof c.confirm === "function" ? c.confirm(args as DescArgs) : c.confirm;
}

/** Resolve a plugin the brain named (e.g. "ott", "pro q 3") to a real scanned-plugin
 *  id, tolerating case/spacing/punctuation. Returns the id, or an error string when
 *  there's no usable match — never guesses a wrong plugin into the chain. */
export function resolvePluginId(
  query: string,
  plugins: readonly { id: string; name: string }[],
): { id: string } | { error: string } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = norm(query);
  if (!q) return { error: "no plugin name given" };

  const exact = plugins.find((p) => norm(p.name) === q);
  if (exact) return { id: exact.id };

  const contains = plugins.filter((p) => {
    const n = norm(p.name);
    return n.includes(q) || q.includes(n);
  });
  if (contains.length === 1) return { id: contains[0].id };
  if (contains.length > 1) {
    // most-specific wins (shortest name that still contains the query)
    const best = [...contains].sort((a, b) => norm(a.name).length - norm(b.name).length);
    return { id: best[0].id };
  }
  return { error: `no plugin matching "${query}" — open the plugin browser to see what's installed` };
}

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
  const spec = AGENT_COMMAND_MAP.get(command);
  if (spec?.summary) return spec.summary(args as DescArgs);
  return command.replace(/_/g, " ");
}
