// The DELIBERATE classification of every native MoshOps command the agent
// catalog does NOT expose. Paired with AGENT_COMMANDS, this partitions the whole
// dispatch table: the contract test (commands.contract.test.ts) fails the build
// if a new native command ships without landing in exactly one of the two —
// so "the agent can't reach X" is always a decision with a written reason, never
// an accident.
//
// Reviewed artifact, not test-local data. One entry = one command → one-line
// reason. Keep entries grouped by family; delete an entry when its command is
// promoted into AGENT_COMMANDS (the no-overlap test enforces exactly-one home).

export const UI_ONLY_COMMANDS: Readonly<Record<string, string>> = {
  // ── project I/O & session lifecycle — the agent must never lose work ──────────
  new_project: "replaces the open project — project-lifecycle decisions stay with the producer",
  open_project: "replaces the open project — project-lifecycle decisions stay with the producer",
  open_recent: "replaces the open project — project-lifecycle decisions stay with the producer",
  save_as: "picks a filesystem destination — a file-picker decision, not a musical move (plain save IS agent-callable)",
  reload: "discards unsaved changes back to the last save — a data-loss gate that stays human",
  recover_session: "crash-recovery acceptance is an explicit human decision",
  discard_recovery: "throwing away a recovery point is an explicit human decision",
  relink_clip: "repairs a broken source-file reference — file-path surgery, not a musical move",
  import_clip_data: "carries a base64 clip payload (multiplayer/clipboard plumbing) — unrepresentable in ArgSpec",
  paste_clip: "object-typed 'clip' descriptor unrepresentable in ArgSpec (and the SFT parser's S/N/B set); agent equivalent = duplicate_clip + move_clip",

  // ── device / settings / scan admin — needs user acknowledgment ────────────────
  set_audio_device: "audio-device selection is session admin the producer must acknowledge",
  set_buffer_size: "buffer-size changes are session admin the producer must acknowledge",
  set_audio_threads: "thread-count tuning is session admin the producer must acknowledge",
  set_project_settings: "project-level settings dialog plumbing, not a musical move",
  set_track_input: "physical input routing is set from the track's input picker with the device list in view",
  rescan_plugins: "the plugin scan is a slow, blocking maintenance op driven from the settings UI",
  block_plugin: "the crash-blacklist is a safety console the producer manages",
  clear_plugin_blocklist: "the crash-blacklist is a safety console the producer manages",
  get_plugin_blocklist: "read-only feed for the blacklist settings panel",
  list_audio_devices: "device discovery feeding the settings UI — the agent's session context is the snapshot",
  list_midi_inputs: "device discovery feeding the input picker UI",
  list_wave_inputs: "device discovery feeding the input picker UI",
  list_directory: "filesystem browsing is the file-picker's job; agent file access is by explicit path args",

  // ── executor/undo plumbing — owned by the harness, never the model ────────────
  batch_begin: "the executor opens/closes the agent's own undo batches — the model never manages transactions",
  batch_end: "the executor opens/closes the agent's own undo batches — the model never manages transactions",
  get_command_log: "read-only log inspector (CommandLog panel + taste distillation), not a musical tool",

  // ── metering — UI-local presentation config ───────────────────────────────────
  enable_all_meters: "metering config is presentation state, self-healed by the engine (METER-001)",
  enable_track_meter: "metering config is presentation state, self-healed by the engine (METER-001)",
  disable_track_meter: "metering config is presentation state, self-healed by the engine (METER-001)",

  // ── read-only media plumbing — presentation data the model can't use ──────────
  get_clip_peaks: "waveform peak arrays for canvas drawing — meaningless to the model",
  file_peaks: "waveform peak arrays for the file browser — meaningless to the model",
  audition_file: "pre-import audition is a listening affordance; the agent can't hear it",
  stop_audition: "pre-import audition is a listening affordance; the agent can't hear it",

  // ── generative machinery the agent reaches through higher-level commands ──────
  add_render_layer: "the raw Stage-1 layer primitive — the agent uses create_render_layer (auto-bounce + region scoping)",
  list_colors: "style vocab feeding the drawer UI; the agent styles via compile_render, which validates colours itself",
  list_transform_targets: "style vocab feeding the drawer UI; the agent styles via compile_render, which validates targets itself",
  generate_beat_recipe: "service-spawning recipe generator wired to a UI flow (would freeze the message thread mid-turn); the agent composes via add_drum_pattern/add_note",
  render_ahead_arm: "Live render-ahead scheduling is transport-coupled machinery driven by the playhead, not a per-turn command",
  render_ahead_tick: "Live render-ahead scheduling is transport-coupled machinery driven by the playhead, not a per-turn command",

  // ── lyrics plumbing with a human gate or a UI-owned lifecycle ─────────────────
  build_lyrics_from_clip: "the words-based (Whisper) mumble variant is a UI right-click flow; the agent's take-to-flow path is build_skeleton_from_clip",
  confirm_skeleton: "the human-in-the-loop grid gate — flow approval stays with the producer",
  cancel_lyric_job: "cancels an in-flight UI job — the panel owns lyric-job lifecycle",
  remove_lyric_sheet: "deletes a whole sheet behind a UI confirm; the agent edits/removes lines instead",
  get_lyric_corpus_stats: "UI cue ('N lines in your voice') — service-health-gated, no musical content",

  // ── AGT-MEM (Phase-B memory lane, M1) — native store; no in-turn agent tool yet ──
  // The store is the FOUNDATION a later memory-retrieval pass (M2+) reads FROM to
  // enrich the system prompt automatically — not a tool the model calls mid-turn.
  // Exposing raw read/write to the model now would let it silently self-modify its
  // own future context with no retrieval/ranking/dedup layer in front of it yet.
  agent_memory_read: "M1 ships the native store only — read access is for a future retrieval pass (M2+) to inject into the system prompt, not a mid-turn agent tool",
  agent_memory_write: "M1 ships the native store only — the agent-initiated write path is the serve-time-documented remember_preference PSEUDO-command (memory/rememberPreference.ts), intercepted by the executor before dispatch — never the raw command in the static catalog (SFT prompts stay byte-stable). See MEMORY_COMMANDS in commands.contract.test.ts.",
  agent_memory_delete: "M3 ships the memory-drawer's per-item delete only — a direct producer-driven prune action (no confirm needed at single-item scope; agent_memory_clear is the confirm-gated one), never a model tool",
  agent_memory_clear: "M3 ships the memory-drawer's per-tier clear only — a destructive, confirm-gated producer action, never a model tool",

  // ── RAVE lab surface — model-install-gated builds only ────────────────────────
  add_rave_insert: "real-time RAVE insert is a model-install-gated lab surface (MOSH_ENABLE_ANIRA builds)",
  load_rave_model: "real-time RAVE insert is a model-install-gated lab surface (MOSH_ENABLE_ANIRA builds)",
  list_rave_models: "real-time RAVE insert is a model-install-gated lab surface (MOSH_ENABLE_ANIRA builds)",
  set_rave_param: "real-time RAVE insert is a model-install-gated lab surface (MOSH_ENABLE_ANIRA builds)",
  reset_rave: "real-time RAVE insert is a model-install-gated lab surface (MOSH_ENABLE_ANIRA builds)",

  // ── LoRA rack + training scaffold — UI knobs and rights-gated lanes ───────────
  list_loras: "the LoRA rack is a UI knob surface; the agent styles renders via compile_render/set_render_param",
  list_lora_adapters: "the LoRA rack is a UI knob surface; the agent styles renders via compile_render/set_render_param",
  import_lora_adapter: "adapter installation is an owner action, never agent-driven",
  activate_lora_adapter: "the LoRA rack is a UI knob surface; the agent styles renders via compile_render/set_render_param",
  import_training_source: "training scaffold is rights-gated — never agent-operable",
  approve_training_source: "training scaffold is rights-gated — never agent-operable",
  list_training_sources: "training scaffold is rights-gated — never agent-operable",
  build_training_corpus: "training scaffold is rights-gated — never agent-operable",
  submit_training_job: "training scaffold is rights-gated — never agent-operable",
  cancel_training_job: "training scaffold is rights-gated — never agent-operable",
  training_job_status: "training scaffold is rights-gated — never agent-operable",

  // ── multiplayer sync — relay-layer plumbing, not user intent ──────────────────
  mp_create_session: "multiplayer session plumbing driven by the relay layer, not per-turn intent",
  mp_join_session: "multiplayer session plumbing driven by the relay layer, not per-turn intent",
  mp_leave_session: "multiplayer session plumbing driven by the relay layer, not per-turn intent",
  mp_claim_track: "multiplayer lock/sync plumbing driven by the relay layer",
  mp_commit_track: "multiplayer lock/sync plumbing driven by the relay layer",
  mp_sync_locks: "multiplayer lock/sync plumbing driven by the relay layer",
  mp_broadcast_selection: "multiplayer presence plumbing driven by the relay layer",
  mp_send_signal: "multiplayer presence plumbing driven by the relay layer",
  mp_serialize_project: "multiplayer serialization plumbing driven by the relay layer",
  mp_serialize_track: "multiplayer serialization plumbing driven by the relay layer",
  mp_apply_bootstrap: "multiplayer serialization plumbing driven by the relay layer",
  mp_apply_structural: "multiplayer serialization plumbing driven by the relay layer",
  mp_fetch_missing_stems: "multiplayer stem self-healing driven by the relay layer",
  apply_remote_track: "multiplayer serialization plumbing driven by the relay layer",

  // ── tempo/meter fine control — deferred, promote on bench demand ──────────────
  insert_time_sig_change: "meter-map fine control deferred — the agent covers the common case via set_time_signature",
  remove_time_sig_change: "meter-map fine control deferred — the agent covers the common case via set_time_signature",
  set_tempo_curve: "tempo-curve fine control deferred — insert_tempo_change's curve arg covers the common case",

  // ── track grouping — no agent story yet ───────────────────────────────────────
  create_group_track: "track grouping v0 has no agent story yet — candidate for a later batch",
  ungroup_track: "track grouping v0 has no agent story yet — candidate for a later batch",

  // ── hardware-controller telemetry ─────────────────────────────────────────────
  mark_take: "fire-and-forget controller telemetry (logs + re-emits an event) — no session mutation to verify",
};

