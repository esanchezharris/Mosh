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
        "list_wave_inputs", "list_track_outputs", "list_takes", "list_colors",
        "list_directory", "list_training_sources", "list_lora_adapters",
        "get_clip_peaks", "file_peaks", "get_command_log", "audition_file",
        "stop_audition", "export_audio", "save", "reload", "save_as", "new_project",
        "open_project", "set_transport", "stop_recording", "undo", "redo",
        "batch_begin", "batch_end", "enable_track_meter", "disable_track_meter",
        "enable_all_meters", "set_audio_device", "set_buffer_size", "set_audio_threads",
        "set_project_settings", "set_key", "rescan_plugins", "get_plugin_blocklist",
        "clear_plugin_blocklist", "block_plugin", "open_plugin_editor",
        "mp_serialize_track", "apply_remote_track", "mp_sync_locks",
        "mp_create_session", "mp_join_session", "mp_leave_session",
        "mp_claim_track", "mp_commit_track", "mp_broadcast_selection",
        "mp_serialize_project", "mp_apply_bootstrap", "mp_apply_structural",
        "import_training_source", "approve_training_source", "build_training_corpus",
        "submit_training_job", "training_job_status", "cancel_training_job",
        "import_lora_adapter", "activate_lora_adapter",
    };

    // Track-scoped: mutate exactly one track (args carry a trackId). Key = that
    // track's logicalId.
    static const std::set<juce::String> track {
        "rename_track", "remove_track", "import_clip", "import_clip_data",
        "add_test_tone_clip", "set_track_volume", "set_track_pan", "set_track_mute",
        "set_track_solo", "arm_track", "set_input_monitor", "set_current_take",
        "keep_take", "load_plugin", "load_builtin", "remove_plugin", "reorder_plugin",
        "set_plugin_param", "bypass_plugin", "add_neural_insert", "set_neural_param",
        "set_neural_lab_mode", "set_neural_latency", "reset_neural", "load_neural_model",
        "set_track_type", "load_drum_kit", "assign_sample", "set_drum_lane",
        "add_midi_clip", "set_track_input", "set_track_output", "add_send",
        "set_send_level", "remove_send", "add_automation_point", "remove_automation_point",
        "set_automation_point", "clear_automation",
    };

    // Clip-scoped: mutate one clip (args carry a clipId). Key = the clip's track
    // logicalId, resolved by MoshOps.
    static const std::set<juce::String> clip {
        "move_clip", "trim_clip", "split_clip", "remove_clip", "rename_clip",
        "set_clip_mute", "set_clip_gain", "relink_clip", "set_clip_warp",
        "duplicate_clip", "add_note", "remove_note", "set_note", "quantize_notes",
        "transcribe_clip", "create_render_layer",
    };

    if (unguarded.count (command)) return Scope::Unguarded;
    if (track.count (command))     return Scope::Track;
    if (clip.count (command))      return Scope::Clip;
    // Everything else (create_track/bus/group, tempo, master, buses, tempo-map,
    // generative render ops, and any future/unlisted command) fails CLOSED to the
    // session lock — guarded until deliberately classified.
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
