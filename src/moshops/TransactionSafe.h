#pragma once

#include <juce_core/juce_core.h>
#include <set>

// FS-B2a — the ENGINE-OWNED transactionSafe registry
// (docs/first-stranger-program/lanes/fs-b2.md: "There is no engine-owned allowlist
// proving that every command admitted to an agent transaction is synchronous and wholly
// undoable. The TypeScript command catalog is not authoritative for engine rollback
// safety.")
//
// Admission criteria — ALL FOUR, checked mechanically, not asserted:
//   1. the handler calls beginTxn() (so its mutation joins the open UndoManager txn);
//   2. it passes undoable = true to logLine() (its own claim that undo reverses it);
//   3. its body contains no std::thread / callAsync / jobManager / Thread::launch
//      (synchronous — a job that completes after batch_end cannot be rolled back); and
//   4. it does not re-enter execute() to author a sub-program (those compose commands
//      of their own choosing, which the manifest cannot enumerate in advance).
//
// `ui/src/agent/txnSafeRegistry.test.ts` re-derives 1–4 from MoshOps.cpp at test time
// and fails on any entry whose claim has rotted. That matters more than usual here: a
// written reason is a claim about the code and it ages — nine of the sixteen
// UI_REACH_GAPS entries turned out to describe an assumption rather than the tree.
//
// FAIL-CLOSED. A command not named below is refused, whatever it does. Growing this
// list is a deliberate act with a mechanical check behind it; forgetting to grow it
// costs a legible refusal, never a partial mutation.
namespace mosh::txnsafe
{

enum class Class
{
    Safe,           // in the registry: synchronous, wholly undoable, MoshOps-mediated
    NonUndoable,    // mutates a device/engine preference or writes a non-undoable label
    Async,          // spawns a job/thread/service call that outlives the transaction
    Lifecycle,      // replaces or persists the project, or drives transport/recording
    Nested,         // a batch/transaction boundary — a transaction cannot contain one
    Unknown         // not classified: refused, fail-closed
};

/** v1 registry. Deliberately NARROW: every entry is a liability, and a legible refusal
    costs a skill nothing while a wrong admission costs a partial mutation.
    Scope = the commands the transactable skills in SKILL_CATALOG use, plus the
    synchronous arrangement / mixer / plugin / section / MIDI / automation core a B2
    skill plainly needs. All 47 satisfy criteria 1–4.

    Reviewed EXCLUSIONS (each mechanically "safe" but held out of v1 on purpose):
      • remove_bus / create_group_track / ungroup_track / delete_time_range — each
        reaches ACROSS tracks (remove_bus sweeps the send off every track), so a
        rollback's blast radius is wider than the manifest describes. Admit only with a
        cross-track rollback fixture.
      • paste_clip / relink_clip / import_clip_data — object-typed or filesystem-path
        payloads; not agent-callable, so no skill can manifest them anyway.
      • the render-layer family (bypass_layer, freeze_layer, unfreeze_layer,
        bounce_layer_to_clip, reject_render, remove_render_layer) — all couple to the
        reactive re-render lane, whose effects --selftest provably cannot see
        (reactiveTouch bails on !hasAudio() before reading its flags).
      • the master-bus and RAVE families — one shared resource / a model-install-gated
        lab surface; neither has a skill.
      • keep_take / set_current_take, the meter commands, annotations, and the
        tempo-curve / insert-tempo-change fine control — no skill needs them in v1. */
inline const std::set<juce::String>& registry()
{
    static const std::set<juce::String> safe {
        // ── mixer / track ──
        "set_track_volume", "set_track_pan", "set_track_mute", "set_track_solo",
        "create_track", "rename_track", "remove_track", "set_track_type",
        // ── clips ──
        "move_clip", "trim_clip", "split_clip", "remove_clip", "rename_clip",
        "duplicate_clip", "set_clip_mute", "set_clip_gain", "set_clip_fade",
        "set_clip_loop", "set_clip_reverse", "set_clip_crossfade", "normalize_clip",
        "stretch_clip", "set_clip_warp",
        // ── MIDI ──
        "add_midi_clip", "add_note", "set_note", "remove_note", "quantize_notes",
        // ── drums ──
        "add_drum_pattern", "assign_sample", "set_drum_lane", "load_drum_kit",
        // ── plugins (per-track rack) ──
        "load_plugin", "load_builtin", "remove_plugin", "reorder_plugin",
        "set_plugin_param", "bypass_plugin",
        // ── automation ──
        "set_track_automation_mode", "write_automation_curve",
        "add_automation_point", "remove_automation_point", "set_automation_point",
        "clear_automation",
        // ── sends / buses (additive only) ──
        "create_bus", "add_send", "set_send_level", "remove_send",
        // ── song structure ──
        "set_tempo", "set_time_signature",
        "create_section", "rename_section", "move_section", "remove_section",
        // ── lyrics (sheet edits; the GENERATION commands are Async, below) ──
        "create_lyric_sheet", "set_lyric_line", "set_lyric_constraint",
        "remove_lyric_line",
    };
    return safe;
}

/** Human-legible reasons for the families a skill is most likely to try. Purely for
    refusal copy — the DECISION is registry membership, so a command missing from both
    this map and the registry still fails closed (as Unknown). */
inline Class classify (const juce::String& command, juce::String& reason)
{
    if (registry().count (command) > 0)
    {
        reason.clear();
        return Class::Safe;
    }

    if (command.startsWith ("batch_"))
    {
        reason = command + " is a transaction boundary; a transaction cannot contain one";
        return Class::Nested;
    }

    static const std::set<juce::String> nonUndoable {
        "set_metronome", "set_key", "set_count_in", "set_project_settings",
        "set_input_monitor", "arm_track", "set_audio_device", "retry_audio_device",
        "set_buffer_size", "set_audio_threads", "set_track_input", "set_track_output",
        "block_plugin", "clear_plugin_blocklist", "mark_take", "open_plugin_editor",
        "enable_track_meter", "disable_track_meter", "enable_all_meters",
        "agent_memory_write", "agent_memory_delete", "agent_memory_clear",
        "activate_lora_adapter", "import_lora_adapter",
    };
    if (nonUndoable.count (command) > 0)
    {
        reason = command + " changes a device/engine preference or writes a non-undoable "
                           "value, so an undo would not restore it";
        return Class::NonUndoable;
    }

    static const std::set<juce::String> async {
        "render_layer", "compile_render", "cancel_render", "create_render_layer",
        "set_render_param", "accept_render", "reject_render", "add_render_layer",
        "reset_render_layer", "bypass_layer", "freeze_layer", "unfreeze_layer",
        "bounce_layer_to_clip", "remove_render_layer",
        "render_ahead_arm", "render_ahead_tick",
        "detect_clip_bpm", "transcribe_clip", "sketch_beatbox", "generate_beat_recipe",
        "analyze_lyrics", "complete_lyrics", "fill_lyric_gap", "suggest_next_line",
        "regenerate_lyric", "cancel_lyric_job", "accept_lyric_proposal",
        "reject_lyric_proposal", "assert_lyric_line", "get_rhymes",
        "build_lyrics_from_clip", "build_skeleton_from_clip", "confirm_skeleton",
        "rescan_plugins", "submit_training_job", "cancel_training_job",
        "build_training_corpus", "import_training_source", "approve_training_source",
    };
    if (async.count (command) > 0)
    {
        reason = command + " runs asynchronously (a service job or background thread), so "
                           "its effect can land after the transaction closes";
        return Class::Async;
    }

    static const std::set<juce::String> lifecycle {
        "new_project", "open_project", "open_recent", "save", "save_as", "reload",
        "recover_session", "discard_recovery", "export_audio", "export_stems",
        "set_transport", "stop_recording", "undo", "redo",
    };
    if (lifecycle.count (command) > 0)
    {
        reason = command + " replaces, persists or transports the project; it is outside "
                           "any single edit transaction";
        return Class::Lifecycle;
    }

    reason = command + " is not in the engine's transactionSafe registry";
    return Class::Unknown;
}

inline bool isSafe (const juce::String& command)
{
    juce::String ignored;
    return classify (command, ignored) == Class::Safe;
}

/** Commands that stay available WHILE a transaction is open. fs-b2.md: "Read-only
    snapshot/status calls remain available" — the exclusion window bounds MUTATION, not
    reading, and blocking these would freeze waveform drawing and every settings panel
    for the length of a skill run.

    FAIL-CLOSED by construction: the guard admits a command only if it is either the
    manifest's next entry or named here, so a new read-only command is refused (a legible
    refusal) rather than silently let through. `batch_status` MUST be here — it is the
    authoritative surface the harness consults after any ambiguous outcome.

    get_snapshot is absent because it is not a command at all: the WebView binds it
    separately (WebBridge) and it never reaches execute(). */
inline const std::set<juce::String>& readOnlyDuringTransaction()
{
    static const std::set<juce::String> reads {
        "batch_status",
        "get_clip_peaks", "file_peaks", "get_command_log", "get_plugin_blocklist",
        "list_plugins", "list_builtins", "list_takes", "list_directory",
        "list_audio_devices", "list_midi_inputs", "list_wave_inputs",
        "list_track_outputs", "list_rave_models", "list_training_sources",
        "list_lora_adapters", "list_colors", "list_loras", "list_transform_targets",
        "agent_memory_read", "get_lyric_corpus_stats", "get_rhymes",
        "mp_serialize_track", "mp_serialize_project", "mp_sync_locks",
        // Live note audition — transient sound, no Edit mutation and no beginTxn (the
        // invariant this set enforces). Listed because a producer must still be able to
        // play the keyboard, drag a note, or tap a drum pad WHILE an agent skill holds a
        // transaction open; without it every such keypress would fail
        // TRANSACTION_IN_PROGRESS.
        "audition_note", "all_notes_off",
    };
    return reads;
}

inline bool isReadOnlyDuringTransaction (const juce::String& command)
{
    return readOnlyDuringTransaction().count (command) > 0;
}

} // namespace mosh::txnsafe
