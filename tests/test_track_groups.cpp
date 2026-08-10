#include <catch2/catch_test_macros.hpp>
#include "state/TrackGroup.h"
#include "state/Ids.h"

using namespace mosh;

TEST_CASE ("track groups persist non-routing Edit and Mix membership", "[track-groups]")
{
    juce::ValueTree groups (ids::MOSH_TRACK_GROUPS);
    groups.appendChild (TrackGroup::create ("edit-mix", "Rhythm", "edit_mix",
                                            { "track-a", "track-b" }), nullptr);
    groups.appendChild (TrackGroup::create ("mix", "Band", "mix",
                                            { "track-b", "track-c" }), nullptr);

    REQUIRE (TrackGroup::linkedMemberIds (groups, "track-a", TrackGroup::Axis::Edit)
             == juce::StringArray { "track-a", "track-b" });
    REQUIRE (TrackGroup::linkedMemberIds (groups, "track-a", TrackGroup::Axis::Mix)
             == juce::StringArray { "track-a", "track-b", "track-c" });

    const auto restored = juce::ValueTree::fromXml (groups.toXmlString());
    REQUIRE (restored.hasType (ids::MOSH_TRACK_GROUPS));
    REQUIRE (restored.getNumChildren() == 2);
    REQUIRE (TrackGroup::memberIds (restored.getChild (0))
             == juce::StringArray { "track-a", "track-b" });
}

TEST_CASE ("track group suspension bypasses all linkage without deleting groups", "[track-groups]")
{
    juce::ValueTree groups (ids::MOSH_TRACK_GROUPS);
    groups.appendChild (TrackGroup::create ("group-1", "Rhythm", "edit_mix",
                                            { "track-a", "track-b" }), nullptr);
    groups.setProperty (ids::trackGroupsSuspended, true, nullptr);

    REQUIRE (TrackGroup::linkedMemberIds (groups, "track-a", TrackGroup::Axis::Edit)
             == juce::StringArray { "track-a" });
    REQUIRE (TrackGroup::linkedMemberIds (groups, "track-a", TrackGroup::Axis::Mix)
             == juce::StringArray { "track-a" });
    REQUIRE (groups.getNumChildren() == 1);
}

TEST_CASE ("disabled track groups do not bridge overlapping membership", "[track-groups]")
{
    juce::ValueTree groups (ids::MOSH_TRACK_GROUPS);
    groups.appendChild (TrackGroup::create ("group-1", "Rhythm", "mix",
                                            { "track-a", "track-b" }), nullptr);
    auto bridge = TrackGroup::create ("group-2", "Band", "edit_mix",
                                      { "track-b", "track-c" });
    bridge.setProperty (ids::trackGroupEnabled, false, nullptr);
    groups.appendChild (bridge, nullptr);

    REQUIRE (TrackGroup::linkedMemberIds (groups, "track-a", TrackGroup::Axis::Mix)
             == juce::StringArray { "track-a", "track-b" });
    REQUIRE (TrackGroup::linkedMemberIds (groups, "track-c", TrackGroup::Axis::Edit)
             == juce::StringArray { "track-c" });
}

TEST_CASE ("track group membership replacement is ordered, unique, and undoable", "[track-groups]")
{
    auto group = TrackGroup::create ("group-1", "Rhythm", "edit_mix",
                                     { "track-a", "track-b" });
    group.appendChild (juce::ValueTree ("UNRELATED"), nullptr);
    juce::UndoManager undo;
    undo.beginNewTransaction ("set_track_group_members");

    TrackGroup::replaceMemberIds (group, { "track-c", "track-c", "track-a" }, &undo);
    REQUIRE (TrackGroup::memberIds (group) == juce::StringArray { "track-c", "track-a" });
    REQUIRE (group.getChildWithName ("UNRELATED").isValid());

    REQUIRE (undo.undo());
    REQUIRE (TrackGroup::memberIds (group) == juce::StringArray { "track-a", "track-b" });
    REQUIRE (group.getChildWithName ("UNRELATED").isValid());
}