// ─────────────────────────────────────────────────────────────────────────────
// The MIRROR of UI_ONLY_COMMANDS. That map answers "the agent can't reach this,
// and here's why". These two answer the question nobody was asking: "can the
// USER reach this?"
//
// Why this exists. The v2 shell — the DEFAULT shell — shipped unable to create a
// drum track or a MIDI clip. `create_track` was hardcoded to audio at both call
// sites and `add_midi_clip` had no v2 call site at all, so the piano roll (which
// only opens on an existing MIDI clip) was unreachable by construction too, and
// `rename_track` had no call site in either shell. You could finish a track in
// Mosh only if it was made of audio you recorded or imported.
//
// None of that was caught, because nothing measured it. 1,792 native selftest
// checks and 1,746 vitest tests all assert that COMMANDS work; the DAW-parity
// scoreboard defines a pass as "capability proven headless". Every one of those
// was green the whole time. Reachability was simply not a thing anyone checked.
//
// `uiReachability.test.ts` enforces the partition: every agent-catalog command is
// reachable from the shipped shell, OR listed below with a reason. New commands
// cannot join UI_REACH_GAPS silently — the list is a ratchet that may only shrink.
// ─────────────────────────────────────────────────────────────────────────────

/** Deliberately not a UI control — the shape has no sensible direct affordance. */
export const AGENT_ONLY_COMMANDS: Readonly<Record<string, string>> = {
  write_automation_curve: "writes a whole curve in one call — the UI's story is drawing points on the automation canvas, which is a different (and better) gesture",
  list_takes: "a read-only re-read of data every wave clip ALREADY carries in the snapshot — cmdListTakes and clipToVar run the identical getTakeDescriptions()/getCurrentTake() pair into the identical shape, so the Inspector's Takes tab enumerates and switches takes with no command call at all",
};

