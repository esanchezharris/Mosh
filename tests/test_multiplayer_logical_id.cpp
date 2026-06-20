#include <catch2/catch_test_macros.hpp>
#include "multiplayer/LogicalId.h"
#include "state/Ids.h"

using namespace mosh;

// MP-001 — the load-bearing prerequisite: stable, cross-peer logical IDs stamped
// as plain UUID properties on a track's / bus's ValueTree. Pure ValueTree logic,
// engine-free, so it lives in the Catch2 unit suite.

TEST_CASE ("logicalid::ensureTrack stamps a UUID when absent", "[multiplayer][logicalid]")
{
    juce::ValueTree track ("TRACK");
    REQUIRE (logicalid::track (track).isEmpty());          // none to start

    const auto id = logicalid::ensureTrack (track);

    REQUIRE (id.isNotEmpty());                              // a UUID was minted
    REQUIRE (id.length() >= 32);                            // looks like a juce::Uuid string
    REQUIRE (track.hasProperty (ids::moshLogicalId));       // persisted on the tree
    REQUIRE (logicalid::track (track) == id);               // readable back
}

TEST_CASE ("logicalid::ensureTrack is idempotent (same id on re-ensure)", "[multiplayer][logicalid]")
{
    juce::ValueTree track ("TRACK");
    const auto first  = logicalid::ensureTrack (track);
    const auto second = logicalid::ensureTrack (track);
    REQUIRE (first == second);                             // never re-stamps an existing identity
}

TEST_CASE ("logicalid mints distinct ids for distinct tracks", "[multiplayer][logicalid]")
{
    juce::ValueTree a ("TRACK"), b ("TRACK");
    REQUIRE (logicalid::ensureTrack (a) != logicalid::ensureTrack (b));
}

TEST_CASE ("logicalid::findTrack locates a nested descendant by id", "[multiplayer][logicalid]")
{
    juce::ValueTree edit ("EDIT");
    juce::ValueTree t1 ("TRACK"), t2 ("TRACK"), t3 ("TRACK");
    edit.appendChild (t1, nullptr);
    edit.appendChild (t2, nullptr);
    t2.appendChild (t3, nullptr);                          // nested (group/submix child)

    const auto wantId = logicalid::ensureTrack (t3);
    logicalid::ensureTrack (t1);
    logicalid::ensureTrack (t2);

    auto found = logicalid::findTrack (edit, wantId);
    REQUIRE (found.isValid());
    REQUIRE (logicalid::track (found) == wantId);
    REQUIRE (found == t3);

    REQUIRE_FALSE (logicalid::findTrack (edit, "no-such-id").isValid());  // miss → invalid
    REQUIRE_FALSE (logicalid::findTrack (edit, {}).isValid());            // empty query → invalid
}

TEST_CASE ("logicalid track and bus identities are independent", "[multiplayer][logicalid]")
{
    juce::ValueTree node ("TRACK");
    const auto t = logicalid::ensureTrack (node);
    const auto b = logicalid::ensureBus (node);
    REQUIRE (t != b);
    REQUIRE (logicalid::track (node) == t);
    REQUIRE (logicalid::bus (node) == b);
    REQUIRE (node.hasProperty (ids::moshLogicalId));
    REQUIRE (node.hasProperty (ids::mpBusId));
}

TEST_CASE ("logicalid::get is empty/safe for absent or invalid trees", "[multiplayer][logicalid]")
{
    REQUIRE (logicalid::track (juce::ValueTree()).isEmpty());   // invalid tree
    juce::ValueTree fresh ("TRACK");
    REQUIRE (logicalid::track (fresh).isEmpty());               // absent property
}
