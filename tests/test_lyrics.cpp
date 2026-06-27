#include <catch2/catch_test_macros.hpp>
#include "state/Lyrics.h"
#include "state/Ids.h"

using namespace mosh;

TEST_CASE ("MOSH_LYRICSHEET builds with a LYRIC_LINES container + defaults (LYR-001)", "[lyrics]")
{
    auto v = LyricSheet::create ("ls-1", "1/16", "en");
    REQUIRE (v.getType() == ids::MOSH_LYRICSHEET);
    REQUIRE (v[ids::id].toString() == "ls-1");
    REQUIRE (v[ids::lyricGrid].toString() == "1/16");
    REQUIRE (v[ids::lyricLanguage].toString() == "en");
    REQUIRE (v[ids::lyricExplicit].toString() == "allow");
    REQUIRE (v[ids::lyricRhymeStrictness].toString() == "slant");   // rap default
    REQUIRE ((int) v[ids::lyricSpecVersion] == 1);
    REQUIRE (LyricSheet::lines (v).isValid());
    REQUIRE (LyricSheet::lines (v).getNumChildren() == 0);
}

TEST_CASE ("MOSH_LYRICLINE carries the constraint spec + round-trips through XML", "[lyrics]")
{
    auto line = LyricLine::create ("ln-1", 0, "hook");
    line.setProperty (ids::lyricSeedText, "yeah I came back ___ ___ the ___", nullptr);
    line.setProperty (ids::lyricSyllableTarget, 9, nullptr);
    line.setProperty (ids::lyricRhymeGroup, "A", nullptr);
    line.setProperty (ids::lyricLocked, true, nullptr);

    auto back = juce::ValueTree::fromXml (line.toXmlString());
    REQUIRE (back.getType() == ids::MOSH_LYRICLINE);
    REQUIRE (back[ids::lyricRole].toString() == "hook");
    REQUIRE ((int) back[ids::lyricIndex] == 0);
    REQUIRE (back[ids::lyricSeedText].toString() == "yeah I came back ___ ___ the ___");
    REQUIRE ((int) back[ids::lyricSyllableTarget] == 9);
    REQUIRE (back[ids::lyricRhymeGroup].toString() == "A");
    REQUIRE ((bool) back[ids::lyricLocked] == true);
}

TEST_CASE ("a sheet of ordered, id-addressable lines persists through XML", "[lyrics]")
{
    auto sheet = LyricSheet::create ("ls-2");
    auto container = LyricSheet::lines (sheet);
    container.appendChild (LyricLine::create ("a", 0, "verse"), nullptr);
    container.appendChild (LyricLine::create ("b", 1, "verse"), nullptr);
    container.appendChild (LyricLine::create ("c", 2, "hook"), nullptr);

    auto back = juce::ValueTree::fromXml (sheet.toXmlString());
    auto backLines = LyricSheet::lines (back);
    REQUIRE (backLines.getNumChildren() == 3);
    REQUIRE (backLines.getChild (0)[ids::id].toString() == "a");
    REQUIRE (backLines.getChild (2)[ids::lyricRole].toString() == "hook");
    // getChildWithProperty(id,…) is how set_lyric_line / remove_lyric_line find a line.
    REQUIRE (backLines.getChildWithProperty (ids::id, "b")[ids::lyricIndex].toString() == "1");
    REQUIRE_FALSE (backLines.getChildWithProperty (ids::id, "missing").isValid());
}

TEST_CASE ("L2 transient proposals (JSON blob) + regen round-trip on a line", "[lyrics][l2]")
{
    auto line = LyricLine::create ("ln-1", 0, "verse");
    line.setProperty (ids::lyricSeedText, "they counted me out ___ ___", nullptr);
    // The command lands the ranked proposals as a JSON-string blob (non-undoable) +
    // a regen counter; both must survive serialization with the .tracktionedit.
    line.setProperty (ids::lyricProposals,
                      "[{\"text\":\"they counted me out over flame\",\"syllables\":8,\"passes\":true,\"grade\":\"slant\",\"endWord\":\"flame\"}]",
                      nullptr);
    line.setProperty (ids::lyricRegen, 2, nullptr);

    auto back = juce::ValueTree::fromXml (line.toXmlString());
    REQUIRE ((int) back[ids::lyricRegen] == 2);
    auto parsed = juce::JSON::parse (back[ids::lyricProposals].toString());
    REQUIRE (parsed.isArray());
    REQUIRE (parsed.size() == 1);
    REQUIRE (parsed[0].getProperty ("endWord", juce::var()).toString() == "flame");
    REQUIRE ((bool) parsed[0].getProperty ("passes", false) == true);

    // A fresh line carries NEITHER (proposals are added only by the generation loop).
    auto fresh = LyricLine::create ("ln-2", 1, "verse");
    REQUIRE_FALSE (fresh.hasProperty (ids::lyricProposals));
    REQUIRE_FALSE (fresh.hasProperty (ids::lyricRegen));
}

