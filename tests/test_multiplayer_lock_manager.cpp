#include <catch2/catch_test_macros.hpp>
#include "multiplayer/LockManager.h"
#include <set>

using namespace mosh;
using Scope = LockManager::Scope;

// Engine-free: command classification + the allow/deny decision against a lock
// table. The engine-coupled key resolution (trackId/clipId -> logicalId) lives in
// MoshOps and is covered by the app selftest.

TEST_CASE ("classify: reads / transport / mp commands are unguarded", "[multiplayer][lock]")
{
    REQUIRE (LockManager::classify ("list_plugins")      == Scope::Unguarded);
    REQUIRE (LockManager::classify ("get_clip_peaks")    == Scope::Unguarded);
    REQUIRE (LockManager::classify ("set_transport")     == Scope::Unguarded);
    REQUIRE (LockManager::classify ("undo")              == Scope::Unguarded);
    REQUIRE (LockManager::classify ("enable_all_meters") == Scope::Unguarded);
    REQUIRE (LockManager::classify ("apply_remote_track")== Scope::Unguarded);
    REQUIRE (LockManager::classify ("mp_serialize_track")== Scope::Unguarded);
    REQUIRE (LockManager::classify ("mp_sync_locks")     == Scope::Unguarded);
    // P4 self-heal (PR-1): backend-only, no clip/track target in its args, never
    // contends for a track -- same posture as the other mp_* internals above.
    REQUIRE (LockManager::classify ("mp_fetch_missing_stems") == Scope::Unguarded);
}

TEST_CASE ("classify: single-track mutations are track-scoped", "[multiplayer][lock]")
{
    REQUIRE (LockManager::classify ("rename_track")     == Scope::Track);
    REQUIRE (LockManager::classify ("set_track_volume") == Scope::Track);
    REQUIRE (LockManager::classify ("load_plugin")      == Scope::Track);
    REQUIRE (LockManager::classify ("set_plugin_param") == Scope::Track);
    REQUIRE (LockManager::classify ("reorder_plugin")   == Scope::Track);
    REQUIRE (LockManager::classify ("add_midi_clip")    == Scope::Track);
    REQUIRE (LockManager::classify ("paste_clip")       == Scope::Track);
    // DRM-002: composite — can create clips AND mutate track instrument/type.
    REQUIRE (LockManager::classify ("add_drum_pattern") == Scope::Track);
}

TEST_CASE ("classify: clip mutations are clip-scoped", "[multiplayer][lock]")
{
    REQUIRE (LockManager::classify ("move_clip")      == Scope::Clip);
    REQUIRE (LockManager::classify ("trim_clip")      == Scope::Clip);
    REQUIRE (LockManager::classify ("split_clip")     == Scope::Clip);
    REQUIRE (LockManager::classify ("add_note")       == Scope::Clip);
    REQUIRE (LockManager::classify ("set_clip_gain")  == Scope::Clip);
    // G4A — the clip Inspector's gain/mute/rename commands were agent-only until now
    // (no UI surface); set_clip_gain was already covered above, these two were not.
    REQUIRE (LockManager::classify ("rename_clip")    == Scope::Clip);
    REQUIRE (LockManager::classify ("set_clip_mute")  == Scope::Clip);
    // G4b — clip fades carry a clipId like gain/mute; same clip-scoped key resolution.
    REQUIRE (LockManager::classify ("set_clip_fade")  == Scope::Clip);
}

TEST_CASE ("classify: render-layer mutations are clip-scoped", "[multiplayer][lock]")
{
    REQUIRE (LockManager::classify ("add_render_layer")      == Scope::Clip);
    REQUIRE (LockManager::classify ("create_render_layer")   == Scope::Clip);
    REQUIRE (LockManager::classify ("set_render_param")      == Scope::Clip);
    REQUIRE (LockManager::classify ("compile_render")        == Scope::Clip);
    REQUIRE (LockManager::classify ("render_layer")          == Scope::Clip);
    REQUIRE (LockManager::classify ("cancel_render")         == Scope::Clip);
    REQUIRE (LockManager::classify ("accept_render")         == Scope::Clip);
    REQUIRE (LockManager::classify ("reject_render")         == Scope::Clip);
    REQUIRE (LockManager::classify ("reset_render_layer")    == Scope::Clip);
    REQUIRE (LockManager::classify ("bypass_layer")          == Scope::Clip);
    REQUIRE (LockManager::classify ("freeze_layer")          == Scope::Clip);
    REQUIRE (LockManager::classify ("bounce_layer_to_clip")  == Scope::Clip);
    REQUIRE (LockManager::classify ("remove_render_layer")   == Scope::Clip);
}

