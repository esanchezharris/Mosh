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
  list_recording_residue: "CAP-001 — read-only feed for the recovery notice's orphan-take list",
  adopt_recording_residue: "CAP-001 — landing a take the crash left on disk is an explicit human decision from the recovery notice",
  quarantine_recording_residue: "CAP-001 — setting a torn take aside (renamed, never deleted) is an explicit human decision from the recovery notice",
  open_without_plugins:
    "reopens the project with the producer's third-party plugins skipped and may quarantine one — a trust decision about their own gear, made from the crash notice",
  relink_clip: "repairs a broken source-file reference — file-path surgery, not a musical move",
  import_clip_data: "carries a base64 clip payload (multiplayer/clipboard plumbing) — unrepresentable in ArgSpec",
  paste_clip: "object-typed 'clip' descriptor unrepresentable in ArgSpec (and the SFT parser's S/N/B set); agent equivalent = duplicate_clip + move_clip",

  // ── device / settings / scan admin — needs user acknowledgment ────────────────
  set_audio_device: "audio-device selection is session admin the producer must acknowledge",
  retry_audio_device: "AUD-017 — the response to a device-failed-to-open banner; the producer fixes the hardware, then presses Retry",
  set_buffer_size: "buffer-size changes are session admin the producer must acknowledge",
  set_audio_threads: "thread-count tuning is session admin the producer must acknowledge",
  set_project_settings: "project-level settings dialog plumbing, not a musical move",
  set_track_input: "physical input routing is set from the track's input picker with the device list in view",
  rescan_plugins: "the plugin scan is a slow, blocking maintenance op driven from the settings UI",
  block_plugin: "the crash-blacklist is a safety console the producer manages",
  unblock_plugin: "retrying one quarantined plugin is a safety decision the producer makes from the insert dialog",
  clear_plugin_blocklist: "the crash-blacklist is a safety console the producer manages",
  get_plugin_blocklist: "read-only feed for the blacklist settings panel",
  list_audio_devices: "device discovery feeding the settings UI — the agent's session context is the snapshot",
  list_midi_inputs: "device discovery feeding the input picker UI",
  list_wave_inputs: "device discovery feeding the input picker UI",
  list_directory: "filesystem browsing is the file-picker's job; agent file access is by explicit path args",

  // ── executor/undo plumbing — owned by the harness, never the model ────────────
  batch_begin: "the executor opens/closes the agent's own undo batches — the model never manages transactions",
  batch_end: "the executor opens/closes the agent's own undo batches — the model never manages transactions",
  // FS-B2a — the skill harness's transaction plumbing. These are NOT producer actions and
  // must never reach the model: batch_status is the authoritative read the harness consults
  // after an ambiguous outcome, and batch_rollback is the only automatic skill rollback
  // (gated on undo-head ownership + a pre-state fingerprint). A mouse-only producer's undo
  // affordance is the ordinary Undo, which is unaffected. Being outside AGENT_COMMANDS is
  // also why uiReachability.test.ts does not apply to them and UI_REACH_GAPS stays 0.
  batch_status: "read-only agent-transaction status — the harness's authority after a lost response, not a producer control",
  batch_rollback: "the harness's exact rollback of its own identified transaction — the producer's affordance is ordinary Undo",
  get_command_log: "read-only log inspector (CommandLog panel + taste distillation), not a musical tool",
  report_issue: "the deterministic typed/voice issue route records owner feedback before model routing; report text is never model-authored",
  list_issues: "read-only feed for the private Issue Inbox panel",
  update_issue: "owner triage state in the private Issue Inbox, not a musical edit",
  export_issue: "writes reviewed local feedback as GitHub-ready Markdown; the owner decides whether it is shared",
  attach_issue_file: "copies a producer-selected screenshot into a private local report; file selection stays human",
  // CAP-PRJ-005. Its one argument is a history STAMP the model cannot know or invent —
  // stamps are minted per process by the engine and are only ever read off a log line the
  // producer is looking at. A catalogued jump_to_history would be a command the model can
  // name but never call correctly, so the affordance is the click, and the model's history
  // affordance stays the ordinary undo/redo it already has.
  jump_to_history: "click-a-history-row restore; its txn stamp is engine-minted and unguessable, so it is a mouse gesture, not a voiced command",

  // ── metering — UI-local presentation config ───────────────────────────────────
  enable_all_meters: "metering config is presentation state, self-healed by the engine (METER-001)",
  enable_track_meter: "metering config is presentation state, self-healed by the engine (METER-001)",
  disable_track_meter: "metering config is presentation state, self-healed by the engine (METER-001)",

  // ── read-only media plumbing — presentation data the model can't use ──────────
  get_clip_peaks: "waveform peak arrays for canvas drawing — meaningless to the model",
  file_peaks: "waveform peak arrays for the file browser — meaningless to the model",
  audition_file: "pre-import audition is a listening affordance; the agent can't hear it",
  promote_lora_checkpoint: "the LoRA Lab's Keep verb — it makes one auditioned checkpoint permanent. The decision it records is a listening judgement the agent cannot make (the round that motivated the Lab found a 25-epoch adapter with better character than a 44-epoch one scoring 0.14 higher), and it is the one action in the Lab that is NOT disposable: it writes into the producer's library, outside the edit, where undo does not reach",
  render_lora_take: "the LoRA Lab's audition render. It exists BECAUSE the numbers disagree with the ears — a 25-epoch adapter beat a 44-epoch one that scored 0.14 higher — so the whole verb is 'produce a candidate for a human to judge'. An agent calling it would be generating audio it cannot evaluate, and the only signal that decides the outcome is the one it does not have",
  stop_audition: "pre-import audition is a listening affordance; the agent can't hear it",
  audition_note: "sounds a note through the track's instrument for the producer to hear — a listening affordance the agent can't hear, and it changes nothing, so there is no result for it to reason about",
  all_notes_off: "panic-stops whatever the keyboard or piano roll left sounding; a live-performance affordance, not a musical edit",
  capture_midi: "keeps what the producer just PLAYED but did not record — the model has no performance sitting in the retrospective buffer, so there is nothing for it to capture (set_record_options, which decides how a take behaves, IS agent-callable)",

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
  import_lora_adapter: "adapter installation is an owner action, never agent-driven",
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
  rename_track_group: "configure_track_group is the canonical agent operation because it updates name, type, members, and linked attributes atomically; this older rename-only seam remains for replay compatibility",

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
  //
  // (delete_time_range was declared here as "wants a time-range action in the timeline's
  // range tool" — true of every shell, classic included: Arrange.tsx's own range tool
  // painted a UI-local band and never wired an actual delete to it (its comment said
  // "delete_time_range on demand" and then never implemented the demand). v2 had no
  // time-span selection of any kind before this. Shift-drag on BarRuler now draws a
  // bar-snapped span (piecewise tempo map, not geom.ts's flat one — see BarRuler.test.ts)
  // rendered as a cross-lane band (TimeRangeBand) with two SEPARATELY labelled actions —
  // Delete and Delete-close-gap — rather than one button plus a ripple modifier, because
  // ripple silently reflows every downstream clip and that should never be one missed
  // keypress away from a plain delete. Ratchet 11 → 10.)

  // (sketch_beatbox was declared here as "wants an entry point in the record/import flow".
  // cmdSketchBeatbox takes an ABSOLUTE PATH, not a clipId, so the clipId-based clip menu
  // (transcribe_clip/build_skeleton_from_clip's home) was never a fit — a real path only
  // exists at a file-chooser. SampleBrowser's directory listing (list_directory) already
  // IS that file-chooser and, unlike pickFiles' native dialog, is answered identically by
  // the real backend, the dev mock, AND Playwright — so a file row's new "Beatbox → beat"
  // button (SketchBeatboxDialog.tsx) needed no pickFiles round-trip at all: the path was
  // already sitting right there. The dialog validates bpm (20–300) and bars (1–2)
  // client-side against the exact bounds cmdSketchBeatbox enforces, and dispatches with
  // wait:false (wait:true blocks the message thread — execute_command is synchronous).
  // Ratchet 11 → 10.)

  // (load_drum_kit was declared here as "wants a kit picker" — that description was WRONG,
  // not just incomplete: a picker is impossible today. There is exactly ONE bundled kit
  // (mosh-kit, 8 hardcoded pads), no list_drum_kits enumeration anywhere, and no kit name
  // in the snapshot to pick FROM. What the command actually does — (re)load the one
  // bundled kit onto a track's sampler — is a real, meaningful action once a producer has
  // used the per-lane "⋯" swap (assign_sample) on DrumSequencer: "Reset kit" restores the
  // defaults. That shipped in the toolbar next to Clear/Pattern, gated on isDrumTrack. A
  // genuine picker is still backend work first: list_drum_kits + a kit arg on
  // load_drum_kit, neither of which exists.)

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
  // same 0..1 sliders the per-track rack has always had, off the same pluginToVar params.
  // set_input_monitor was declared here too — an off/automatic/on select now sits in the
  // Inspector's Mix tab beside MidiInputField/OutputField. Its title says what its reason
  // used to only note privately: cmdSetInputMonitor is DEVICE-level (every track fed by the
  // same physical input shares one monitor mode) and NOT undoable (a global engine/device
  // preference, not an Edit-tree write). `applied:false` — no input device instance
  // currently targets this track — surfaces inline rather than silently doing nothing,
  // since that is `ok:true` and would not trip the store's normal lastError banner.)

  // ── generative render layers ─────────────────────────────────────────────────
  // (bypass_layer was declared here. GenDrawer now has an A/B toggle on both the wave
  // in-place branch and the MIDI/drum beneath branch — it was the only one of this trio
  // that moves real audio rather than writing a label, so it was the only one worth a
  // control. Ratchet 15 → 14.)
  //
  // The other two are STILL gaps, but for sharper reasons than "wants a control" — both
  // were investigated and neither should be wired as its entry originally described:
  // (freeze_layer was declared here as inert — it wrote status='frozen' and nothing read it,
  // so a "frozen" layer kept auto-re-rendering on the next edit. Closed by fixing the ENGINE,
  // not by adding a control: cmdFreezeLayer now also writes ids::reactive=false, the flag
  // reactiveTouch actually gates on; cmdUnfreezeLayer is the thaw that did not exist, so a
  // freeze is no longer permanent; and snapshot carries `reactive` so the drawer's
  // Freeze/Frozen toggle reads server truth. It must read `reactive`, NOT `status`: a later
  // param edit overwrites status with "dirty" while the layer stays frozen. The saving is
  // proven in verify.py's check_freeze_stops_rerender — --selftest cannot see it, because
  // reactiveTouch returns on !hasAudio() long before it reads the flag.)

  // (bounce_layer_to_clip was the last entry here. It was NOT just a missing button: the
  // command is a pure relabel on every path a manual control could reach — for whole-clip
  // wave (appliedInPlace) and MIDI/drum (beneath) renders cmdAcceptRender takes a no-op
  // branch, so bounce wrote status='bounced' and changed no audio. It does real work only
  // for a SECTION-scoped render, and no shell could create one: create_render_layer has
  // accepted regionStart/regionEnd all along, but nothing ever sent them.
  //
  // Closed by building the missing surface rather than wiring the button where it lies. The
  // timeline's range selection now offers "Re-imagine section" (sectionRender.ts resolves the
  // span to a clip, declining spans that cover a whole clip — the engine would apply those in
  // place — and clips that already carry a layer), and the drawer grows a section branch whose
  // Bounce is gated on isSectionScoped. Live / A-B / Reset are withheld there: all three
  // describe a render that IS the clip's audio, which a section render never becomes.
  //
  // Its undo bug is also fixed: the status was written with nullptr instead of
  // &undoManager(), so 'bounced' outlived an undo that deleted the clip it described (#454,
  // with selftest coverage for both shapes). Mock parity for the whole sub-region branch —
  // which did not exist, making the shape untestable — is in bridge.mock.subregion.test.ts.)

  // (insert_tempo_change / remove_tempo_change were declared here. The timeline now has a
  // tempo lane — its own row between the section ribbon and the bar ruler, built on time.ts's
  // PIECEWISE map rather than geom.ts's single session.tempo, which is only correct while the
  // tempo never changes. Create + remove only, and every point is a STEP change: there is no
  // command to edit a point in place, so a drag or retype gesture would be a non-atomic
  // remove+insert. set_tempo_curve stays separately deferred. Ratchet 13 → 11.)

  // (create_annotation / edit_annotation / move_annotation / remove_annotation were declared
  // here as "the whole surface is missing from v2, not just the drag". v2's timeline now has
  // a real annotation lane — its own row between the bar ruler and the lanes, in
  // TrackLaneList, built the same way the tempo lane was: click empty space → inline text
  // input → create_annotation; double-click a pin → inline edit → edit_annotation; drag a pin
  // → move_annotation; hover ✕ → remove_annotation. Positions convert beat↔seconds through
  // time.ts's PIECEWISE map (new beatAt/secAtBeat, mirroring the private barPosAt/barPosToSec
  // this file already had for bars) — NOT geom.ts's flat beatToSec/secToBeat, which
  // SectionRibbon uses and which is only correct while the tempo never changes. Ratchet 11 → 7.)

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
