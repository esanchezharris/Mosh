#include <catch2/catch_test_macros.hpp>
#include "state/Section.h"
#include "state/Ids.h"

using namespace mosh;

TEST_CASE ("MOSH_SECTION builds + round-trips through XML (SEC-001)", "[sections]")
{
    auto v = Section::create ("sec-1", "Hook", 24.0, 40.0, "#f4c0d1");
    REQUIRE (v.getType() == ids::MOSH_SECTION);
    REQUIRE (v[ids::id].toString() == "sec-1");
    REQUIRE (v[ids::sectionName].toString() == "Hook");
    REQUIRE ((double) v[ids::sectionStartBeat] == 24.0);
    REQUIRE ((double) v[ids::sectionEndBeat] == 40.0);
    REQUIRE (v[ids::sectionColor].toString() == "#f4c0d1");

    // XML round-trip proves it serializes/reloads with the .tracktionedit.
    auto back = juce::ValueTree::fromXml (v.toXmlString());
    REQUIRE (back.getType() == ids::MOSH_SECTION);
    REQUIRE (back[ids::sectionName].toString() == "Hook");
    REQUIRE ((double) back[ids::sectionEndBeat] == 40.0);
}

TEST_CASE ("a section with no colour omits the colour property", "[sections]")
{
    auto v = Section::create ("sec-2", "Verse", 8.0, 24.0);
    REQUIRE_FALSE (v.hasProperty (ids::sectionColor));
}

TEST_CASE ("a MOSH_SECTIONS container of sections persists in order + is id-addressable (SEC-001)", "[sections]")
{
    juce::ValueTree sections (ids::MOSH_SECTIONS);
    sections.appendChild (Section::create ("a", "Intro", 0.0, 8.0), nullptr);
    sections.appendChild (Section::create ("b", "Verse", 8.0, 24.0), nullptr);
    sections.appendChild (Section::create ("c", "Hook", 24.0, 40.0), nullptr);

    auto back = juce::ValueTree::fromXml (sections.toXmlString());
    REQUIRE (back.getNumChildren() == 3);
    REQUIRE (back.getChild (0)[ids::sectionName].toString() == "Intro");
    REQUIRE (back.getChild (2)[ids::id].toString() == "c");
    // getChildWithProperty(id, …) is exactly how rename/move/remove_section find a section.
    REQUIRE (back.getChildWithProperty (ids::id, "b")[ids::sectionName].toString() == "Verse");
    REQUIRE_FALSE (back.getChildWithProperty (ids::id, "missing").isValid());
}