TEST_CASE ("classify: structural ops + unknown commands fail closed to session-global", "[multiplayer][lock]")
{
    REQUIRE (LockManager::classify ("create_track")       == Scope::SessionGlobal);
    REQUIRE (LockManager::classify ("create_bus")         == Scope::SessionGlobal);
    REQUIRE (LockManager::classify ("set_tempo")          == Scope::SessionGlobal);
    REQUIRE (LockManager::classify ("set_master_volume")  == Scope::SessionGlobal);
    // fail-closed: a command nobody classified is guarded, not waved through.
    REQUIRE (LockManager::classify ("some_future_command")== Scope::SessionGlobal);
}

TEST_CASE ("decide: inactive session allows everything", "[multiplayer][lock]")
{
    LockManager m;  // not activated
    m.setLocks ({ { "track-1", "other" } });
    REQUIRE (m.decide (Scope::Track, "track-1").allow);          // would be denied if active
    REQUIRE (m.decide (Scope::SessionGlobal, LockManager::sessionKey()).allow);
}

TEST_CASE ("decide: a key held by the OTHER peer is denied", "[multiplayer][lock]")
{
    LockManager m;
    m.activate ("me");
    m.setLocks ({ { "track-1", "other" }, { LockManager::sessionKey(), "other" } });

    REQUIRE_FALSE (m.decide (Scope::Track, "track-1").allow);
    REQUIRE (m.decide (Scope::Track, "track-1").reason.isNotEmpty());
    REQUIRE_FALSE (m.decide (Scope::SessionGlobal, LockManager::sessionKey()).allow);
}

TEST_CASE ("decide: free or self-owned keys are allowed; reads always allowed", "[multiplayer][lock]")
{
    LockManager m;
    m.activate ("me");
    m.setLocks ({ { "track-1", "me" }, { "track-2", "other" } });

    REQUIRE (m.decide (Scope::Track, "track-1").allow);     // ours
    REQUIRE (m.decide (Scope::Track, "track-3").allow);     // free
    REQUIRE (m.decide (Scope::Unguarded, "track-2").allow); // a read on a peer-locked track is fine
    REQUIRE (m.ownerOf ("track-2") == "other");
    REQUIRE (m.ownerOf ("track-9").isEmpty());
}

// ── AL-011: lock-classifier drift coverage ──────────────────────────────────────
//
// LockManager::classify() is an independent, hand-maintained mirror of what
// MoshOps actually dispatches (src/moshops/MoshOps.cpp's `if (name == "...")`
// table) -- nothing enforces that the two stay in sync as new commands are
// added. sketch_beatbox is a real example: it dispatches in MoshOps but was
// never added to any of LockManager's Unguarded/Track/Clip sets, so it falls
// through to the fail-closed SessionGlobal default. That default happens to be
// CORRECT for sketch_beatbox (it internally lands both create_track and
// set_tempo, both of which are themselves session-global), but nothing was
// checking that this was a deliberate call rather than an oversight.
//
// The two tests below close that gap without requiring an invasive shared
// command->scope registry (LockManager's sets are file-local statics; MoshOps
// is a ~9000-line file well outside this fix's scope): (1) pin the specific,
// deliberate sketch_beatbox decision, and (2) parse MoshOps.cpp's real dispatch
// table at test time and assert every command it dispatches is EITHER
// classified into a non-default scope OR named on an explicit, commented
// allow-list of "deliberately session-global" commands below. A future command
// that is dispatched but neither classified nor allow-listed fails this test
// with the offending name(s) -- forcing an explicit scoping decision instead of
// silently inheriting SessionGlobal by omission.

TEST_CASE ("classify: sketch_beatbox fails closed to session-global by design", "[multiplayer][lock]")
{
    // MoshOps::cmdSketchBeatbox lands its transduced hits via set_tempo +
    // create_track (drum) + add_midi_clip -- the first two are themselves
    // session-global, so sketch_beatbox is correctly left UNCLASSIFIED here
    // (falling through to the fail-closed default) rather than narrowly
    // track/clip-scoped.
    REQUIRE (LockManager::classify ("sketch_beatbox") == Scope::SessionGlobal);
}

