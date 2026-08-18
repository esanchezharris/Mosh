#include <catch2/catch_test_macros.hpp>
#include "state/Migrations.h"
#include "state/Ids.h"

using namespace mosh;

namespace
{
    // A minimal stand-in for edit.state — the root Edit ValueTree that holds the
    // MOSH_PROJECT child the migration machinery reads/writes.
    juce::ValueTree makeEditState() { return juce::ValueTree ("EDIT"); }
    juce::ValueTree projectNode (const juce::ValueTree& st) { return st.getChildWithName (ids::MOSH_PROJECT); }
}

TEST_CASE ("absent version ⇒ v0 baseline, migrates to current", "[migrations]")
{
    auto st = makeEditState();
    REQUIRE (readFileVersion (st) == 0);

    auto r = migrateOrRefuse (st);
    REQUIRE (r.ok);
    REQUIRE (r.fromVersion == 0);
    REQUIRE (r.toVersion == kMoshFormatVersion);
    REQUIRE (projectNode (st).isValid());
    REQUIRE ((int) projectNode (st).getProperty (ids::moshFormatVersion) == kMoshFormatVersion);
}

TEST_CASE ("equal version ⇒ no-op success", "[migrations]")
{
    auto st = makeEditState();
    stampFormatVersion (st);
    REQUIRE (readFileVersion (st) == kMoshFormatVersion);

    auto r = migrateOrRefuse (st);
    REQUIRE (r.ok);
    REQUIRE (r.fromVersion == kMoshFormatVersion);
    REQUIRE (r.toVersion == kMoshFormatVersion);
}

TEST_CASE ("newer version ⇒ refusal, tree untouched", "[migrations]")
{
    auto st = makeEditState();
    auto node = juce::ValueTree (ids::MOSH_PROJECT);
    node.setProperty (ids::moshFormatVersion, kMoshFormatVersion + 1, nullptr);
    node.setProperty ("sentinel", 42, nullptr);          // must survive untouched
    st.appendChild (node, nullptr);

    auto r = migrateOrRefuse (st);
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("newer version of Mosh"));
    REQUIRE ((int) projectNode (st).getProperty (ids::moshFormatVersion) == kMoshFormatVersion + 1);
    REQUIRE ((int) projectNode (st).getProperty ("sentinel") == 42);
}

TEST_CASE ("migration registry is a contiguous 0..current chain", "[migrations]")
{
    int expected = 0;
    for (auto& s : migrations())
    {
        REQUIRE (s.from == expected);
        REQUIRE (s.to == s.from + 1);
        expected = s.to;
    }
    REQUIRE (expected == kMoshFormatVersion);
}

TEST_CASE ("illustrative v0->v1 step creates MOSH_PROJECT", "[migrations]")
{
    auto st = makeEditState();
    REQUIRE_FALSE (projectNode (st).isValid());

    auto r = migrateOrRefuse (st);
    REQUIRE (r.ok);
    REQUIRE (projectNode (st).isValid());   // proves a step body executed, not just the stamp
}

TEST_CASE ("unknown-but-present property/child survive migrateOrRefuse untouched (additive forward-compat)", "[migrations]")
{
    auto st = makeEditState();
    auto node = juce::ValueTree (ids::MOSH_PROJECT);
    node.setProperty (ids::moshFormatVersion, kMoshFormatVersion, nullptr);   // current version — no refusal, no migration
    node.setProperty ("futureMpField", "guest-cursor-color", nullptr);        // a property THIS build never wrote
    auto futureChild = juce::ValueTree ("MOSH_FUTURE_MULTIPLAYER_THING");     // a child node THIS build doesn't model
    futureChild.setProperty ("x", 7, nullptr);
    node.appendChild (futureChild, nullptr);
    st.appendChild (node, nullptr);

    auto r = migrateOrRefuse (st);
    REQUIRE (r.ok);
    REQUIRE (r.fromVersion == kMoshFormatVersion);
    REQUIRE (r.toVersion == kMoshFormatVersion);
    REQUIRE (projectNode (st).getProperty ("futureMpField").toString() == "guest-cursor-color");
    auto survivedChild = projectNode (st).getChildWithName ("MOSH_FUTURE_MULTIPLAYER_THING");
    REQUIRE (survivedChild.isValid());
    REQUIRE ((int) survivedChild.getProperty ("x") == 7);
}

// The chain-walk loop is proven at exactly ONE hop by the shipped v0->v1 step (kMoshFormatVersion
// is currently 1). Exercise the SAME production algorithm (detail::migrateOrRefuseImpl, which
// migrateOrRefuse is a thin wrapper over) at 3 hops via a synthetic registry, so a future
// multi-bump migration chain (plausible once multiplayer needs a real breaking change) is
// exercised BEFORE it ships, not discovered by it. Proves: steps apply IN ORDER, and each
// step's mutation is visible to the NEXT step (threaded through the same evolving tree).
TEST_CASE ("multi-hop chain applies 3 steps in order on the same evolving tree", "[migrations]")
{
    const std::vector<MigrationStep> steps = {
        { 0, 1, "add x", [] (juce::ValueTree& t) { t.setProperty ("x", 1, nullptr); } },
        { 1, 2, "add y from x", [] (juce::ValueTree& t)
              { t.setProperty ("y", (int) t.getProperty ("x") + 1, nullptr); } },
        { 2, 3, "add z from y", [] (juce::ValueTree& t)
              { t.setProperty ("z", (int) t.getProperty ("y") + 1, nullptr); } },
    };

    auto st = juce::ValueTree ("PROBE");
    auto r = detail::migrateOrRefuseImpl (st, 3, steps);
    REQUIRE (r.ok);
    REQUIRE (r.fromVersion == 0);
    REQUIRE (r.toVersion == 3);
    REQUIRE ((int) st.getProperty ("x") == 1);
    REQUIRE ((int) st.getProperty ("y") == 2);   // proves step 2 saw step 1's mutation
    REQUIRE ((int) st.getProperty ("z") == 3);   // proves step 3 saw step 2's mutation
}

// A broken (non-contiguous) chain must refuse GRACEFULLY at runtime — not merely trip the
// debug-only jassert (a Release build has no assert to catch it). This is the defensive path
// a genuinely-missing migration step would hit in production.
TEST_CASE ("multi-hop chain with a gap refuses gracefully (not just via jassert)", "[migrations]")
{
    const std::vector<MigrationStep> steps = {
        { 0, 1, "add x", [] (juce::ValueTree& t) { t.setProperty ("x", 1, nullptr); } },
        // gap: no {1,2,...} step
        { 2, 3, "add z", [] (juce::ValueTree& t) { t.setProperty ("z", 3, nullptr); } },
    };

    auto st = juce::ValueTree ("PROBE");
    auto r = detail::migrateOrRefuseImpl (st, 3, steps);
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("Missing migration step from format v1"));
    REQUIRE ((int) st.getProperty ("x") == 1);      // step 0->1 DID apply before the gap was hit
    REQUIRE_FALSE (st.hasProperty ("z"));           // step 2->3 never ran
}
