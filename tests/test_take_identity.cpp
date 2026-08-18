#include <catch2/catch_test_macros.hpp>

#include "state/TakeIdentity.h"

TEST_CASE ("take ids are unique, idempotent, and persisted", "[takes][identity]")
{
    juce::ValueTree edit ("EDIT"), clip ("WAVECLIP"), takes ("TAKES");
    for (auto source : { "a.wav", "a.wav", "b.wav" })
    {
        juce::ValueTree take ("TAKE");
        take.setProperty ("source", source, nullptr);
        takes.appendChild (take, nullptr);
    }
    clip.appendChild (takes, nullptr);
    edit.appendChild (clip, nullptr);

    REQUIRE (mosh::takeidentity::backfill (edit) == 3);
    const auto id0 = mosh::takeidentity::idFor (takes.getChild (0));
    const auto id1 = mosh::takeidentity::idFor (takes.getChild (1));
    const auto id2 = mosh::takeidentity::idFor (takes.getChild (2));
    CHECK (mosh::takeidentity::isValid (id0));
    CHECK (mosh::takeidentity::isValid (id1));
    CHECK (mosh::takeidentity::isValid (id2));
    CHECK (id0 != id1);
    CHECK (id1 != id2);
    CHECK (id0 != id2);

    // Idempotent: a second backfill over the same, now-fully-stamped tree writes nothing.
    CHECK (mosh::takeidentity::backfill (edit) == 0);
    // ...and does not change the ids already written.
    CHECK (mosh::takeidentity::idFor (takes.getChild (0)) == id0);
}

TEST_CASE ("isValid accepts only a lowercase dashed 36-char uuid shape", "[takes][identity]")
{
    CHECK (mosh::takeidentity::isValid (mosh::takeidentity::newId()));
    CHECK_FALSE (mosh::takeidentity::isValid (""));
    CHECK_FALSE (mosh::takeidentity::isValid ("not-a-uuid"));
    // Uppercase hex is rejected — newId() always emits lowercase, and a caller-supplied
    // id must match exactly, never be case-folded.
    CHECK_FALSE (mosh::takeidentity::isValid ("A1B2C3D4-0000-0000-0000-000000000000"));
    // Right length, wrong dash positions.
    CHECK_FALSE (mosh::takeidentity::isValid ("a1b2c3d4-0000-0000-0000-00000000000-"));
    // One character short / long of the exact 36.
    CHECK_FALSE (mosh::takeidentity::isValid ("a1b2c3d4-0000-0000-0000-00000000000"));
    CHECK_FALSE (mosh::takeidentity::isValid ("a1b2c3d4-0000-0000-0000-0000000000000"));
    // Non-hex character in a hex position.
    CHECK_FALSE (mosh::takeidentity::isValid ("g1b2c3d4-0000-0000-0000-000000000000"));
}

TEST_CASE ("backfill never replaces an existing id, however it is shaped", "[takes][identity]")
{
    juce::ValueTree edit ("EDIT"), clip ("WAVECLIP"), takes ("TAKES"), take ("TAKE");
    take.setProperty ("source", "a.wav", nullptr);
    take.setProperty ("moshTakeId", "not-a-real-uuid", nullptr);   // malformed legacy value
    takes.appendChild (take, nullptr);
    clip.appendChild (takes, nullptr);
    edit.appendChild (clip, nullptr);

    CHECK (mosh::takeidentity::backfill (edit) == 0);
    CHECK (mosh::takeidentity::idFor (takes.getChild (0)) == "not-a-real-uuid");
}

TEST_CASE ("backfill only stamps source-bearing TAKES children, never clips or plug-ins", "[takes][identity]")
{
    juce::ValueTree edit ("EDIT"), clip ("WAVECLIP"), takes ("TAKES");
    juce::ValueTree sourced ("TAKE");
    sourced.setProperty ("source", "a.wav", nullptr);
    juce::ValueTree unsourced ("TAKE");   // no "source" property — not a real take
    takes.appendChild (sourced, nullptr);
    takes.appendChild (unsourced, nullptr);
    clip.appendChild (takes, nullptr);
    edit.appendChild (clip, nullptr);

    REQUIRE (mosh::takeidentity::backfill (edit) == 1);
    CHECK (mosh::takeidentity::isValid (mosh::takeidentity::idFor (takes.getChild (0))));
    CHECK (mosh::takeidentity::idFor (takes.getChild (1)).isEmpty());
    // The clip and TAKES node themselves are never stamped.
    CHECK_FALSE (clip.hasProperty ("moshTakeId"));
    CHECK_FALSE (takes.hasProperty ("moshTakeId"));
}

TEST_CASE ("orderedIds reports one id per source-bearing take, in take-index order", "[takes][identity]")
{
    juce::ValueTree takes ("TAKES");
    juce::ValueTree t0 ("TAKE"), t1 ("TAKE"), notATake ("TAKE");
    t0.setProperty ("source", "a.wav", nullptr);
    t1.setProperty ("source", "b.wav", nullptr);
    // notATake has no "source" — must be skipped, not counted as an index slot.
    takes.appendChild (t0, nullptr);
    takes.appendChild (notATake, nullptr);
    takes.appendChild (t1, nullptr);

    juce::ValueTree edit ("EDIT"), clip ("WAVECLIP");
    clip.appendChild (takes, nullptr);
    edit.appendChild (clip, nullptr);
    REQUIRE (mosh::takeidentity::backfill (edit) == 2);

    const auto ids = mosh::takeidentity::orderedIds (takes);
    REQUIRE (ids.size() == 2);
    CHECK (ids[0] == mosh::takeidentity::idFor (t0));
    CHECK (ids[1] == mosh::takeidentity::idFor (t1));
    CHECK (ids[0] != ids[1]);
}

TEST_CASE ("backfill recurses through an arbitrarily nested tree to find every TAKES node", "[takes][identity]")
{
    // Two clips (two TAKES nodes) under one track under the edit — backfill must find both,
    // not just a TAKES node directly under the root it was called on.
    juce::ValueTree edit ("EDIT"), track ("TRACK");
    juce::ValueTree clipA ("WAVECLIP"), takesA ("TAKES"), takeA ("TAKE");
    takeA.setProperty ("source", "a.wav", nullptr);
    takesA.appendChild (takeA, nullptr);
    clipA.appendChild (takesA, nullptr);

    juce::ValueTree clipB ("WAVECLIP"), takesB ("TAKES"), takeB ("TAKE");
    takeB.setProperty ("source", "b.wav", nullptr);
    takesB.appendChild (takeB, nullptr);
    clipB.appendChild (takesB, nullptr);

    track.appendChild (clipA, nullptr);
    track.appendChild (clipB, nullptr);
    edit.appendChild (track, nullptr);

    REQUIRE (mosh::takeidentity::backfill (edit) == 2);
    CHECK (mosh::takeidentity::isValid (mosh::takeidentity::idFor (takesA.getChild (0))));
    CHECK (mosh::takeidentity::isValid (mosh::takeidentity::idFor (takesB.getChild (0))));
    CHECK (mosh::takeidentity::idFor (takesA.getChild (0)) != mosh::takeidentity::idFor (takesB.getChild (0)));
}
