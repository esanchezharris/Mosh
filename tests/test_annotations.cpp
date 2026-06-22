#include <catch2/catch_test_macros.hpp>
#include "state/Annotation.h"
#include "state/Ids.h"

using namespace mosh;

TEST_CASE ("MOSH_ANNOTATION builds + round-trips through XML (ANN-001)", "[annotations]")
{
    auto v = Annotation::create ("ann-1", "tighten this transition", 24.0, "#ffd166", "alice");
    REQUIRE (v.getType() == ids::MOSH_ANNOTATION);
    REQUIRE (v[ids::id].toString() == "ann-1");
    REQUIRE (v[ids::annotationText].toString() == "tighten this transition");
    REQUIRE ((double) v[ids::annotationBeat] == 24.0);
    REQUIRE (v[ids::annotationColor].toString() == "#ffd166");
    REQUIRE (v[ids::annotationAuthor].toString() == "alice");

    // XML round-trip proves it serializes/reloads with the .tracktionedit.
    auto back = juce::ValueTree::fromXml (v.toXmlString());
    REQUIRE (back.getType() == ids::MOSH_ANNOTATION);
    REQUIRE (back[ids::annotationText].toString() == "tighten this transition");
    REQUIRE ((double) back[ids::annotationBeat] == 24.0);
    REQUIRE (back[ids::annotationAuthor].toString() == "alice");
}

TEST_CASE ("an annotation with no colour/author omits those properties", "[annotations]")
{
    auto v = Annotation::create ("ann-2", "note", 8.0);
    REQUIRE_FALSE (v.hasProperty (ids::annotationColor));
    REQUIRE_FALSE (v.hasProperty (ids::annotationAuthor));
}

TEST_CASE ("a MOSH_ANNOTATIONS container is id-addressable (ANN-001)", "[annotations]")
{
    juce::ValueTree anns (ids::MOSH_ANNOTATIONS);
    anns.appendChild (Annotation::create ("a", "intro idea", 0.0, {}, "you"), nullptr);
    anns.appendChild (Annotation::create ("b", "fix transition", 24.0, "#ffd166", "alice"), nullptr);

    auto back = juce::ValueTree::fromXml (anns.toXmlString());
    REQUIRE (back.getNumChildren() == 2);
    // getChildWithProperty(id, …) is exactly how edit/move/remove_annotation find one.
    REQUIRE (back.getChildWithProperty (ids::id, "b")[ids::annotationText].toString() == "fix transition");
    REQUIRE (back.getChildWithProperty (ids::id, "b")[ids::annotationAuthor].toString() == "alice");
    REQUIRE_FALSE (back.getChildWithProperty (ids::id, "missing").isValid());
}
