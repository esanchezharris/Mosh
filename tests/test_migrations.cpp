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
