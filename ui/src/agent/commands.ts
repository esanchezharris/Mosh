// The curated tool catalog Moshi's brain is allowed to call. It deliberately
// exposes a high-value, low-blast-radius subset of MoshOps commands — no
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

/** The engine's compiled-in builtin plugin TYPE names — the exact vocabulary
 *  load_builtin / load_master_builtin accept. These go INLINE into the catalog
 *  descriptions below, because only `desc` is rendered into the system prompt
 *  (commandCatalogPrompt drops arg descriptions) and because the model has no
 *  other way to learn them: list_builtins is a discovery call whose RETURN DATA
 *  the agentic loop never shows the model (StepCommandResult is {command, ok,
 *  error} — no payload), so pointing at it was a dead end. The bench signature
 *  was a doubled `list_builtins, list_builtins` followed by a guessed type.
 *
 *  The trap this closes is specific and already documented in bridge.mock.ts:
 *  the natural guess for an EQ is "eq", which the engine REJECTS — the real
 *  type is "4bandEq".
 *
 *  Mirrors kBuiltins in src/moshops/MoshOpsInternal.h. Do NOT trust that sentence:
 *  builtins.test.ts parses that C++ table and fails if this list drifts.
 *
 *  The load_builtin desc below inlines this list as a PLAIN string, not a
 *  template literal, because service/skills/moshops_catalog.py parses this
 *  file statically (skillCatalogBoundary.test.ts enforces that projection).
 *  builtins.test.ts pins desc ⇄ BUILTIN_TYPES, so the two cannot drift. */
export const BUILTIN_TYPES = [
  "4osc", "sampler", "4bandEq", "compressor", "reverb", "delay", "chorus",
  "phaser", "lowpass", "pitchShifter", "moshAutoTune", "moshOTT", "moshXFeedback",
] as const;

