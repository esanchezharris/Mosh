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
