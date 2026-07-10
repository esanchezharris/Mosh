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

TEST_CASE ("L1+§7 sheet constraints (styleBias) round-trip through XML", "[lyrics][rag]")
{
    auto v = LyricSheet::create ("ls-1", "1/16", "en");
    // §7 style-RAG opt-in: a sheet-level bool set by set_lyric_constraint, undoable,
    // serialized in the snapshot/edit. Absent ⇒ false (additive, no format bump).
    REQUIRE_FALSE ((bool) v[ids::lyricStyleBias]);
    v.setProperty (ids::lyricStyleBias, true, nullptr);
    auto back = juce::ValueTree::fromXml (v.toXmlString());
    REQUIRE ((bool) back[ids::lyricStyleBias] == true);
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

TEST_CASE ("Phase-2 skeleton lands lines `skeleton` + survives serialization (LYR-P2)", "[lyrics][skeleton]")
{
    // build_skeleton_from_clip lands a wordless, EDITABLE skeleton: every line `skeleton`
    // (the human-in-the-loop grid gate; distinct from L2 `proposed`) with an all-gaps seed +
    // a syllable target. The status must round-trip with the .tracktionedit (additive node).
    auto sheet = LyricSheet::create ("ls-skel", "1/8");
    auto container = LyricSheet::lines (sheet);
    for (int i = 0; i < 2; ++i)
    {
        auto line = LyricLine::create (juce::String ("sk") + juce::String (i), i, "verse");
        line.setProperty (ids::lyricSeedText, "___ ___ ___", nullptr);
        line.setProperty (ids::lyricSyllableTarget, 3, nullptr);
        line.setProperty (ids::lyricStress, "XxX", nullptr);
        line.setProperty (ids::status, "skeleton", nullptr);
        container.appendChild (line, nullptr);
    }

    auto back = juce::ValueTree::fromXml (sheet.toXmlString());
    auto backLines = LyricSheet::lines (back);
    REQUIRE (backLines.getNumChildren() == 2);
    REQUIRE (backLines.getChild (0)[ids::status].toString() == "skeleton");
    REQUIRE (backLines.getChild (0)[ids::lyricSeedText].toString() == "___ ___ ___");
    REQUIRE ((int) backLines.getChild (1)[ids::lyricSyllableTarget] == 3);

    // confirm_skeleton's effect: every `skeleton` line flips to `seed` (eligible for the
    // generation loop); already-`seed`/other lines are untouched.
    backLines.getChild (1).setProperty (ids::status, "seed", nullptr);   // pre-existing seed line
    int flipped = 0;
    for (int i = 0; i < backLines.getNumChildren(); ++i)
        if (backLines.getChild (i)[ids::status].toString() == "skeleton")
        {
            backLines.getChild (i).setProperty (ids::status, "seed", nullptr);
            ++flipped;
        }
    REQUIRE (flipped == 1);
    for (int i = 0; i < backLines.getNumChildren(); ++i)
        REQUIRE (backLines.getChild (i)[ids::status].toString() == "seed");
}

TEST_CASE ("Phase-3 lyricScore (render-ready score blob) persists on a skeleton line", "[lyrics][skeleton][score]")
{
    // Stage 1 (kill-shot B GO 2026-07-04): build_skeleton_from_clip lands the take's
    // articulation groups as a per-line JSON blob — melisma slots carry per-note segments.
    // PERSISTED (unlike the transient proposals/analysis blobs): it is the Phase-3 render
    // skeleton the SoulX adapter will author its target score from.
    auto line = LyricLine::create ("sc-1", 0, "verse");
    line.setProperty (ids::status, "skeleton", nullptr);
    line.setProperty (ids::lyricScore,
                      "{\"v\":1,\"algo\":\"v3\",\"bar\":0,\"bpm\":120.0,\"timeSig\":[4,4],"
                      "\"grid\":\"1/8\",\"clamped\":false,\"slots\":[{\"start\":0.0,\"end\":1.0,"
                      "\"velocity\":100.0,\"kind\":\"attack\",\"segments\":[{\"start\":0.0,"
                      "\"end\":0.5,\"pitch\":57},{\"start\":0.5,\"end\":1.0,\"pitch\":60}]}]}",
                      nullptr);

    auto back = juce::ValueTree::fromXml (line.toXmlString());
    auto parsed = juce::JSON::parse (back[ids::lyricScore].toString());
    REQUIRE (parsed.isObject());
    REQUIRE ((int) parsed.getProperty ("v", juce::var (0)) == 1);
    REQUIRE (parsed.getProperty ("algo", juce::var()).toString() == "v3");
    auto slots = parsed.getProperty ("slots", juce::var());
    REQUIRE (slots.isArray());
    auto segs = slots[0].getProperty ("segments", juce::var());
    REQUIRE (segs.isArray());
    REQUIRE (segs.size() == 2);
    REQUIRE ((int) segs[1].getProperty ("pitch", juce::var (0)) == 60);

    // A fresh line has no score (only build_skeleton_from_clip lands one).
    REQUIRE_FALSE (LyricLine::create ("sc-2", 1, "verse").hasProperty (ids::lyricScore));

    // The score is NOT a generation constraint: the line fingerprint must ignore it
    // (attaching the blob cannot dirty cached lyric proposals).
    auto sheet = LyricSheet::create ("ls-sc");
    auto l2 = LyricLine::create ("sc-3", 0, "verse");
    const auto before = LyricSheet::lineFingerprint (sheet, l2, "ctx", "build");
    l2.setProperty (ids::lyricScore, "{\"v\":1}", nullptr);
    REQUIRE (LyricSheet::lineFingerprint (sheet, l2, "ctx", "build") == before);
}

TEST_CASE ("asserted lyric lines persist as renderable words separate from take flow", "[lyrics][asserted]")
{
    auto line = LyricLine::create ("as-1", 0, "verse");
    line.setProperty (ids::lyricText, "hold the flame", nullptr);
    line.setProperty (ids::status, "asserted", nullptr);

    auto back = juce::ValueTree::fromXml (line.toXmlString());
    REQUIRE (back[ids::status].toString() == "asserted");
    REQUIRE (back[ids::lyricText].toString() == "hold the flame");
    REQUIRE_FALSE (back.hasProperty (ids::lyricScore));
}

TEST_CASE ("extraction provenance (lyricOrigin + lyricHeard) persists and stays out of the fingerprint", "[lyrics][extract]")
{
    // Pipeline correction 2026-07-04: a line the producer REALLY sang lands verbatim
    // (text + gapless seed + origin "sung") with everything ASR heard persisted beside
    // it. Both must survive the .tracktionedit round-trip; neither is a generation
    // constraint, so the line fingerprint must ignore them.
    auto line = LyricLine::create ("ex-1", 0, "verse");
    line.setProperty (ids::lyricText, "hold the flame", nullptr);
    line.setProperty (ids::lyricSeedText, "hold the flame", nullptr);
    line.setProperty (ids::status, "seed", nullptr);
    line.setProperty (ids::lyricOrigin, "sung", nullptr);
    line.setProperty (ids::lyricHeard,
                      "{\"v\":1,\"bar\":0,\"words\":[{\"word\":\"hold\",\"start\":0.1,"
                      "\"end\":0.45,\"conf\":0.9,\"syl\":1,\"slot\":0,\"kept\":true,"
                      "\"label\":\"real\",\"tier\":\"t1\"},{\"word\":\"da\",\"start\":0.6,"
                      "\"end\":0.9,\"conf\":0.41,\"syl\":1,\"slot\":1,\"kept\":false,"
                      "\"label\":\"mumble\",\"tier\":\"t1\"}]}",
                      nullptr);

    auto back = juce::ValueTree::fromXml (line.toXmlString());
    REQUIRE (back[ids::lyricOrigin].toString() == "sung");
    auto parsed = juce::JSON::parse (back[ids::lyricHeard].toString());
    REQUIRE (parsed.isObject());
    auto words = parsed.getProperty ("words", juce::var());
    REQUIRE (words.isArray());
    REQUIRE (words.size() == 2);
    // rejected words persist too (kept=false) — raw ASR is never discarded
    REQUIRE ((bool) words[1].getProperty ("kept", true) == false);
    REQUIRE (words[0].getProperty ("word", juce::var()).toString() == "hold");

    // fingerprint exclusion: provenance + heard blob cannot dirty cached proposals
    auto sheet = LyricSheet::create ("ls-ex");
    auto l2 = LyricLine::create ("ex-2", 0, "verse");
    const auto before = LyricSheet::lineFingerprint (sheet, l2, "ctx", "build");
    l2.setProperty (ids::lyricOrigin, "partial", nullptr);
    l2.setProperty (ids::lyricHeard, "{\"v\":1}", nullptr);
    REQUIRE (LyricSheet::lineFingerprint (sheet, l2, "ctx", "build") == before);

    // a fresh line carries neither (legacy/typed lines stay unmarked)
    auto fresh = LyricLine::create ("ex-3", 1, "verse");
    REQUIRE_FALSE (fresh.hasProperty (ids::lyricOrigin));
    REQUIRE_FALSE (fresh.hasProperty (ids::lyricHeard));
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