export const AGENT_COMMANDS: AgentCommand[] = [
  // ── tracks ──────────────────────────────────────────────────────────────
  { command: "create_track", desc: "Add a new track — type 'drum' loads a sampler + drum kit so beats are audible immediately", args: [S("name", false, "track name"), S("type", false, '"audio" (default) | "drum"')] },
  { command: "rename_track", desc: "Rename a track", args: [S("trackId"), S("name")] },
  { command: "set_track_color", desc: "Recolour a track for organisation (changes nothing audible)", args: [S("trackId"), S("color", true, '"#rrggbb" lowercase hex, or "" to clear back to the type default')] },
  { command: "set_track_icon", desc: "Set a track's icon so it is findable at a glance (changes nothing audible)", args: [S("trackId"), S("icon", true, 'one of: drum, perc, bass, guitar, keys, synth, vocal, strings, fx, sample — or "" to clear back to the track type default')] },
  { command: "move_track", desc: "Reorder a track — toIndex is its new position in the arrangement (0 = top). Refuses a track inside a group", args: [S("trackId"), N("toIndex", true, "0-based position among the arrangement's tracks")] },
  { command: "remove_track", desc: "Delete a track and its clips", args: [S("trackId")] },
  { command: "set_track_active", desc: "Make a track active or inactive without deleting, hiding, or muting it", args: [S("trackId"), B("active")] },
  { command: "create_track_group", desc: "Create an Edit, Mix, or Edit+Mix Track Group. Pass trackIds as an array of track ids; mixAttributes may be an array of linked Mix controls", args: [S("name", false), S("kind", false, "edit | mix | edit_mix")] },
  { command: "configure_track_group", desc: "Atomically update a Track Group's name, type, members, and linked Mix controls. Pass trackIds and mixAttributes as arrays", args: [S("groupId"), S("name"), S("kind", true, "edit | mix | edit_mix")] },
  { command: "duplicate_track_group", desc: "Duplicate a Track Group with an explicit new name, type, member trackIds array, and mixAttributes array", args: [S("groupId"), S("name"), S("kind", true, "edit | mix | edit_mix")] },
  { command: "set_track_group_members", desc: "Replace a Track Group's members. Pass trackIds as an array", args: [S("groupId")] },
  { command: "set_track_group_enabled", desc: "Enable or disable one Track Group without deleting its definition", args: [S("groupId"), B("enabled")] },
  { command: "set_track_groups_suspended", desc: "Suspend or resume all Track Group linkage while preserving every group definition", args: [B("suspended")] },
  { command: "remove_track_group", desc: "Remove one Track Group definition without deleting its tracks", args: [S("groupId")] },
  // ── song sections (Intro/Verse/Hook/…) — scope handles for "rework the hook" ──
  { command: "create_section", desc: "Add a named song section using quarter-note beat offsets from project start — never seconds (in 4/4, bar 1 to bar 5 is startBeat 0 to endBeat 16)", args: [S("name"), N("startBeat"), N("endBeat"), S("color", false)] },
  { command: "rename_section", desc: "Rename a song section", args: [S("sectionId"), S("name")] },
  { command: "move_section", desc: "Move/resize a song section using quarter-note beat offsets from project start — never seconds", args: [S("sectionId"), N("startBeat"), N("endBeat")] },
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
  { command: "move_clip", desc: "Move a clip to a new start time (and optionally another track) — ripple:true makes same-track neighbors follow by the same distance", args: [S("clipId"), S("trackId", false), N("start", true, "seconds"), B("ripple", false, "shift later clips on the SAME track by the move distance; cannot be combined with trackId")] },
  // `offset` was read by cmdTrimClip (MoshOps.Clips.cpp) and sent by the drag layer
  // (ui/clipDrag.ts:58), but never declared — so the agent could not express a play-start
  // offset (which point in the SOURCE the clip starts playing from), the one thing that
  // distinguishes trimming a clip from sliding its contents.
  { command: "trim_clip", desc: "Set a clip's start and length — ripple:true makes same-track neighbors follow the moved end (close or open the gap)", args: [S("clipId"), N("start"), N("length"), B("ripple", false, "shift later clips on the SAME track by the end delta"), N("offset", false, "play-start offset into the source, seconds — slides the audio inside the clip without moving the clip")] },
  { command: "split_clip", desc: "Split a clip at a time position", args: [S("clipId"), N("time", true, "seconds")] },
  { command: "duplicate_clip", desc: "Duplicate a clip", args: [S("clipId")] },
  // ⌘J Consolidate. Takes a clipIds ARRAY — deliberately undeclared (ArgSpec has no
  // array type; the set_note "edits" convention). MIDI-only: audio consolidation is
  // a render job and the backend refuses it with a plain error.
  { command: "consolidate_clips", desc: "Merge clips into one on their track (Consolidate, ⌘J). Per TYPE: MIDI clips merge notes through the tempo map into one new clip; WAVE clips render the span through the track chain into one audio clip. A mixed MIDI+audio set is refused. One undo step. Pass clipIds (array of clip ids, one track)", args: [] },
  // ⇧⌘J Crop Clip. clipIds is an ARRAY — deliberately undeclared like consolidate's
  // (ArgSpec has no array type). The range is explicit seconds (the agent computes
  // the span itself — there is no UI selection here).
  { command: "crop_clip", desc: "Trim clips to a time range (Crop Clip, ⇧⌘J): each clip's bounds become range ∩ clip; MIDI notes outside are removed and crossing notes clipped to the edge; audio clips edge-trim with offset adjust. One undo step. Pass clipIds (array) + start/end (seconds); errors when the range is empty, overlaps nothing, or already covers the clips", args: [N("start", true, "seconds"), N("end", true, "seconds")] },
  { command: "remove_clip", desc: "Delete a clip", args: [S("clipId")] },
  { command: "create_clip_group", desc: "Group clips so selection and compatible edits treat them as one object. Pass clipIds as an array", args: [S("name", false)] },
  { command: "ungroup_clip_group", desc: "Temporarily ungroup the active Clip Group containing this clip", args: [S("clipId")] },
  { command: "regroup_clip_group", desc: "Restore a previously ungrouped Clip Group; omit groupId to restore the most recent one", args: [S("groupId", false)] },
  { command: "rename_clip_group", desc: "Rename the Clip Group containing this clip", args: [S("clipId"), S("name")] },
  { command: "bounce_track", desc: "Offline-render a track's full output (clips through its instrument+FX chain, no master bus) to audio: mode inPlace replaces the track's clips with the render (devices stay), newTrack puts the render on a new track below (source untouched). One undo step. Refuses group/return/master tracks and empty tracks", args: [S("trackId"), S("mode", true, "inPlace | newTrack")] },
  { command: "freeze_track", desc: "Freeze a track (Live 12, ⌥⇧⌘F): render its output [0, last clip end] through its chain, replace the clips with the rendered audio, and park the devices (every plugin disabled, zero CPU). While frozen the track refuses clip-content and device edits (move/duplicate/remove stay allowed). One undo step restores the original clips + devices. Refuses group/return/master tracks, empty tracks, and already-frozen tracks", args: [S("trackId")] },
  { command: "unfreeze_track", desc: "Unfreeze a frozen track: re-enable its devices and drop the frozen marker. The rendered clips STAY (they are the track's current audio — undoing the freeze itself is how the originals return). One undo step re-freezes", args: [S("trackId")] },
  { command: "delete_time_range", desc: "Remove everything in a time span across ALL tracks (splits straddling clips at the bounds) — destructive, one per step; ripple:true closes the gap by sliding later clips left", args: [N("start", true, "seconds"), N("end", true, "seconds"), B("ripple", false, "close the gap — later clips slide left by the range length")] },
  { command: "insert_time", desc: "Open empty timeline at a point and push EVERYTHING after it later — clips on every track (split at the point), their automation, the master bus, tempo/time-signature changes, song sections, annotations and the loop. The inverse of a ripple delete; use it to make room for another 8 bars before the chorus", args: [N("start", true, "seconds"), N("duration", true, "seconds of space to open")] },
  { command: "rename_clip", desc: "Rename a clip", args: [S("clipId"), S("name")] },
  { command: "set_clip_gain", desc: "Set a clip's gain in dB", args: [S("clipId"), N("gainDb")] },
  { command: "write_clip_gain_curve", desc: "Replace one wave clip's dynamic gain envelope in ONE undoable call; points are signed seconds from the visible clip start and dB offsets from its static clip gain (-48..+6). An empty array clears it", args: [S("clipId"), S("points", true, 'JSON array of {"t":seconds,"gainDb":dB,"curve"?:-1..1} ascending in t')] },
  { command: "set_clip_mute", desc: "Mute/unmute a clip", args: [S("clipId"), B("mute")] },
  { command: "set_clip_fade", desc: "Set a clip's fade-in / fade-out (seconds)",
    args: [S("clipId"), N("fadeInSec", false, "seconds"), N("fadeOutSec", false, "seconds"),
           S("curveIn", false, "linear|convex|concave|sCurve"), S("curveOut", false, "linear|convex|concave|sCurve")] },
  { command: "set_clip_reverse", desc: "Reverse/un-reverse a wave clip's playback", args: [S("clipId"), B("reversed")] },
  { command: "set_clip_crossfade", desc: "Enable/disable auto-crossfade on a wave clip (only audible where it overlaps a neighbor on the same track)", args: [S("clipId"), B("enabled")] },
  { command: "set_clip_loop", desc: "Loop a region of a wave clip's source — enable and give the loop start/length in seconds, or disable to play straight through",
    args: [S("clipId"), B("enabled"), N("start", false, "loop start in the source, seconds (default: keep current)"),
           N("length", false, "loop length in seconds; must be > 0 when enabling (default: the clip's length)")] },
  { command: "normalize_clip", desc: "Non-destructively set a wave clip's gain so its peak sample hits a target dB (default 0 dB)", args: [S("clipId"), N("targetDb", false, "dB, default 0")] },
  { command: "stretch_clip", desc: "Time-stretch a wave clip (warp) to a target length in seconds OR a bar count — e.g. make this loop fill 4 bars", args: [S("clipId"), N("length", false, "target warped length, seconds"), N("bars", false, "target length in bars")] },
  { command: "set_clip_warp", desc: "Toggle a wave clip's auto-tempo warp so it time-stretches to follow the tempo map continuously (vs stretch_clip's one-shot fit) — detect:true estimates the loop's own BPM and locks it to the grid", args: [S("clipId"), B("autoTempo", true, "on/off"), N("sourceBpm", false, "the loop's own BPM; omit to use the map tempo (a 1:1 no-op) or detect"), B("detect", false, "estimate the loop's BPM from its audio and lock it to the grid"), S("mode", false, "time-stretch mode name; omit for the default")] },
  { command: "detect_clip_bpm", desc: "Estimate the BPM of a wave clip's audio (read-only)", args: [S("clipId")] },
  { command: "transcribe_clip", desc: "Transcribe a wave clip's audio into a new, time-aligned MIDI clip (pitch detection)", args: [S("clipId"), S("mode", false, '"mono" (default) | "poly"'), B("wait", false)] },

  // ── embodied capture (Sketch, Phase 0) ───────────────────────────────────
  { command: "sketch_beatbox", desc: "Transduce a recorded beatbox WAV into an editable drum clip at a known BPM (kick/snare/hat on a 16th grid)", args: [S("file", true, "path to the beatbox WAV"), N("bpm", true, "known tempo"), N("bars", false, "loop length, 1-2 bars")] },

  // ── MIDI notes ──────────────────────────────────────────────────────────
  { command: "add_note", desc: "Add a MIDI note (pitch 0-127) to a MIDI clip", args: [S("clipId"), N("pitch"), N("start", true, "beats"), N("length", true, "beats"), N("velocity", false, "0-127")] },
  { command: "remove_note", desc: "Remove a MIDI note by index", args: [S("clipId"), N("noteIndex")] },
  // NOTE: set_note also accepts "mute" (deactivate a note) and an "edits" array (a whole
  // selection in one undoable command). Both are deliberately UNDECLARED here: arrays are
  // unrepresentable in ArgSpec, and widening this entry would move the SFT/bench prompt
  // hash for a capability the agent does not need. add_midi_clip does the same with its
  // own notes array. The contract test checks that declared args are read, not the
  // converse, so this is legal and intentional.
  // (Careful editing comments in this file: service/skills/moshops_catalog.py parses it
  // WITHOUT stripping comments, and treats a lone apostrophe as opening a string literal,
  // so an unpaired quote here breaks catalog parity with a confusing "unbalanced" error.)
  { command: "set_note", desc: "Edit a MIDI note's pitch/start/length/velocity", args: [S("clipId"), N("noteIndex"), N("pitch", false), N("start", false), N("length", false), N("velocity", false)] },
  { command: "quantize_notes", desc: "Quantize a MIDI clip's notes to a grid, optionally with swing", args: [S("clipId"), N("division", false, "beats: 1=1/4, 0.5=1/8, 0.25=1/16"), N("strength", false, "0-1"), N("swing", false, "0-100, 0 = straight (default). Delays every 2nd subdivision and leaves the on-beats put; 100 = the MPC 75% ceiling, i.e. MPC% = 50 + swing/4, so a triplet feel is ~67")] },
  { command: "resolve_note_overlaps", desc: "Repair legacy same-pitch overlaps in one MIDI clip. Notes are processed deterministically by start and existing index; each later note wins. Chords and other clips are untouched. One undo step", args: [S("clipId")] },
  // Live 12's velocity tool row, one undo step, deterministic-seeded randomness.
  { command: "transform_velocities", desc: "Velocity tools for a MIDI clip: mode randomize/deviate = uniform ±amount around each target note's velocity; mode ramp = linear lo→hi across the targets in time order (ties by pitch). Targets = noteIndexes array (clip-local indices) or ALL notes when omitted. One undo step; randomness is deterministic-seeded per command", args: [S("clipId"), S("mode", true, "randomize | ramp | deviate"), N("amount", false, "±velocity, randomize/deviate"), N("lo", false, "ramp start velocity 1-127"), N("hi", false, "ramp end velocity 1-127")] },
  // Live 12's Transform tools row, one undo step; deterministic modes work inside
  // the TARGETS' own span (a selection transforms within the selection's span).
  { command: "transform_notes", desc: "Transform tools for a MIDI clip: reverse = mirror note starts/ends inside the targets' span (pitches/lengths kept); invert = flip pitches around the highest target pitch; legato = extend each note to the next distinct onset, last group to the span end; x2/d2 = double/halve starts relative to the span start AND lengths; humanize = small random timing (±amount% of a 16th) + velocity (±amount) deviation, deterministic-seeded per command; setLength = set every target's length to lengthBeats (starts unchanged); addInterval = add a chord tone at +semitones (signed) above each target — duplicates (same pitch already sounding at the same start, unison clamps) are skipped, sources never mutated, reports 'added'; fitToScale = snap each target pitch to the session key (nearest in-scale, ties downward). Targets = noteIndexes array (clip-local indices) or ALL notes when omitted. One undo step", args: [S("clipId"), S("mode", true, "reverse | invert | legato | humanize | x2 | d2 | setLength | addInterval | fitToScale"), N("amount", false, "0-100, humanize only (Live's 10% default)"), N("lengthBeats", false, "setLength: beats > 0"), N("semitones", false, "addInterval: signed semitone offset")] },
  { command: "add_drum_pattern", desc: "Lay a whole drum grid in ONE undoable step from lane strings — 'x' hit, 'X' accent, '.'/'-' rest, '|' cosmetic; lanes kick/snare/clap/hat/openhat/lowtom/midtom/crash or a raw MIDI pitch; short lanes tile (\"x.\" = 8th hats)", args: [S("pattern", true, 'lane map: "kick: x...x...x...x...; snare: ....x.......x..."'), S("trackId", false, "target track — omit to create a new Drums track"), S("clipId", false, "existing MIDI clip: replaces ONLY the lanes named (trackId ignored)"), N("stepsPerBar", false, "1-64, default 16"), N("bars", false, "1-16, default fits the longest lane"), N("velocity", false, "1-127 for 'x' hits, default 100"), N("start", false, "seconds — new-clip position")] },
  { command: "set_drum_lane", desc: "Mute/solo one drum pad lane on a drum track, by MIDI note", args: [S("trackId"), N("note", true, "MIDI pitch 0-127 — the pad"), B("mute", false), B("solo", false)] },
  { command: "set_drum_pad", desc: "Set one drum pad's level, pan, name or choke group (pads in a group cut each other off, e.g. a closed hat silencing an open one)", args: [S("trackId"), N("note", true, "MIDI pitch 0-127 — the pad"), N("gainDb", false, "-48..+48"), N("pan", false, "-1..1"), S("name", false), N("chokeGroup", false, "1-16, or 0 for none")] },
  { command: "list_drum_kits", desc: "List the drum kits available to load (read-only)", args: [] },
  { command: "apply_choke", desc: "Bake the choke groups on a drum track into note lengths for this clip, so playback and export obey them too (a closed hat cuts an open one). Shortens notes; undoable", args: [S("clipId")] },
  { command: "clear_drum_pad", desc: "Empty one drum pad, removing its sample (assign_sample can only replace)", args: [S("trackId"), N("note", true, "MIDI pitch 0-127 — the pad")] },

  // ── transport & timing ──────────────────────────────────────────────────
  { command: "set_tempo", desc: "Set the project tempo in BPM", args: [N("bpm")] },
  { command: "insert_tempo_change", desc: "Add a tempo-map point beyond the base tempo (speed the song up/down partway through) — the point's curve shapes the span from IT to the NEXT point", args: [N("time", true, "seconds"), N("bpm", true, "20-999"), N("curve", false, "1 = step (default); values in (-1,1) ramp: <0 log, 0 linear, >0 exponential")] },
  { command: "remove_tempo_change", desc: "Remove a tempo-map point by index from session.tempoMap — index 0 is the base tempo (edit that via set_tempo, never remove it)", args: [N("index", true, "1..N-1 from session.tempoMap")] },
  { command: "set_time_signature", desc: "Set the time signature", args: [N("numerator"), N("denominator")] },
  // CAP-TRN-005: a partial patch — every arg is optional and an absent one is left alone.
  // `enabled` is no longer required (it used to be the only arg, so an omitted one meant
  // "off"; now a call naming nothing at all is an error instead of a silent mute).
  // NOTE: set_metronome also accepts outputDevice, soundBig, soundSmall, midiNoteBig and
  // midiNoteSmall. Those are deliberately UNDECLARED here for the same reason set_note's
  // `edits` array is: they take device names and WAV paths that only the machine in front
  // of the producer knows, and the agentic loop never shows the model a list_audio_devices
  // payload to learn them from, so declaring them would only invite invented paths. They
  // are fully reachable by mouse in the v2 metronome panel. The contract test checks that
  // declared args are read, not the converse, so this is legal and intentional.
  { command: "set_metronome", desc: "Metronome click: turn it on/off, set its level, accent the downbeat, or make it audible only while recording", args: [B("enabled", false), N("level", false, "linear gain 0-1; the engine clamps to 0.2-1.0, so 0 is not silence — turn it off instead"), B("emphasizeBars", false, "accent the first beat of each bar"), B("recordingOnly", false, "only audible while recording")] },
  { command: "set_key", desc: "Set the project musical key", args: [S("tonic", false, "C, C#, D … B"), S("mode", false, "major | minor | dorian | mixolydian | pentatonic | chromatic")] },
  { command: "set_count_in", desc: "Set the count-in / pre-roll before recording (0=off, 1=one bar, 2=two bars) — an audible click plays through the pre-roll before capture starts", args: [N("bars", true, "0, 1, or 2")] },
  // loopStart/loopEnd were read by cmdSetTransport (MoshOps.TempoProject.cpp:82-84) but never
  // declared, so the agent could switch looping ON and had no way to say WHERE — and the handler
  // only sets the range when BOTH are present, making "loop the first 4 bars" unreachable. The UI
  // has always sent them (v2/timeline/TimeRangeBand.tsx:60, menuActions.ts:314).
  { command: "set_transport", desc: "Transport: play/stop/record/seek, and the loop region", args: [S("action", false, '"play"|"toggle"|"stop"|"record"|"to_start"|"to_end"'), B("loop", false), N("position", false, "seconds"), N("loopStart", false, "loop region start in seconds — send WITH loopEnd"), N("loopEnd", false, "loop region end in seconds — send WITH loopStart")] },

  // ── recording / takes ─────────────────────────────────────────────────────
  { command: "arm_track", desc: "Arm/disarm a track's input for recording", args: [S("trackId"), B("armed")] },
  { command: "stop_recording", desc: "Stop recording and land the take", args: [B("discardRecordings", false)] },
  { command: "set_record_options", desc: "How a live MIDI take behaves: overdub (merge into the clip it lands on) vs replace, record-quantise to a grid, and punch (capture only inside the loop range)", args: [B("overdub", false), B("replaceExisting", false), N("quantize", false, "beats, 0=off — same grid as quantize_notes"), B("punchInOut", false), N("retrospectiveSeconds", false, "0-60, how far back Capture can reach")] },
  { command: "set_input_monitor", desc: "Set a track's input monitoring", args: [S("trackId"), S("mode", false, '"off"|"automatic"|"on"')] },
  { command: "list_takes", desc: "List the take lanes on a clip", args: [S("clipId")] },
  { command: "set_current_take", desc: "Select which take lane is active", args: [S("clipId"), N("takeIndex")] },
  { command: "promote_take_region", desc: "Promote one time range from an alternate take into the main playlist; splits the clip at the range boundaries and preserves every take", args: [S("clipId"), N("takeIndex"), N("start", true, "absolute timeline seconds"), N("end", true, "absolute timeline seconds")] },
  { command: "keep_take", desc: "Keep a take lane, remove the rest — pass takeId to target a specific stable take id, or omit it to keep whichever take is already current", args: [S("clipId"), S("takeId", false, "optional stable take id (from list_takes); omit to keep whichever take is current")] },

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
  { command: "add_send", desc: "Add a send from a track to a bus (bus number from snapshot.buses[])", args: [S("trackId"), N("bus", true, "the bus number"), N("db", false, "send level in dB, -60…6"), B("mute", false), N("pan", false, "send balance -1…1"), B("preFader", false)] },
  { command: "set_send_level", desc: "Set a track's send level to a bus in dB", args: [S("trackId"), N("bus"), N("db")] },
  { command: "set_send_mute", desc: "Mute or unmute a track's send without changing its level", args: [S("trackId"), N("bus"), B("mute")] },
  { command: "set_send_pan", desc: "Set stereo balance for one send branch (-1 left … 1 right)", args: [S("trackId"), N("bus"), N("pan")] },
  { command: "set_send_pre_fader", desc: "Place a send before or after the track fader", args: [S("trackId"), N("bus"), B("preFader")] },
  { command: "remove_send", desc: "Remove a track's send to a bus", args: [S("trackId"), N("bus")] },
  { command: "remove_bus", desc: "Remove an aux/return bus (sweeps any sends pointing at it)", args: [N("bus", true, "the bus number")] },
  { command: "rename_bus", desc: "Rename an aux/return bus", args: [N("bus", true, "the bus number"), S("name")] },

  // ── track output routing ─────────────────────────────────────────────────
  { command: "list_track_outputs", desc: "List available track-output destinations — hardware outs + tracks (read-only)", args: [] },
  { command: "set_track_output", desc: "Route a track's output — into another track (a submix), to a hardware device, or back to 'default'", args: [S("trackId"), S("destTrackId", false, "route into this track instead of the master"), S("deviceID", false, "route to a hardware output device (from list_track_outputs)"), S("output", false, "'default' resets to normal master routing")] },

  // ── plugins ─────────────────────────────────────────────────────────────
  { command: "list_builtins", desc: "List the built-in effects/instruments with their display names + categories (read-only) — you do NOT need this to load one, the 'type' names are already listed on load_builtin", args: [] },
  { command: "list_plugins", desc: "List the scanned VST3/AU plugins available to load (read-only) — the 'pluginId' names load_plugin/load_master_plugin take", args: [] },
  { command: "load_builtin", desc: "Add a built-in effect/instrument to a track. type is EXACTLY one of: 4osc, sampler, 4bandEq, compressor, reverb, delay, chorus, phaser, lowpass, pitchShifter, moshAutoTune, moshOTT, moshXFeedback (an EQ is \"4bandEq\" — \"eq\" is rejected)", args: [S("trackId"), N("index", false, "chain position"), S("type")] },
  { command: "set_track_type", desc: "Set a track's type — 'drum' loads the working sampler + drum kit so its MIDI notes are audible", args: [S("trackId"), S("type", true, '"audio" | "drum"')] },
  { command: "load_drum_kit", desc: "Load the built-in drum kit onto a track's sampler (kick/snare/clap/hats/toms/crash) — omit kit for the bundled default", args: [S("trackId"), S("kit", false, "kit id from list_drum_kits")] },
  { command: "assign_sample", desc: "Map an audio file to a track's sampler: mode 'drum' (default, one-shot pad at one note) or 'melodic' (a pitched 808/bass played across the keyboard, note-length gated)", args: [S("trackId"), N("note", true, "MIDI pitch 0-127: the pad (drum) or the sample's root note (melodic)"), S("file", true, "audio file path"), S("name", false, "pad label"), N("gainDb", false), S("mode", false, "'drum' (default) or 'melodic'")] },
  { command: "load_plugin", desc: "Add a scanned VST3/AU plugin to a track (pluginId from list_plugins). An INSTRUMENT is refused on a track holding audio clips (silent-by-construction) — use an instrument track. replaceInstrument:true hot-swaps an incoming instrument for the track's current one (same slot, one undo step) instead of stacking", args: [S("trackId"), S("pluginId"), N("index", false, "chain position"), B("replaceInstrument", false, "incoming instrument replaces the track's existing one instead of appending")] },
  { command: "set_plugin_param", desc: "Set a plugin parameter (0-1) by chain index + param index", args: [S("trackId"), N("index"), N("paramIndex"), N("value", true, "0-1")] },
  { command: "bypass_plugin", desc: "Bypass/enable a plugin in a track's chain", args: [S("trackId"), N("index"), B("bypassed")] },
  { command: "reorder_plugin", desc: "Move a plugin to a new chain position", args: [S("trackId"), N("index"), N("toIndex")] },
  { command: "open_plugin_editor", desc: "Pop out a plugin's native editor window", args: [S("trackId"), N("index")] },
  { command: "remove_plugin", desc: "Remove a plugin from a track's chain", args: [S("trackId"), N("index")] },

  // ── master-bus plugins (limiter, bus EQ, …) — same commands as above, one level up ──
  { command: "load_master_plugin", desc: "Add a scanned VST3/AU plugin to the master bus (pluginId from list_plugins)", args: [S("pluginId"), N("index", false, "chain position")] },
  { command: "load_master_builtin", desc: "Add a built-in effect to the master bus — same 'type' vocabulary as load_builtin (glue compressor = \"compressor\", bus EQ = \"4bandEq\")", args: [S("type"), N("index", false, "chain position")] },
  { command: "set_master_plugin_param", desc: "Set a master-bus plugin parameter (0-1) by chain index + param index", args: [N("index"), N("paramIndex"), N("value", true, "0-1")] },
  { command: "bypass_master_plugin", desc: "Bypass/enable a plugin on the master bus", args: [N("index"), B("bypassed")] },
  { command: "reorder_master_plugin", desc: "Move a master-bus plugin to a new chain position", args: [N("index"), N("toIndex")] },
  { command: "open_master_plugin_editor", desc: "Pop out a master-bus plugin's native editor window", args: [N("index")] },
  { command: "remove_master_plugin", desc: "Remove a plugin from the master bus", args: [N("index")] },

  // ── export ──────────────────────────────────────────────────────────────
  { command: "export_audio", desc: "Render the whole mix down to an audio file", args: [S("file", false, "destination path, defaults under the session"), S("format", false, '"wav" (default) | "aiff" | "flac"'), N("bitDepth", false), N("sampleRate", false), S("renderMode", false, '"auto" (default) | "fast" | "realtime"'), S("range", false, '"full" (default) | "loop" | "custom"'), N("start", false, "seconds — with range:\"custom\""), N("end", false, "seconds — with range:\"custom\""), S("tail", false, '"cut" (default) | "include" — carry a reverb/delay tail past the end'), N("tailSeconds", false, "with tail:\"include\", default 2")] },
  { command: "export_stems", desc: "Render every track to its own audio file (stems) into a directory", args: [S("dir", false, "destination directory, defaults under the session"), S("format", false, '"wav" (default) | "aiff" | "flac"'), N("bitDepth", false), N("sampleRate", false), S("renderMode", false, '"auto" (default) | "fast" | "realtime"'), B("includeEmpty", false, "write silent stems for empty tracks too")] },
  // ── parameter automation ───────────────────────────────────────────────────
  { command: "add_automation_point", desc: "Add a point to a plugin parameter's automation curve", args: [S("trackId"), N("pluginIndex"), N("paramIndex"), N("time", true, "seconds"), N("value", true, "0-1")] },
  { command: "remove_automation_point", desc: "Remove a point from a plugin parameter's automation curve by index", args: [S("trackId"), N("pluginIndex"), N("paramIndex"), N("pointIndex")] },
  { command: "set_automation_point", desc: "Move an automation point to a new time/value", args: [S("trackId"), N("pluginIndex"), N("paramIndex"), N("pointIndex"), N("time", false, "seconds"), N("value", false, "0-1")] },
  { command: "clear_automation", desc: "Clear all automation points on a plugin parameter", args: [S("trackId"), N("pluginIndex"), N("paramIndex")] },
  { command: "set_track_automation_mode", desc: "Arm a track's automation recording mode — write mode captures a point on every plugin-param change on that track from here on (touch/latch are accepted but currently inert, v0)", args: [S("trackId"), S("mode", true, '"read" | "touch" | "latch" | "write"')] },
  { command: "write_automation_curve", desc: "Bulk-author a plugin parameter's automation curve in ONE undoable step — replace (default) clears the covered time span first, merge only adds", args: [S("trackId"), N("pluginIndex"), N("paramIndex"), S("points", true, 'JSON array of {"t":seconds,"v":0-1} ascending in t, e.g. \'[{"t":0,"v":0.2},{"t":2,"v":0.8}]\''), S("apply", false, '"replace" (default) | "merge"')] },

  // ── generative (Tier-B) ─────────────────────────────────────────────────
  { command: "create_render_layer", desc: "Attach a generative re-imagine layer to ANY clip — wave, MIDI or drum (MIDI/drum is auto-bounced to audio first), optionally scoped to a beat range, in seconds", args: [S("clipId"), S("adapter", false), N("regionStart", false, "scope start in seconds"), N("regionEnd", false, "scope end in seconds")] },
  { command: "set_render_param", desc: "Set a render-layer parameter (prompt/noise/seed, transform target/strength, or whole-clip coverage)", args: [S("clipId"), S("prompt", false), N("nl", false, "noise level 0-1"), N("seed", false), S("target", false, "transform target instrument or free-text"), N("strength", false, "transform strength 0-100"), S("coverage", false, '"auto"|"loop"|"stitch" — cover a long clip by tiling a cycle or stitching windows')] },
  { command: "render_layer", desc: "Run the generative render on a clip's layer", args: [S("clipId")] },
  { command: "cancel_render", desc: "Cancel a clip's in-progress render job", args: [S("clipId"), S("jobId", false)] },
  { command: "compile_render", desc: "Compile a loose instruction (\"make it lo-fi\", \"as a violin\") into a validated generative render on a clip — auto-picks re-imagine vs transform and fills prompt/colours/noise or target/strength; corrective (fix/tune) or vocal requests are honestly declined", args: [S("clipId"), S("instruction"), N("intensity", false, "0-100, how strong"), B("autoRender", false, "render immediately after compiling")] },
  { command: "accept_render", desc: "Accept a finished render (MIDI/drum: lands it as a clip; wave clips auto-apply in place, so this is a no-op for them)", args: [S("clipId")] },
  { command: "reject_render", desc: "Reject a render", args: [S("clipId")] },
  { command: "reset_render_layer", desc: "Restore a wave clip's ORIGINAL audio (undo the in-place re-imagine; the layer stays so you can re-render)", args: [S("clipId")] },
  { command: "bypass_layer", desc: "Bypass/enable a clip's render layer", args: [S("clipId"), B("bypassed")] },
  { command: "freeze_layer", desc: "Freeze a clip's render layer: keep the rendered audio and stop re-rendering it on every edit", args: [S("clipId")] },
  { command: "unfreeze_layer", desc: "Thaw a frozen render layer so edits auto-re-render it again", args: [S("clipId")] },
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
  { command: "reject_lyric_proposal", desc: "Reject a line's generated proposals (clears them; logs a negative taste label)", args: [S("trackId"), N("lineIndex")] },
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
    // AGT-MEM (M3) — remember_preference is a PSEUDO-command (never in
    // AGENT_COMMANDS/the catalog — see memory/rememberPreference.ts), but the
    // executor still routes its intercepted result through the SAME entries/results
    // arrays as a real command, so it needs a real summary here too (the generic
    // command.replace(/_/g," ") fallback would just say "remember preference",
    // dropping the actual remembered text).
    case "remember_preference": return `Remembered: "${a.text ?? ""}"`;
    case "create_track": return `Added ${a.type === "drum" ? "drum " : ""}track${a.name ? ` "${a.name}"` : ""}`;
    case "rename_track": return `Renamed track to "${a.name}"`;
    case "set_track_color": return a.color ? `Recoloured a track ${a.color}` : `Cleared a track's colour`;
    case "set_track_icon": return a.icon ? `Set a track's icon to ${a.icon}` : `Cleared a track's icon`;
    case "move_track": return `Moved a track to position ${a.toIndex}`;
    case "remove_track": return `Removed a track`;
    case "set_track_active": return a.active ? `Made a track active` : `Made a track inactive`;
    case "create_track_group": return `Created Track Group${a.name ? ` "${a.name}"` : ""}`;
    case "configure_track_group": return `Configured Track Group "${a.name}"`;
    case "duplicate_track_group": return `Duplicated a Track Group as "${a.name}"`;
    case "set_track_group_members": return `Changed Track Group members`;
    case "set_track_group_enabled": return a.enabled ? `Enabled a Track Group` : `Disabled a Track Group`;
    case "set_track_groups_suspended": return a.suspended ? `Suspended Track Groups` : `Resumed Track Groups`;
    case "remove_track_group": return `Removed a Track Group`;
    case "add_test_tone_clip": return `Added a test tone`;
    case "import_clip": return `Imported audio ${a.file ? String(a.file).split("/").pop() : "clip"}${a.startSeconds ? ` at ${a.startSeconds}s` : ""}`;
    case "add_midi_clip": return `Added a MIDI clip`;
    case "move_clip": return `Moved a clip to ${a.start}s${a.ripple ? " and carried its later neighbours" : ""}`;
    case "trim_clip": return `Trimmed a clip`;
    case "split_clip": return `Split a clip at ${a.time}s`;
    case "duplicate_clip": return `Duplicated a clip`;
    case "remove_clip": return `Removed a clip`;
    case "create_clip_group": return `Created Clip Group${a.name ? ` "${a.name}"` : ""}`;
    case "ungroup_clip_group": return `Ungrouped a Clip Group`;
    case "regroup_clip_group": return `Regrouped a Clip Group`;
    case "rename_clip_group": return `Renamed a Clip Group to "${a.name}"`;
    case "delete_time_range": return `Cleared ${a.start}–${a.end}s across all tracks${a.ripple ? " and closed the gap" : ""}`;
    case "insert_time": return `Opened ${a.duration}s of space at ${a.start}s — everything after it moved later`;
    case "rename_clip": return `Renamed a clip to "${a.name}"`;
    case "set_clip_gain": return `Set clip gain to ${a.gainDb} dB`;
    case "write_clip_gain_curve": return `Wrote a dynamic clip gain envelope`;
    case "set_clip_mute": return a.mute ? `Muted a clip` : `Unmuted a clip`;
    case "set_clip_fade": return `Set clip fades (in ${a.fadeInSec ?? "–"}s, out ${a.fadeOutSec ?? "–"}s)`;
    case "set_clip_reverse": return a.reversed ? `Reversed a clip` : `Un-reversed a clip`;
    case "set_clip_crossfade": return a.enabled ? `Enabled auto-crossfade on a clip` : `Disabled auto-crossfade on a clip`;
    case "set_clip_loop": return a.enabled ? `Looped a clip region (${a.length ?? "–"}s from ${a.start ?? 0}s)` : `Turned off a clip's loop`;
    case "normalize_clip": return `Normalized a clip${a.targetDb != null ? ` to ${a.targetDb} dB` : ""}`;
    case "stretch_clip": return a.bars ? `Stretched a clip to ${a.bars} bar${Number(a.bars) > 1 ? "s" : ""}` : `Stretched a clip to ${a.length}s`;
    case "set_clip_warp": return a.autoTempo ? `Warped a clip to follow the tempo${a.detect ? " (detected its BPM)" : ""}` : `Turned off a clip's warp`;
    case "detect_clip_bpm": return `Detected a clip's BPM`;
    case "sketch_beatbox": return `Turned a beatbox into a drum clip`;
    case "add_note": return `Added a note`;
    case "add_drum_pattern": return `Laid a drum pattern`;
    case "remove_note": return `Removed a note`;
    case "set_note": return `Edited a note`;
    case "quantize_notes": return `Quantized notes${a.division != null ? ` (${a.division}-beat grid)` : ""}`;
    case "set_tempo": return `Set tempo to ${a.bpm} BPM`;
    case "insert_tempo_change": return `Added a tempo change to ${a.bpm} BPM at ${a.time}s`;
    case "remove_tempo_change": return `Removed a tempo change`;
    case "set_time_signature": return `Set time signature to ${a.numerator}/${a.denominator}`;
    // CAP-TRN-005 — `enabled` is now optional, so "not true" no longer means "turned it
    // off": a level-only or emphasis-only call has to summarize as what it actually did.
    case "set_metronome": {
      if (a.enabled != null) return a.enabled ? `Turned the metronome on` : `Turned the metronome off`;
      if (a.level != null) return `Set the metronome level to ${Math.round(Number(a.level) * 100)}%`;
      if (a.emphasizeBars != null) return a.emphasizeBars ? `Accented the metronome's downbeat` : `Stopped accenting the metronome's downbeat`;
      if (a.recordingOnly != null) return a.recordingOnly ? `Metronome now clicks only while recording` : `Metronome now clicks all the time`;
      return `Changed the metronome settings`;
    }
    case "set_key": return `Set key to ${a.tonic ?? ""} ${a.mode ?? ""}`.trim();
    case "set_count_in": return Number(a.bars) > 0 ? `Set a ${a.bars}-bar count-in` : `Turned the count-in off`;
    case "set_transport": return a.action === "record" ? `Recording` : a.action === "stop" ? `Stopped` : a.action === "to_start" ? `Back to the start` : `Transport`;
    case "arm_track": return a.armed ? `Armed a track` : `Disarmed a track`;
    case "stop_recording": return `Stopped recording`;
    case "set_record_options": return a.overdub !== undefined ? (a.overdub ? `Recording in overdub` : `Recording replaces`) : `Set the recording options`;
    case "set_input_monitor": return `Set input monitoring`;
    case "list_takes": return `Listed the takes`;
    case "set_current_take": return `Switched to take ${a.takeIndex}`;
    case "promote_take_region": return `Promoted take ${a.takeIndex} from ${a.start}–${a.end}s`;
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
    case "set_send_mute": return a.mute ? `Muted send to bus ${a.bus}` : `Unmuted send to bus ${a.bus}`;
    case "set_send_pan": return `Set send to bus ${a.bus} pan to ${a.pan}`;
    case "set_send_pre_fader": return `Set send to bus ${a.bus} ${a.preFader ? "pre" : "post"}-fader`;
    case "remove_send": return `Removed a send to bus ${a.bus}`;
    case "list_builtins": return `Listed the built-in effects`;
    case "list_plugins": return `Listed the available plugins`;
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
    case "load_master_plugin": return `Added a plugin to the master bus`;
    case "load_master_builtin": return `Added ${a.type} to the master bus`;
    case "set_master_plugin_param": return `Tweaked a master-bus plugin parameter`;
    case "bypass_master_plugin": return a.bypassed ? `Bypassed a master-bus plugin` : `Enabled a master-bus plugin`;
    case "reorder_master_plugin": return `Reordered a master-bus plugin`;
    case "open_master_plugin_editor": return `Opened a master-bus plugin editor`;
    case "remove_master_plugin": return `Removed a master-bus plugin`;
    case "add_automation_point": return `Added an automation point`;
    case "remove_automation_point": return `Removed an automation point`;
    case "set_automation_point": return `Moved an automation point`;
    case "clear_automation": return `Cleared automation`;
    case "set_track_automation_mode": return `Set automation mode to ${String(a.mode ?? "read")}`;
    case "write_automation_curve": return `Wrote an automation curve`;
    case "create_render_layer": return `Attached a generative layer`;
    case "set_render_param": return `Set a render parameter`;
    case "compile_render": return `Compiled a generative render`;
    case "render_layer": return `Started a render`;
    case "accept_render": return `Accepted a render`;
    case "reject_render": return `Rejected a render`;
    case "bypass_layer": return a.bypassed ? `Bypassed a render layer` : `Enabled a render layer`;
    case "freeze_layer": return `Froze a render layer`;
    case "unfreeze_layer": return `Thawed a render layer`;
    case "bounce_layer_to_clip": return `Bounced a layer to a clip`;
    case "remove_render_layer": return `Removed a render layer`;
    default: return command.replace(/_/g, " ");
  }
}
