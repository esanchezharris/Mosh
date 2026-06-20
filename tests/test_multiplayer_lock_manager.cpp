#include <catch2/catch_test_macros.hpp>
#include "multiplayer/LockManager.h"

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
}

TEST_CASE ("classify: single-track mutations are track-scoped", "[multiplayer][lock]")
{
    REQUIRE (LockManager::classify ("rename_track")     == Scope::Track);
    REQUIRE (LockManager::classify ("set_track_volume") == Scope::Track);
    REQUIRE (LockManager::classify ("load_plugin")      == Scope::Track);
    REQUIRE (LockManager::classify ("set_plugin_param") == Scope::Track);
    REQUIRE (LockManager::classify ("add_neural_insert")== Scope::Track);
    REQUIRE (LockManager::classify ("add_midi_clip")    == Scope::Track);
}

TEST_CASE ("classify: clip mutations are clip-scoped", "[multiplayer][lock]")
{
    REQUIRE (LockManager::classify ("move_clip")      == Scope::Clip);
    REQUIRE (LockManager::classify ("trim_clip")      == Scope::Clip);
    REQUIRE (LockManager::classify ("split_clip")     == Scope::Clip);
    REQUIRE (LockManager::classify ("add_note")       == Scope::Clip);
    REQUIRE (LockManager::classify ("set_clip_gain")  == Scope::Clip);
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