TEST_CASE ("L1 transient analysis (JSON object blob) round-trips on a line", "[lyrics][l1]")
{
    auto line = LyricLine::create ("ln-1", 0, "verse");
    line.setProperty (ids::lyricText, "lighting up the flame", nullptr);
    // analyze_lyrics lands precise phonology as a JSON-OBJECT blob (non-undoable). It
    // must survive serialization, and lyricSheetToVar parses it back to an object for
    // the snapshot → flow visualizer.
    line.setProperty (ids::lyricAnalysis,
                      "{\"syllables\":5,\"target\":5,\"syllableOk\":true,\"endWord\":\"flame\","
                      "\"rhymeGrade\":\"anchor\",\"rhymeOk\":true,\"stress\":\"XxXxX\","
                      "\"words\":[{\"w\":\"flame\",\"syllables\":1,\"stress\":\"X\",\"inDict\":true}],"
                      "\"complete\":true,\"analyzed\":\"text\"}",
                      nullptr);

    auto back = juce::ValueTree::fromXml (line.toXmlString());
    auto parsed = juce::JSON::parse (back[ids::lyricAnalysis].toString());
    REQUIRE (parsed.isObject());
    REQUIRE ((int) parsed.getProperty ("syllables", juce::var()) == 5);
    REQUIRE (parsed.getProperty ("rhymeGrade", juce::var()).toString() == "anchor");
    REQUIRE ((bool) parsed.getProperty ("complete", false) == true);
    REQUIRE (parsed.getProperty ("words", juce::var()).isArray());

    // A fresh line has no analysis until analyze_lyrics runs (it's recomputable).
    auto fresh = LyricLine::create ("ln-2", 1, "verse");
    REQUIRE_FALSE (fresh.hasProperty (ids::lyricAnalysis));
}

TEST_CASE ("lineFingerprint is stable + sensitive to every constraint input", "[lyrics][cache]")
{
    auto sheet = LyricSheet::create ("ls-3");
    sheet.setProperty (ids::lyricTopic, "comeback", nullptr);
    auto line = LyricLine::create ("ln-1", 0, "verse");
    line.setProperty (ids::lyricSeedText, "yeah I came back ___", nullptr);
    line.setProperty (ids::lyricSyllableTarget, 9, nullptr);
    line.setProperty (ids::lyricRhymeGroup, "A", nullptr);

    const auto base = LyricSheet::lineFingerprint (sheet, line, "ctxAAA", "svc-1");

    SECTION ("same inputs → same key")
    {
        REQUIRE (LyricSheet::lineFingerprint (sheet, line, "ctxAAA", "svc-1") == base);
    }
    SECTION ("changing the seed text → different key")
    {
        line.setProperty (ids::lyricSeedText, "yeah I came back ___ ___", nullptr);
        REQUIRE (LyricSheet::lineFingerprint (sheet, line, "ctxAAA", "svc-1") != base);
    }
    SECTION ("changing the syllable target → different key")
    {
        line.setProperty (ids::lyricSyllableTarget, 11, nullptr);
        REQUIRE (LyricSheet::lineFingerprint (sheet, line, "ctxAAA", "svc-1") != base);
    }
    SECTION ("changing the rhyme group → different key")
    {
        line.setProperty (ids::lyricRhymeGroup, "B", nullptr);
        REQUIRE (LyricSheet::lineFingerprint (sheet, line, "ctxAAA", "svc-1") != base);
    }
    SECTION ("changing the sheet topic → different key")
    {
        sheet.setProperty (ids::lyricTopic, "heartbreak", nullptr);
        REQUIRE (LyricSheet::lineFingerprint (sheet, line, "ctxAAA", "svc-1") != base);
    }
    SECTION ("changing the upstream context (chosen end-words) → different key")
    {
        REQUIRE (LyricSheet::lineFingerprint (sheet, line, "ctxBBB", "svc-1") != base);
    }
    SECTION ("a blank line strictness INHERITS the sheet default in the key")
    {
        // line strictness "" inherits sheet "slant"; setting it explicitly to "slant"
        // must produce the SAME key (the inherited value is what's hashed).
        auto explicitSlant = line.createCopy();
        explicitSlant.setProperty (ids::lyricRhymeStrictness, "slant", nullptr);
        REQUIRE (LyricSheet::lineFingerprint (sheet, explicitSlant, "ctxAAA", "svc-1") == base);
        // …and changing the sheet default then re-inheriting changes the key.
        sheet.setProperty (ids::lyricRhymeStrictness, "perfect", nullptr);
        REQUIRE (LyricSheet::lineFingerprint (sheet, line, "ctxAAA", "svc-1") != base);
    }
}
