#include "LockManager.h"
#include <set>

namespace mosh
{

const juce::String& LockManager::sessionKey()
{
    static const juce::String k ("__session__");
    return k;
}

LockManager::Scope LockManager::classify (const juce::String& command)
{
    // Unguarded: reads, transport, undo/redo, meters, file I/O, project lifecycle,
    // machine prefs, catalog ops, and the MP-internal commands. These never contend
    // for a track and must always run (otherwise we'd block reading a peer's work).
    static const std::set<juce::String> unguarded {
        "list_plugins", "list_builtins", "list_audio_devices", "list_midi_inputs",
        "list_wave_inputs", "list_track_outputs", "list_takes", "list_colors", "list_loras",
        "list_directory", "list_training_sources", "list_drum_kits", "list_presets", "list_palette",
        "get_clip_peaks", "file_peaks", "get_command_log", "audition_file", "detect_clip_bpm",
        "list_transform_targets", "list_rave_models", "list_loras", "get_rhymes", "get_lyric_corpus_stats",
        // LoRA Lab audition. Renders a candidate adapter stack to a wav under the
        // session's lab/ dir and touches NO track, clip or render layer — it is
        // deliberately not clip-parented, which is exactly why it cannot contend.
        // `sourceClipId` only READS a clip's audio to stage an input.
        "render_lora_take", "promote_lora_checkpoint",
        // AGT-MEM (Phase-B memory lane, M1) — pure file I/O (no ValueTree mutation,
        // no track/clip target), same posture as get_rhymes/get_lyric_corpus_stats above.
        // M3 adds delete/clear (the memory drawer's per-item delete + per-tier
        // clear) — same posture: pure file I/O, no track/clip target, even though
        // (unlike read) they DO mutate a store file.
        "agent_memory_read", "agent_memory_write", "agent_memory_delete", "agent_memory_clear",
        "report_issue", "list_issues", "update_issue", "export_issue", "attach_issue_file",
        // Lane A — render-ahead: the clock tick is an internal/transport-like driver (no clip
        // target in its args; run-script/GUI-internal), so it never contends for a track.
        "render_ahead_tick",
        // Live note audition: transient sound only — it mutates nothing, so two peers
        // playing notes on the same track can never conflict (nor can a peer's keypress
        // be blocked by someone else's lock on the track they are auditioning).
        "audition_note", "all_notes_off",
        "stop_audition", "export_audio", "export_stems", "save", "reload", "save_as", "new_project",
        "open_project", "set_transport", "stop_recording", "undo", "redo",
        // CAP-PRJ-005 — jump_to_history is repeated undo/redo over the local Edit's own
        // UndoManager. Same posture as undo/redo directly above: it targets no single
        // track (the args name a history point, not a clip), so it contends for nothing
        // a peer could hold, and blocking it would leave a producer unable to walk back
        // out of their own history while someone else is working.
        "jump_to_history",
        // FS-T2 — plugin-crash safe mode reopens the LOCAL project with third-party plugins
        // skipped. Same posture as reload/open_project above (a whole-Edit swap, not a track
        // edit), and deliberately local: which plugins crashed this machine is a property of
        // THIS install's plugin folder, so it must never propagate to peers.
        "open_without_plugins",
        "mark_take", "batch_begin", "batch_end",
        // FS-B2a — batch_status is a pure read; batch_rollback undoes exactly the agent
        // transaction the CALLER owns (proven by undo-head + fingerprint), so like
        // undo/redo above it contends for no single track. Note the interplay: while an
        // agent transaction is open, MoshOps refuses every untagged mutation including a
        // peer's — a stricter guard than any lock, and a narrower window (one skill run).
        "batch_status", "batch_rollback",
        "enable_track_meter", "disable_track_meter",
        "enable_all_meters", "set_audio_device", "retry_audio_device", "set_buffer_size", "set_audio_threads",
        "set_project_settings", "set_key", "rescan_plugins", "get_plugin_blocklist",
        "clear_plugin_blocklist", "block_plugin", "unblock_plugin", "open_plugin_editor",
        // Master-bus plugins — popping a native editor window is viewer-local (no state
        // to sync), same posture as open_plugin_editor above.
        "open_master_plugin_editor",
        "mp_serialize_track", "apply_remote_track", "mp_sync_locks",
        "mp_create_session", "mp_join_session", "mp_leave_session",
        "mp_claim_track", "mp_commit_track", "mp_broadcast_selection",
        "mp_serialize_project", "mp_apply_bootstrap", "mp_apply_structural",
        "mp_fetch_missing_stems",
        "import_training_source", "approve_training_source", "build_training_corpus",
        "submit_training_job", "training_job_status", "cancel_training_job",
        "import_lora_adapter", 
    };

    // Track-scoped: mutate exactly one track (args carry a trackId). Key = that
    // track's logicalId.
    static const std::set<juce::String> track {
        "rename_track", "set_track_color", "set_track_icon", "move_track", "remove_track", "import_clip", "import_clip_data",
        "create_track_group", "configure_track_group", "duplicate_track_group",
        "set_track_group_members", "set_track_group_enabled", "rename_track_group", "remove_track_group",
        "add_test_tone_clip", "set_track_volume", "set_track_pan", "set_track_mute",
        "set_track_solo", "set_track_active", "arm_track", "set_input_monitor", "set_current_take",
        "keep_take", "load_plugin", "load_builtin", "remove_plugin", "reorder_plugin",
        "set_plugin_param", "bypass_plugin", "load_preset",
        "add_rave_insert", "set_rave_param", "load_rave_model", "reset_rave",
        "set_track_type", "load_drum_kit", "assign_sample", "set_drum_lane",
        "set_drum_pad", "clear_drum_pad",
        // DRM-002 — composite: can create a clip AND mutate track instrument/type.
        "add_drum_pattern",
        "add_midi_clip", "paste_clip", "set_track_input", "set_track_output", "add_send",
        "set_send_level", "set_send_mute", "set_send_pan", "set_send_pre_fader", "remove_send",
        "add_automation_point", "remove_automation_point",
        "set_automation_point", "clear_automation",
        // G10 — automation recording: arming write mode and bulk-authoring a curve both
        // target one track's parameter surface, same lock group as the Wave-7 quartet above.
        "set_track_automation_mode", "write_automation_curve",
        "bounce_track", "freeze_track", "unfreeze_track",
        // LYR-001 — lyric sheet mutations target a track (args carry trackId).
        "create_lyric_sheet", "remove_lyric_sheet", "set_lyric_constraint",
        "set_lyric_line", "remove_lyric_line",
        // LYR-L2 — generation + proposal review also target one track's sheet.
        "complete_lyrics", "fill_lyric_gap", "suggest_next_line", "regenerate_lyric",
        "cancel_lyric_job", "accept_lyric_proposal", "assert_lyric_line", "reject_lyric_proposal",
        // LYR-L1 — analysis lands a transient blob on one track's sheet.
        "analyze_lyrics",
        // LYR Phase 2 — confirm the proposed flow grid (flips this track's lines proposed→seed).
        "confirm_skeleton",
    };

    // Clip-scoped: mutate clip content. MoshOps resolves the singular clipId and
    // every valid clipIds entry to all affected tracks' logicalIds before guarding.
    static const std::set<juce::String> clip {
        "move_clip", "trim_clip", "split_clip", "promote_take_region", "remove_clip", "rename_clip",
        "create_clip_group", "ungroup_clip_group", "rename_clip_group",
        "set_clip_mute", "set_clip_gain", "write_clip_gain_curve", "set_clip_fade", "relink_clip", "set_clip_warp", "stretch_clip",
        // clip-ops wave — reverse / auto-crossfade / normalize all carry a clipId like
        // gain/mute/fade; same clip-scoped key resolution.
        "set_clip_reverse", "set_clip_crossfade", "normalize_clip",
        // CLP-LOOP — clip loop region; carries a clipId like gain/mute/fade.
        "set_clip_loop",
        "duplicate_clip", "add_note", "remove_note", "set_note", "resolve_note_overlaps", "quantize_notes",
        "consolidate_clips", "crop_clip", "transform_velocities", "transform_notes",
        "apply_choke",
        "transcribe_clip", "add_render_layer", "create_render_layer",
        "set_render_param", "compile_render", "render_layer", "cancel_render",
        "accept_render", "reject_render", "reset_render_layer", "bypass_layer",
        "freeze_layer", "unfreeze_layer", "bounce_layer_to_clip", "remove_render_layer",
        "render_ahead_arm",   // Lane A — arms/disarms Live on one clip (mutates its render layer)
        "build_lyrics_from_clip",   // LYR Phase 3 — mumble take (lands a sheet on the clip's track)
        "build_skeleton_from_clip", // LYR Phase 2 — gibberish skeleton (lands a sheet on the clip's track)
    };

    if (unguarded.count (command)) return Scope::Unguarded;
    if (track.count (command))     return Scope::Track;
    if (clip.count (command))      return Scope::Clip;
    // Everything else (create_track/bus/group, tempo, master, buses, tempo-map,
    // generative render ops, and any future/unlisted command) fails CLOSED to the
    // session lock — guarded until deliberately classified.
    //
    // CAP-CLP-017 — insert_time and delete_time_range both land here, and for once the
    // fail-closed default is also the RIGHT answer rather than merely the safe one: each
    // rewrites every track, the tempo map and the beat-anchored song structure in one
    // transaction, so there is no single track key that could describe what they contend
    // for. Both carry a SessionGlobal row in tests/golden/lock_scopes.tsv, which is what
    // stops that from being an accident of omission.
    return Scope::SessionGlobal;
}

juce::String LockManager::ownerOf (const juce::String& key) const
{
    auto it = locks_.find (key);
    return it != locks_.end() ? it->second : juce::String();
}

LockManager::Decision LockManager::decide (Scope scope, const juce::String& resolvedKey) const
{
    if (! active_ || scope == Scope::Unguarded)
        return { true, {} };

    const auto owner = ownerOf (resolvedKey);
    if (owner.isEmpty() || owner == selfPeer_)
        return { true, {} };

    return { false, "locked by " + owner };
}

} // namespace mosh
