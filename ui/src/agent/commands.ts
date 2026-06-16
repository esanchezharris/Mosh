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

export type ArgType = "string" | "number" | "boolean" | "array";
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
const A = (name: string, required = true, desc?: string): ArgSpec => ({ name, type: "array", required, desc });

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
  { command: "set_clip_warp", desc: "Enable/disable audio warp (auto-tempo) on a wave clip so it time-stretches to follow the project tempo — give sourceBpm = the loop's original BPM for an accurate fit", args: [S("clipId"), B("autoTempo", true, "on/off"), S("mode", false, "stretch mode, e.g. 'elastiquePro'"), N("sourceBpm", false, "the clip's original BPM")], summary: (a) => (a.autoTempo ? "Warped a clip to tempo" : "Unwarped a clip") },

  // ── samples (browse the user's library, then import) ──────────────────────
  { command: "list_samples", desc: "Browse the user's sample library for one-shots/loops (filter by query and/or category)", args: [S("query", false, "name filter, e.g. 'kick'"), S("category", false, '"kick"|"snare"|"hat"|"cymbal"|"perc"|"bass"|"loop"|"fx"|"vocal"'), N("limit", false)], summary: () => "Browsed samples" },
  { command: "import_clip", desc: "Import an audio file (e.g. a sample path returned by list_samples) onto a track", args: [S("file", true, "absolute path from list_samples"), S("trackId", false), S("name", false), N("startSeconds", false, "seconds")], summary: (a) => `Imported ${a.name ?? "a sample"}` },

  // ── MIDI notes ──────────────────────────────────────────────────────────
  { command: "add_note", desc: "Add a MIDI note (pitch 0-127) to a MIDI clip", args: [S("clipId"), N("pitch"), N("start", true, "beats"), N("length", true, "beats"), N("velocity", false, "0-127")], summary: () => "Added a note" },
  { command: "remove_note", desc: "Remove a MIDI note by index", args: [S("clipId"), N("noteIndex")], summary: () => "Removed a note" },
  { command: "set_note", desc: "Edit a MIDI note's pitch/start/length/velocity", args: [S("clipId"), N("noteIndex"), N("pitch", false), N("start", false), N("length", false), N("velocity", false)], summary: () => "Edited a note" },
  { command: "quantize_notes", desc: "Quantize a MIDI clip's notes to a grid, optionally with swing", args: [S("clipId"), N("division", true, "grid in beats — 1 = 1/4, 0.5 = 1/8, 0.25 = 1/16"), N("strength", false, "0-1 snap amount"), N("swing", false, "0-0.75 — delays the off-beats (0.66 ≈ triplet/MPC feel)")], summary: () => "Quantized notes" },
  { command: "humanize_notes", desc: "Add seeded, deterministic timing + velocity jitter to a MIDI clip so a programmed part feels human, not robotic. The SAME seed reproduces the same feel", args: [S("clipId"), N("timing", false, "0-1 timing slop (±1/8 note at 1); small 0.1-0.3 is musical"), N("velocity", false, "0-1 velocity variation"), N("seed", false, "integer — reproduces the same feel")], summary: () => "Humanized notes" },

  // ── transport & timing ──────────────────────────────────────────────────
  { command: "set_tempo", desc: "Set the project tempo in BPM", args: [N("bpm")], summary: (a) => `Set tempo to ${a.bpm} BPM` },
  { command: "set_time_signature", desc: "Set the time signature", args: [N("numerator"), N("denominator")], summary: (a) => `Set time signature to ${a.numerator}/${a.denominator}` },
  { command: "set_key", desc: "Set the project's musical key (tonic and/or mode)", args: [S("tonic", false, '"C".."B" incl. sharps/flats'), S("mode", false, '"major" | "minor" | "dorian" | "mixolydian" | "pentatonic" | "chromatic"')], summary: (a) => `Set the key${a.tonic ? ` to ${a.tonic}` : ""}${a.mode ? ` ${a.mode}` : ""}` },
  { command: "set_metronome", desc: "Toggle the metronome click", args: [B("enabled")], summary: (a) => (a.enabled ? "Turned the metronome on" : "Turned the metronome off") },
  { command: "set_transport", desc: "Play/pause/stop/record, seek, or set the loop region", args: [S("action", false, '"toggle" (play/pause) | "stop" | "record" | "to_start" | "to_end"'), N("position", false, "seek to seconds"), B("loop", false, "enable loop"), N("loopStart", false, "seconds"), N("loopEnd", false, "seconds")], summary: (a) => (a.action === "record" ? "Started recording" : a.action === "stop" ? "Stopped" : a.loop ? "Set the loop region" : a.action === "toggle" ? "Toggled playback" : "Moved the playhead") },
  { command: "insert_tempo_change", desc: "Insert a tempo change at a time (a tempo MAP, for accelerando/ritardando or section tempo shifts). curve ramps to the next change", args: [N("time", true, "seconds"), N("bpm"), N("curve", false, "-1..1 ramp shape (0 = linear ramp, 1 = instant step)")], summary: (a) => `Tempo → ${a.bpm} BPM at ${a.time}s` },
  { command: "insert_time_sig_change", desc: "Insert a time-signature change at a time (seconds)", args: [N("time", true, "seconds"), N("numerator", false), N("denominator", false)], summary: (a) => `Time sig → ${a.numerator}/${a.denominator}` },

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
  { command: "set_plugin_param_by_name", desc: "Set a plugin param by NAME (no index guessing) — e.g. an EQ's 'Frequency' or a comp's 'Ratio'. Read the names from the track's fx:[i:name{pi:name=val}] in the snapshot. Address the plugin by chain index, or pluginName if you don't know the index", args: [S("trackId"), N("index", false, "plugin chain position — or give pluginName"), S("pluginName", false, "match the plugin by name instead of index"), S("paramName", true, "param name (case-insensitive; unambiguous substring ok)"), N("value", true, "0-1 normalised")], summary: (a) => `Set ${a.paramName ?? "a parameter"}` },
  { command: "set_4osc_patch", desc: "Give a 4osc synth a real tone (its default is a bare SINE). Call right after load_builtin {type:'4osc'}, before adding notes", args: [S("trackId"), N("index", false, "chain position of the 4osc"), S("patch", true, '"warm_keys" | "sub_bass" | "soft_pad" | "pluck" | "saw_lead"')], summary: (a) => `Set 4osc patch → ${a.patch}` },
  { command: "bypass_plugin", desc: "Bypass/enable a plugin in a track's chain", args: [S("trackId"), N("index"), B("bypassed")], summary: (a) => (a.bypassed ? "Bypassed a plugin" : "Enabled a plugin") },
  { command: "reorder_plugin", desc: "Move a plugin to a new position in a track's chain", args: [S("trackId"), N("index"), N("toIndex")], summary: () => "Reordered a plugin" },
  { command: "open_plugin_editor", desc: "Pop out a plugin's native editor window", args: [S("trackId"), N("index")], summary: () => "Opened a plugin editor" },
  { command: "remove_plugin", desc: "Remove a plugin from a track's chain", args: [S("trackId"), N("index")], summary: () => "Removed a plugin" },

  // ── parameter automation (target a plugin param by chain index + param index from the
  //    snapshot's fx:[i:name{pi:name=value}]; the track fader/pan is a plugin too) ──────
  { command: "add_automation_point", desc: "Automate a plugin parameter — add a breakpoint. Read pluginIndex + paramIndex from the track's fx:[…] in the snapshot. value is 0-1 normalised; time in seconds. Two+ points make a move (e.g. a filter sweep)", args: [S("trackId"), N("pluginIndex", true, "chain position from snapshot fx:[i:name]"), N("paramIndex", true, "param slot from fx:[…{pi:name}]"), N("time", true, "seconds"), N("value", true, "0-1 normalised")], summary: (a) => `Automated a parameter at ${a.time}s` },
  { command: "set_automation_point", desc: "Move an existing automation breakpoint to a new time and/or value (omit one to keep it)", args: [S("trackId"), N("pluginIndex"), N("paramIndex"), N("pointIndex", true, "which breakpoint (its position in the param's points[])"), N("time", false, "seconds"), N("value", false, "0-1")], summary: () => "Moved an automation point" },
  { command: "remove_automation_point", desc: "Remove one automation breakpoint from a plugin parameter", args: [S("trackId"), N("pluginIndex"), N("paramIndex"), N("pointIndex", true, "which breakpoint")], summary: () => "Removed an automation point" },
  { command: "clear_automation", desc: "Clear all automation from a plugin parameter", args: [S("trackId"), N("pluginIndex"), N("paramIndex")], summary: () => "Cleared a parameter's automation" },

  // ── sends & buses (reverb returns, parallel compression) ──────────────────
  { command: "create_bus", desc: "Create an aux send/return bus (a return track) — for a shared reverb/delay or parallel compression. Returns its busNumber", args: [S("name", false, "bus name")], summary: (a) => `Created bus${a.name ? ` "${a.name}"` : ""}` },
  { command: "add_send", desc: "Add a post-fader send from a track to a bus (by busNumber from create_bus or the snapshot's buses line)", args: [S("trackId"), N("bus", true, "the bus number"), N("db", false, "send level dB, -60..6")], summary: () => "Added a send" },
  { command: "set_send_level", desc: "Set an existing send's level in dB (-100 mutes the send, up to +6)", args: [S("trackId"), N("bus"), N("db", true, "dB — -100 mutes, up to +6")], summary: (a) => `Set a send to ${a.db} dB` },
  { command: "remove_send", desc: "Remove a track's send to a bus", args: [S("trackId"), N("bus")], summary: () => "Removed a send" },
  // remove_bus / rename_bus deferred to batch 2: the engine's setAuxBusName mutates the
  // bus-NAME node with a null UndoManager, so undo restores the routing but the name
  // reverts to default — a cosmetic undo wart. Expose once the name change is undo-tracked.

  // ── groups (submixes) ─────────────────────────────────────────────────────
  { command: "create_group_track", desc: "Group tracks into a submix/folder track for shared processing", args: [A("trackIds", true, "ids of the tracks to group"), S("name", false, "group name")], summary: () => "Grouped tracks" },
  { command: "ungroup_track", desc: "Ungroup a track from its submix", args: [S("trackId")], summary: () => "Ungrouped a track" },

  // ── arrangement (destructive time edit — gated) ───────────────────────────
  { command: "delete_time_range", desc: "Delete everything in a time range (optionally only on some tracks). Destructive but undoable", args: [N("start", true, "seconds"), N("end", true, "seconds"), A("trackIds", false, "limit to these tracks; omit for all")], confirm: true, summary: (a) => `Deleted ${a.start}-${a.end}s` },

  // ── neural (Tier-A) ─────────────────────────────────────────────────────
  { command: "add_neural_insert", desc: "Add a real-time neural amp / guitar-amp / cabinet / tone modeler (the neural insert) to a track", args: [S("trackId"), N("index", false)], summary: () => "Added a neural insert" },
  { command: "set_neural_param", desc: "Set a neural insert param (0-100, ASTD-clamped)", args: [S("trackId"), S("paramId", true, '"drive" | "mix"'), N("value", true, "0-100"), N("index", false, "chain position of the insert")], summary: (a) => `Set neural ${a.paramId} to ${a.value}` },
  { command: "set_neural_lab_mode", desc: "Unlock the neural insert's raw (Lab) range", args: [S("trackId"), B("on"), N("index", false)], summary: (a) => (a.on ? "Unlocked neural Lab mode" : "Locked neural to safe range") },
  { command: "reset_neural", desc: "Reset the neural model's internal state", args: [S("trackId"), N("index", false)], summary: () => "Reset the neural model" },

  // ── generative (Tier-B) ─────────────────────────────────────────────────
  // generate_audio is the one-shot "make a sound from a text prompt" seam — no host-clip
  // setup. Prefer it for "generate/create/make me a <sound>". Write the prompt in the SA3
  // metadata style (genre, era, EVERY instrument you want, BPM, key, mood, production —
  // comma-separated); a terse prompt renders only what it names.
  { command: "generate_audio", desc: "Generate a sound/loop from a text prompt (Stable Audio) and drop it in — one shot, no setup", args: [S("prompt", true, "SA3 metadata-style: genre, instruments, BPM, key, mood, production, comma-separated"), S("trackId", false, "omit to make a new track"), N("seed", false, "change for a different take"), A("colors", false, '≤3 timbre pushes [{name,value 0-100}] e.g. grit/air — optional'), N("startSeconds", false), B("lab", false, "unlock raw ASTD range")], summary: () => "Generated audio from a prompt" },
  { command: "create_render_layer", desc: "Attach a generative re-imagine layer to a wave clip", args: [S("clipId"), S("adapter", false)], summary: () => "Attached a generative layer" },
  { command: "set_render_param", desc: "Set render-layer parameters (seed bump = new take)", args: [S("clipId"), N("seed", false, "change to get a new take"), S("prompt", false), N("nl", false, "0-1 noise level"), A("colors", false, "≤3 timbre pushes [{name,value 0-100}]"), B("lab", false, "unlock raw ASTD range")], summary: () => "Set a render parameter" },
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
  { command: "bounce_track", desc: "Bounce/print ONE track's full FX chain to a new audio clip on a new track (the source is kept). Use to commit a sound, or to freeze a chain before a heavy generative pass", args: [S("trackId"), S("name", false, "name for the bounce track/clip"), N("tailSeconds", false, "extra render time for reverb/delay tails")], summary: () => "Bounced a track to audio" },
];

export const AGENT_COMMAND_MAP = new Map(AGENT_COMMANDS.map((c) => [c.command, c]));

/** LLMs habitually emit ids as numbers (`trackId: 1010`) even when the snapshot
 *  shows them as strings. Coerce number→string for any arg declared `string` so a
 *  well-meant plan isn't rejected by the validator. Applied before validateCommand. */
export function coerceArgs(command: string, args: Record<string, unknown>): Record<string, unknown> {
  const spec = AGENT_COMMAND_MAP.get(command);
  if (!spec) return args;
  const out: Record<string, unknown> = { ...args };
  for (const a of spec.args)
    if (a.type === "string" && typeof out[a.name] === "number") out[a.name] = String(out[a.name]);
  return out;
}

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
    if (a.type === "array" && !Array.isArray(v)) return `${command}: "${a.name}" must be an array`;
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
