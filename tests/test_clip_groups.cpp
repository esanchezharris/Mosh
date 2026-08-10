#include <catch2/catch_test_macros.hpp>
#include "moshops/RecoveryIds.h"
#include "state/ClipGroup.h"
#include "state/Ids.h"

using namespace mosh;

TEST_CASE ("clip groups persist members, identity, name, and active state", "[clip-groups]")
{
    auto group = ClipGroup::create ("group-1", "Rhythm Group", { "clip-a", "clip-b" });
    REQUIRE (group.hasType (ids::MOSH_CLIP_GROUP));
    REQUIRE (group[ids::id].toString() == "group-1");
    REQUIRE (group[ids::clipGroupName].toString() == "Rhythm Group");
    REQUIRE ((bool) group[ids::clipGroupActive]);
    REQUIRE (ClipGroup::memberIds (group) == juce::StringArray { "clip-a", "clip-b" });

    auto back = juce::ValueTree::fromXml (group.toXmlString());
    REQUIRE (back.hasType (ids::MOSH_CLIP_GROUP));
    REQUIRE (ClipGroup::memberIds (back) == juce::StringArray { "clip-a", "clip-b" });
}

TEST_CASE ("clip group member parsing ignores duplicate and unrelated nodes", "[clip-groups]")
{
    auto group = ClipGroup::create ("group-2", "Vocals", { "clip-a", "clip-a" });
    group.appendChild (juce::ValueTree ("UNRELATED"), nullptr);
    REQUIRE (ClipGroup::memberIds (group) == juce::StringArray { "clip-a" });
}

TEST_CASE ("recovery id rebinding reaches clip group member arrays", "[clip-groups][recovery]")
{
    juce::HashMap<juce::String, juce::String> idMap;
    idMap.set ("old-a", "new-a");
    idMap.set ("old-b", "new-b");
    auto* nested = new juce::DynamicObject();
    nested->setProperty ("leader", "old-a");
    auto* args = new juce::DynamicObject();
    args->setProperty ("clipIds", juce::Array<juce::var> { "old-a", "old-b", "stable" });
    args->setProperty ("metadata", juce::var (nested));

    const auto rebound = recovery::substituteIds (juce::var (args), idMap);
    const auto* clipIds = rebound.getProperty ("clipIds", {}).getArray();
    REQUIRE (clipIds != nullptr);
    REQUIRE (clipIds->size() == 3);
    REQUIRE ((*clipIds)[0].toString() == "new-a");
    REQUIRE ((*clipIds)[1].toString() == "new-b");
    REQUIRE ((*clipIds)[2].toString() == "stable");
    REQUIRE (rebound.getProperty ("metadata", {}).getProperty ("leader", {}).toString() == "new-a");
}