namespace
{
    // Extracts every command name from MoshOps.cpp's dispatch table: lines of
    // the exact, consistently-used shape `if (name == "xxx")  return ...;`
    // (179 such lines currently; the only other `name ==` occurrences in the
    // file are an unrelated recipe-command allow-list and a plugin-name
    // comparison, neither of which has "return" on the same line, so they are
    // correctly excluded by the filter below).
    juce::StringArray extractDispatchedCommands (const juce::File& moshOpsCpp)
    {
        juce::StringArray out;
        juce::StringArray lines;
        lines.addLines (moshOpsCpp.loadFileAsString());
        for (auto& line : lines)
        {
            auto trimmed = line.trim();
            if (! trimmed.startsWith ("if (name == \""))
                continue;
            if (! trimmed.contains ("return"))
                continue;
            auto rest = trimmed.fromFirstOccurrenceOf ("if (name == \"", false, false);
            auto name = rest.upToFirstOccurrenceOf ("\"", false, false);
            if (name.isNotEmpty())
                out.addIfNotAlreadyThere (name);
        }
        return out;
    }

    // Commands dispatched by MoshOps that are DELIBERATELY left unclassified
    // (session-global by the fail-closed default), each with the one-line
    // reason it is safe to be global rather than track/clip-scoped. Keep this
    // list in sync by design, not by accident: a command belongs here only if
    // classifying it narrowly would be wrong (it structurally affects more than
    // one track, or -- like sketch_beatbox -- performs a session-global
    // mutation as part of its own effect).
    const std::set<juce::String>& intentionallySessionGlobal()
    {
        static const std::set<juce::String> allow {
            // Structural: create/rename/remove a track, bus, or group -- these
            // change the session's track list itself, not one existing track.
            "create_track", "create_bus", "create_group_track", "ungroup_track",
            "rename_bus", "remove_bus",
            // Song-structure sections/annotations span the whole timeline.
            "create_section", "rename_section", "move_section", "remove_section",
            "create_annotation", "edit_annotation", "move_annotation", "remove_annotation",
            // Tempo/key/time-signature/metronome are session-wide, not per-track.
            "set_tempo", "set_tempo_curve", "insert_tempo_change", "remove_tempo_change",
            "set_key",
            "set_time_signature", "insert_time_sig_change", "remove_time_sig_change",
            "set_metronome", "delete_time_range",
            // The master bus is not "a track" -- it is the session's one mix bus.
            "set_master_volume", "set_master_pan",
            // Project/session lifecycle.
            "open_recent", "recover_session", "discard_recovery",
            // Authors a multi-command recipe (tempo/key/tracks) -- see
            // isGeneratedRecipeCommandAllowed in MoshOps.cpp.
            "generate_beat_recipe",
            // Lands create_track + set_tempo internally (see the dedicated test
            // above) -- both already session-global on their own.
            "sketch_beatbox",
            // Multiplayer session-to-session signalling, not a track/clip edit.
            "mp_send_signal",
        };
        return allow;
    }
}

TEST_CASE ("classify: every MoshOps-dispatched command is classified or explicitly allow-listed as global (AL-011 drift guard)", "[multiplayer][lock]")
{
    // WORKING_DIRECTORY is pinned to the repo root for the MoshTests ctest entry
    // (tests/CMakeLists.txt) -- test_training.cpp already relies on the same
    // repo-root-relative resolution to shell out to service/training.
    auto repoRoot = juce::File::getCurrentWorkingDirectory();
    auto moshOpsCpp = repoRoot.getChildFile ("src/moshops/MoshOps.cpp");
    REQUIRE (moshOpsCpp.existsAsFile());

    auto dispatched = extractDispatchedCommands (moshOpsCpp);
    // Sanity floor on the extraction itself, so a regex/parse regression (e.g. the
    // dispatch table changing shape) fails loudly here instead of silently
    // passing with zero commands checked.
    REQUIRE (dispatched.size() > 150);

    juce::StringArray drifted;
    for (auto& name : dispatched)
        if (LockManager::classify (name) == Scope::SessionGlobal
            && intentionallySessionGlobal().count (name) == 0)
            drifted.add (name);

    juce::String driftMsg = "New MoshOps command(s) fall through to SessionGlobal without an "
        "explicit LockManager scope decision or an intentionallySessionGlobal() allow-list "
        "entry -- classify them (Track/Clip/Unguarded) or add them to the allow-list with a "
        "reason: " + drifted.joinIntoString (", ");
    INFO (driftMsg.toStdString());
    REQUIRE (drifted.isEmpty());
}