/**
 * KNOWN GAPS — the backend works and the agent can call it, but a mouse-only user
 * cannot. This is a backlog, not a design: each entry is a control someone still
 * has to build. The test asserts every entry is STILL unreachable, so wiring one
 * up forces its removal here and the list can only shrink.
 */
export const UI_REACH_GAPS: Readonly<Record<string, string>> = {
  // ── arrangement / editing ────────────────────────────────────────────────────
  // (add_drum_pattern was declared here. DrumSequencer now has a Pattern field — seeded
  // from the live clip, validated by the same parser the backend uses — so a mouse-only
  // user can lay or edit a whole grid in one undoable step. Ratchet 17 → 16.)
  delete_time_range: "ripple delete across all tracks — wants a time-range action in the timeline's range tool",
  load_drum_kit: "drum tracks auto-load a kit; swapping it needs a kit picker on the drum track",
  sketch_beatbox: "beatbox-to-beat inference — wants an entry point in the record/import flow",

  // (list_takes was declared here, on the premise that "take ENUMERATION has no surface".
  // That premise was FALSE by the time anyone checked: the snapshot emits numTakes /
  // currentTakeIndex / takes per wave clip, and the v2 Inspector's Takes tab renders one
  // button per take off exactly that data. It moved to AGENT_ONLY_COMMANDS rather than
  // being closed by building something, because there was nothing left to build.
  // Still genuinely missing, and NOT this command's gap: v2's arrangement draws no inline
  // take lanes the way classic's Arrange.tsx does, so choosing a take means opening the
  // Inspector. That is a presentation gap with no unreachable command behind it.)

  // (export_stems was declared here. ExportControls now has a What: mixdown | stems mode —
  // one panel, because format and bit depth mean the same thing in both and this file exists
  // to be the single export entry-point definition. Range/Tail are hidden in stems mode
  // (export_stems has no such args and would ignore them), and the run is confirm-gated:
  // it is N full renders INLINE on the message thread with no progress and no cancel, so an
  // accidental click is unrecoverable. Ratchet 14 → 13.)

  // ── mixer / routing ──────────────────────────────────────────────────────────
  // (rename_bus / remove_bus were declared here as "an unintended asymmetry" with create_bus,
  // and that is exactly what they were: the Sends section now renames on double-click and
  // deletes behind a confirm — cmdRemoveBus drops the return track AND sweeps the send off
  // every track in the project, which re-adding the bus does not restore.
  // set_master_plugin_param was declared here too; the master rack's rows now expand to the
  // same 0..1 sliders the per-track rack has always had, off the same pluginToVar params.)
  set_input_monitor: "input monitoring mode (in/off/auto) matters while tracking but has no control",

  // ── generative render layers ─────────────────────────────────────────────────
  // (bypass_layer was declared here. GenDrawer now has an A/B toggle on both the wave
  // in-place branch and the MIDI/drum beneath branch — it was the only one of this trio
  // that moves real audio rather than writing a label, so it was the only one worth a
  // control. Ratchet 15 → 14.)
  //
  // The other two are STILL gaps, but for sharper reasons than "wants a control" — both
  // were investigated and neither should be wired as its entry originally described:
  freeze_layer: "NOT just a missing control — the command is inert. It writes status='frozen' and nothing anywhere reads that value (the only mention in the tree is SelfTest.cpp's own assertion that the label was written). reactiveTouch (MoshOps.cpp:8800) gates on ids::reactive, which Ids.h:215 declares as the per-layer opt-out but NO command ever writes — so a 'frozen' layer still auto-re-renders on the next param edit, spending exactly the CPU the name promises to save. A button today would be a lie. Needs freeze_layer to set ids::reactive=false plus a way back (there is no unfreeze_layer) before any UI is honest.",
  bounce_layer_to_clip: "redundant on the path a producer is actually on: for whole-clip wave (appliedInPlace) and MIDI/drum (beneath) renders, cmdAcceptRender takes a no-op branch, so bounce only relabels status='bounced' with zero audio effect — and it does not detach reactivity either, since reactiveTouch ignores status. It does real work ONLY for a section-scoped render, which today no manual control can even create (regionStart/regionEnd are agent-only). Wire it together with a sub-region create control, not before. Also fix MoshOps.cpp:9552 first — it writes the status with nullptr instead of &undoManager(), so 'bounced' survives an undo that deletes the clip it describes.",

  // (insert_tempo_change / remove_tempo_change were declared here. The timeline now has a
  // tempo lane — its own row between the section ribbon and the bar ruler, built on time.ts's
  // PIECEWISE map rather than geom.ts's single session.tempo, which is only correct while the
  // tempo never changes. Create + remove only, and every point is a STEP change: there is no
  // command to edit a point in place, so a drag or retype gesture would be a non-atomic
  // remove+insert. set_tempo_curve stays separately deferred. Ratchet 13 → 11.)

  // ── annotations — the whole surface is missing from v2, not just the drag ────
  // These four were NOT all declared before. move_annotation's old reason said "annotations
  // can be created and edited on the timeline but not dragged to a new beat" — true of the
  // CLASSIC shell, and false of the one that ships. v2 renders no annotation UI whatsoever;
  // AnnotationRuler.tsx is imported only by classic's Arrange.tsx. Its three siblings read as
  // reachable purely because v2 imports Arrange.tsx for four presentational clip renderers,
  // which dragged the whole classic subtree into the probe's search set. Tightening the probe
  // (CLASSIC_ONLY_MODULES in uiReachability.test.ts) is what surfaced them. All four close
  // together when v2 gets a real annotation lane.
  create_annotation: "v2 renders no annotation surface at all — the only call site is classic's AnnotationRuler.tsx, which v2 never mounts",
  edit_annotation: "v2 renders no annotation surface at all — the only call site is classic's AnnotationRuler.tsx, which v2 never mounts",
  remove_annotation: "v2 renders no annotation surface at all — the only call site is classic's AnnotationRuler.tsx, which v2 never mounts",
  move_annotation: "no annotation surface in v2 to drag on; needs the lane built first, then a drag gesture (the beat is the anchor, so it converts through the piecewise tempo map)",

  // ── track lifecycle ──────────────────────────────────────────────────────────
  // (remove_track was declared here — a mouse-only v2 user could not delete a track at
  // all; the sole call site in the codebase was the × on classic's track header
  // (Arrange.tsx:416), which v2 never renders, hidden until the probe stopped searching
  // classic-only modules. TrackLaneHeader (v2/lanes/TrackLaneList.tsx) now has a hover-
  // revealed × beside Mute/Solo, confirm-gated — cmdRemoveTrack takes every clip on the
  // track with it in one undo transaction, so the dialog says so, and also says Undo
  // brings it back, since — unlike remove_bus's cross-track side effects — this IS a
  // plain undoable Edit mutation.)

  // (create_section / rename_section / move_section / remove_section were declared here.
  // SectionRibbon is now mounted as the timeline's top row in TrackLaneList — inside the
  // grid, above the ruler, NOT in the nav strip that PR #183 removed it from. All four
  // are reachable with the mouse, so their entries are gone and the ratchet dropped 21→17.)

  // (add_test_tone_clip was declared here as a classic-only leftover. v2's add-track menu
  // now offers "Test tone", which makes an audio track and puts a reference tone on it —
  // the same create-then-populate shape the Instrument entry uses, because v2 has no
  // "add a clip to this track" affordance for a tone to hang off.)
};
