// The curated tool catalog Moshi's brain is allowed to call. It deliberately
// exposes a high-value, low-blast-radius subset (~64 of the ~148 MoshOps commands) — no
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
  // ── song sections (Intro/Verse/Hook/…) — scope handles for "rework the hook" ──
  { command: "create_section", desc: "Add a named song section (beats)", args: [S("name"), N("startBeat"), N("endBeat"), S("color", false)] },
  { command: "rename_section", desc: "Rename a song section", args: [S("sectionId"), S("name")] },
  { command: "move_section", desc: "Move/resize a song section (in beats)", args: [S("sectionId"), N("startBeat"), N("endBeat")] },
  { command: "remove_section", desc: "Remove a song section", args: [S("sectionId")] },
  // ── timeline annotations (authored comment pins; shared with collaborators) ──
  { command: "create_annotation", desc: "Drop a comment pin on the timeline at a beat (flag something for the producer/collaborators)", args: [S("text"), N("beat"), S("color", false), S("author", false)] },
  { command: "edit_annotation", desc: "Change an annotation's text or colour", args: [S("annotationId"), S("text", false), S("color", false)] },
  { command: "move_annotation", desc: "Move an annotation to a new beat", args: [S("annotationId"), N("beat")] },
  { command: "remove_annotation", desc: "Remove a timeline annotation", args: [S("annotationId")] },

  // ── clips ───────────────────────────────────────────────────────────────
  { command: "add_test_tone_clip", desc: "Drop a test-tone clip on a track (lands at 0)", args: [S("trackId", false), N("seconds", false, "duration in seconds"), N("freq", false, "Hz")] },
  { command: "import_clip", desc: "Import an audio file onto a track at a given time", args: [S("file"), S("trackId", false), S("name", false), N("startSeconds", false, "seconds on the timeline")] },
  { command: "add_midi_clip", desc: "Add an empty MIDI clip", args: [S("trackId"), N("start", false, "seconds"), N("length", false, "seconds")] },
  { command: "move_clip", desc: "Move a clip to a new start time (and optionally another track)", args: [S("clipId"), S("trackId", false), N("start", true, "seconds")] },
  { command: "trim_clip", desc: "Set a clip's start and length", args: [S("clipId"), N("start"), N("length")] },
  { command: "split_clip", desc: "Split a clip at a time position", args: [S("clipId"), N("time", true, "seconds")] },
  { command: "duplicate_clip", desc: "Duplicate a clip", args: [S("clipId")] },
  { command: "remove_clip", desc: "Delete a clip", args: [S("clipId")] },
  { command: "rename_clip", desc: "Rename a clip", args: [S("clipId"), S("name")] },
  { command: "set_clip_gain", desc: "Set a clip's gain in dB", args: [S("clipId"), N("gainDb")] },
  { command: "set_clip_mute", desc: "Mute/unmute a clip", args: [S("clipId"), B("mute")] },
  { command: "set_clip_fade", desc: "Set a clip's fade-in / fade-out (seconds)",
    args: [S("clipId"), N("fadeInSec", false, "seconds"), N("fadeOutSec", false, "seconds"),
           S("curveIn", false, "linear|convex|concave|sCurve"), S("curveOut", false, "linear|convex|concave|sCurve")] },
  { command: "stretch_clip", desc: "Time-stretch a wave clip (warp) to a target length in seconds OR a bar count — e.g. make this loop fill 4 bars", args: [S("clipId"), N("length", false, "target warped length, seconds"), N("bars", false, "target length in bars")] },
  { command: "detect_clip_bpm", desc: "Estimate the BPM of a wave clip's audio (read-only)", args: [S("clipId")] },

  // ── embodied capture (Sketch, Phase 0) ───────────────────────────────────
  { command: "sketch_beatbox", desc: "Transduce a recorded beatbox WAV into an editable drum clip at a known BPM (kick/snare/hat on a 16th grid)", args: [S("file", true, "path to the beatbox WAV"), N("bpm", true, "known tempo"), N("bars", false, "loop length, 1-2 bars")] },

  // ── MIDI notes ──────────────────────────────────────────────────────────
  { command: "add_note", desc: "Add a MIDI note (pitch 0-127) to a MIDI clip", args: [S("clipId"), N("pitch"), N("start", true, "beats"), N("length", true, "beats"), N("velocity", false, "0-127")] },
  { command: "remove_note", desc: "Remove a MIDI note by index", args: [S("clipId"), N("noteIndex")] },
  { command: "set_note", desc: "Edit a MIDI note's pitch/start/length/velocity", args: [S("clipId"), N("noteIndex"), N("pitch", false), N("start", false), N("length", false), N("velocity", false)] },
  { command: "quantize_notes", desc: "Quantize a MIDI clip's notes to a grid", args: [S("clipId"), N("division", false, "beats: 1=1/4, 0.5=1/8, 0.25=1/16"), N("strength", false, "0-1")] },
  { command: "add_drum_pattern", desc: "Lay a whole drum grid in ONE undoable step from lane strings — 'x' hit, 'X' accent, '.'/'-' rest, '|' cosmetic; lanes kick/snare/clap/hat/openhat/lowtom/midtom/crash or a raw MIDI pitch; short lanes tile (\"x.\" = 8th hats)", args: [S("pattern", true, 'lane map: "kick: x...x...x...x...; snare: ....x.......x..."'), S("trackId", false, "target track — omit to create a new Drums track"), S("clipId", false, "existing MIDI clip: replaces ONLY the lanes named (trackId ignored)"), N("stepsPerBar", false, "1-64, default 16"), N("bars", false, "1-16, default fits the longest lane"), N("velocity", false, "1-127 for 'x' hits, default 100"), N("start", false, "seconds — new-clip position")] },

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

  // ── sends / returns / aux buses ───────────────────────────────────────────
  { command: "create_bus", desc: "Create an aux/return bus (a reverb/delay return track) — routes any track's send into it", args: [S("name", false, "bus name, e.g. 'Reverb'")] },
  { command: "add_send", desc: "Add a post-fader send from a track to a bus (bus number from the snapshot's buses[])", args: [S("trackId"), N("bus", true, "the bus number"), N("db", false, "send level in dB, -60…6")] },
  { command: "set_send_level", desc: "Set a track's send level to a bus in dB", args: [S("trackId"), N("bus"), N("db")] },
  { command: "remove_send", desc: "Remove a track's send to a bus", args: [S("trackId"), N("bus")] },

  // ── plugins ─────────────────────────────────────────────────────────────
  { command: "load_builtin", desc: "Add a built-in effect/instrument to a track (type from list_builtins)", args: [S("trackId"), N("index", false, "chain position"), S("type")] },
  { command: "set_track_type", desc: "Set a track's type — 'drum' loads the working sampler + drum kit so its MIDI notes are audible", args: [S("trackId"), S("type", true, '"audio" | "drum"')] },
  { command: "load_drum_kit", desc: "Load the built-in drum kit onto a track's sampler (kick/snare/clap/hats/toms/crash)", args: [S("trackId")] },
  { command: "assign_sample", desc: "Map an audio file to a track's sampler: mode 'drum' (default, one-shot pad at one note) or 'melodic' (a pitched 808/bass played across the keyboard, note-length gated)", args: [S("trackId"), N("note", true, "MIDI pitch 0-127: the pad (drum) or the sample's root note (melodic)"), S("file", true, "audio file path"), S("name", false, "pad label"), N("gainDb", false), S("mode", false, "'drum' (default) or 'melodic'")] },
  { command: "load_plugin", desc: "Add a scanned VST3/AU plugin to a track (pluginId from list_plugins)", args: [S("trackId"), S("pluginId"), N("index", false, "chain position")] },
  { command: "set_plugin_param", desc: "Set a plugin parameter (0-1) by chain index + param index", args: [S("trackId"), N("index"), N("paramIndex"), N("value", true, "0-1")] },
  { command: "bypass_plugin", desc: "Bypass/enable a plugin in a track's chain", args: [S("trackId"), N("index"), B("bypassed")] },
  { command: "reorder_plugin", desc: "Move a plugin to a new chain position", args: [S("trackId"), N("index"), N("toIndex")] },
  { command: "open_plugin_editor", desc: "Pop out a plugin's native editor window", args: [S("trackId"), N("index")] },
  { command: "remove_plugin", desc: "Remove a plugin from a track's chain", args: [S("trackId"), N("index")] },

  // ── generative (Tier-B) ─────────────────────────────────────────────────
  { command: "create_render_layer", desc: "Attach a generative re-imagine layer to ANY clip — wave, MIDI or drum (MIDI/drum is auto-bounced to audio first), optionally scoped to a beat range, in seconds", args: [S("clipId"), S("adapter", false), N("regionStart", false, "scope start in seconds"), N("regionEnd", false, "scope end in seconds")] },
  { command: "set_render_param", desc: "Set a render-layer parameter (prompt/noise/seed, transform target/strength, or whole-clip coverage)", args: [S("clipId"), S("prompt", false), N("nl", false, "noise level 0-1"), N("seed", false), S("target", false, "transform target instrument or free-text"), N("strength", false, "transform strength 0-100"), S("coverage", false, '"auto"|"loop"|"stitch" — cover a long clip by tiling a cycle or stitching windows')] },
  { command: "render_layer", desc: "Run the generative render on a clip's layer", args: [S("clipId")] },
  { command: "compile_render", desc: "Compile a loose instruction (\"make it lo-fi\", \"as a violin\") into a validated generative render on a clip — auto-picks re-imagine vs transform and fills prompt/colours/noise or target/strength; corrective (fix/tune) or vocal requests are honestly declined", args: [S("clipId"), S("instruction"), N("intensity", false, "0-100, how strong"), B("autoRender", false, "render immediately after compiling")] },
  { command: "accept_render", desc: "Accept a finished render (MIDI/drum: lands it as a clip; wave clips auto-apply in place, so this is a no-op for them)", args: [S("clipId")] },
  { command: "reject_render", desc: "Reject a render", args: [S("clipId")] },
  { command: "reset_render_layer", desc: "Restore a wave clip's ORIGINAL audio (undo the in-place re-imagine; the layer stays so you can re-render)", args: [S("clipId")] },
  { command: "bypass_layer", desc: "Bypass/enable a clip's render layer", args: [S("clipId"), B("bypassed")] },
  { command: "freeze_layer", desc: "Freeze a clip's render layer (commit the rendered audio)", args: [S("clipId")] },
  { command: "bounce_layer_to_clip", desc: "Bounce a render layer down to a plain clip", args: [S("clipId")] },
  { command: "remove_render_layer", desc: "Remove a clip's render layer", args: [S("clipId")] },

  // ── lyrics (Finish My Song) ───────────────────────────────────────────────
  { command: "create_lyric_sheet", desc: "Start a per-track lyric sheet for lyric completion (the vocal track)", args: [S("trackId"), S("grid", false, '"1/4"|"1/8"|"1/16" — bar subdivision for syllable inference'), S("language", false), S("topic", false), S("mood", false), S("explicit", false, '"allow"|"clean"|"mild"')] },
  { command: "set_lyric_constraint", desc: "Set sheet-level lyric constraints (grid/topic/mood/explicit/default rhyme strictness/style bias)", args: [S("trackId"), S("grid", false), S("topic", false), S("mood", false), S("explicit", false), S("rhymeStrictness", false, '"perfect"|"slant"|"free"'), B("styleBias", false, "§7: bias generation toward the artist's own voice")] },
  { command: "set_lyric_line", desc: "Write/update one lyric line by index — text, role, seed (___ = gap), syllable target, rhyme group, lock", args: [S("trackId"), N("lineIndex"), S("text", false), S("role", false, '"verse"|"hook"|"bridge"|"adlib"'), S("seedText", false, "partial line; ___ marks a gap"), N("syllableTarget", false, "0 ⇒ infer from grid"), N("syllableTol", false), S("stress", false, "contour, e.g. xXxxxXxxx"), S("rhymeGroup", false, "lines sharing a group must rhyme"), S("rhymeStrictness", false), B("locked", false), S("sectionId", false)] },
  { command: "remove_lyric_line", desc: "Remove a lyric line by index (remaining lines re-index)", args: [S("trackId"), N("lineIndex")] },
  { command: "get_rhymes", desc: "Phonology rhyme search for a word (perfect/slant, phoneme-based), filterable by syllable count — no LLM", args: [S("word"), S("strictness", false, '"perfect"|"slant"|"free"'), N("syllables", false, "filter to this syllable count"), N("maxN", false)] },
  { command: "complete_lyrics", desc: "Fill all the gaps in a track's lyric sheet — returns ranked proposals per line (constraint-checked: syllables + rhyme)", args: [S("trackId")] },
  { command: "fill_lyric_gap", desc: "Fill one lyric line's gaps — ranked proposals for that line", args: [S("trackId"), N("lineIndex")] },
  { command: "suggest_next_line", desc: "Suggest the next lyric line (a ghost line after the given index)", args: [S("trackId"), N("afterIndex")] },
  { command: "regenerate_lyric", desc: "Re-generate proposals for one lyric line with a fresh sample", args: [S("trackId"), N("lineIndex")] },
  { command: "accept_lyric_proposal", desc: "Accept a generated lyric proposal (commits its text into the line)", args: [S("trackId"), N("lineIndex"), N("proposalIndex", false, "default 0 = top-ranked")] },
  { command: "assert_lyric_line", desc: "Assert final words for one lyric line before sing render", args: [S("trackId"), N("lineIndex"), S("text", false)] },
  { command: "analyze_lyrics", desc: "Precise per-line phonology (syllables, stress contour, rhyme grade vs the group anchor) for the flow visualizer — no LLM", args: [S("trackId")] },
  { command: "build_skeleton_from_clip", desc: "Turn a hummed/mumbled wave take into an editable rhythmic flow skeleton (syllable grid + stress, no words) on the clip's track — the producer confirms the grid, then 'Finish gaps' writes the words", args: [S("clipId"), S("grid", false), B("wait", false)] },
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
    case "import_clip": return `Imported audio ${a.file ? String(a.file).split("/").pop() : "clip"}${a.startSeconds ? ` at ${a.startSeconds}s` : ""}`;
    case "add_midi_clip": return `Added a MIDI clip`;
    case "move_clip": return `Moved a clip to ${a.start}s`;
    case "trim_clip": return `Trimmed a clip`;
    case "split_clip": return `Split a clip at ${a.time}s`;
    case "duplicate_clip": return `Duplicated a clip`;
    case "remove_clip": return `Removed a clip`;
    case "rename_clip": return `Renamed a clip to "${a.name}"`;
    case "set_clip_gain": return `Set clip gain to ${a.gainDb} dB`;
    case "set_clip_mute": return a.mute ? `Muted a clip` : `Unmuted a clip`;
    case "set_clip_fade": return `Set clip fades (in ${a.fadeInSec ?? "–"}s, out ${a.fadeOutSec ?? "–"}s)`;
    case "stretch_clip": return a.bars ? `Stretched a clip to ${a.bars} bar${Number(a.bars) > 1 ? "s" : ""}` : `Stretched a clip to ${a.length}s`;
    case "detect_clip_bpm": return `Detected a clip's BPM`;
    case "sketch_beatbox": return `Turned a beatbox into a drum clip`;
    case "add_note": return `Added a note`;
    case "add_drum_pattern": return `Laid a drum pattern`;
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
    case "create_bus": return `Created a ${a.name ? `"${a.name}" ` : ""}bus`;
    case "add_send": return `Added a send to bus ${a.bus}`;
    case "set_send_level": return `Set send to bus ${a.bus} to ${a.db} dB`;
    case "remove_send": return `Removed a send to bus ${a.bus}`;
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
    case "create_render_layer": return `Attached a generative layer`;
    case "set_render_param": return `Set a render parameter`;
    case "compile_render": return `Compiled a generative render`;
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
