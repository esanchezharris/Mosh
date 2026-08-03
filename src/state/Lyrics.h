#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include <juce_cryptography/juce_cryptography.h>
#include "state/Ids.h"

namespace mosh
{
/** Finish-My-Song LYRIC SHEET (LYR-001) — the per-track lyric document, stored as a
    MOSH_LYRICSHEET sub-tree on the TRACK (one sheet per vocal track). It holds a
    LYRIC_LINES container of MOSH_LYRICLINE nodes; each line carries the constraint
    spec (§5): role, seed text with ___ gaps, syllable target/tolerance, stress
    contour, rhyme group + strictness, and a lock flag.

    A thin typed view over a juce::ValueTree — the tree is authoritative (01 §3); we
    never hold shadow state. CachedValue/undo binding happens in the MoshOps command
    handlers; here we keep pure construction + a per-line staleness fingerprint so
    they're unit-testable without the engine (mirrors RenderLayer.h / Section.h). */
struct LyricLine
{
    /** Build a fresh MOSH_LYRICLINE node (status="empty"). Not parented yet, so the
        sets are non-undoable here; the handler's appendChild with the undo manager
        makes the whole add one undoable step. */
    static juce::ValueTree create (const juce::String& lineId, int index,
                                   const juce::String& role = "verse")
    {
        juce::ValueTree v (ids::MOSH_LYRICLINE);
        v.setProperty (ids::id, lineId, nullptr);
        v.setProperty (ids::lyricIndex, index, nullptr);
        v.setProperty (ids::lyricRole, role, nullptr);
        v.setProperty (ids::lyricSeedText, "", nullptr);
        v.setProperty (ids::lyricText, "", nullptr);
        v.setProperty (ids::lyricSyllableTarget, 0, nullptr);   // 0 ⇒ infer from the grid
        v.setProperty (ids::lyricSyllableTol, 1, nullptr);
        v.setProperty (ids::lyricStress, "", nullptr);
        v.setProperty (ids::lyricRhymeGroup, "", nullptr);
        v.setProperty (ids::lyricRhymeStrictness, "", nullptr); // "" ⇒ inherit sheet default
        v.setProperty (ids::lyricLocked, false, nullptr);
        v.setProperty (ids::lyricSectionId, "", nullptr);
        v.setProperty (ids::status, "empty", nullptr);
        return v;
    }
};

struct LyricSheet
{
    juce::ValueTree state;

    /** Build a fresh MOSH_LYRICSHEET with an empty LYRIC_LINES container. */
    static juce::ValueTree create (const juce::String& sheetId,
                                   const juce::String& grid = "1/16",
                                   const juce::String& language = "en")
    {
        juce::ValueTree v (ids::MOSH_LYRICSHEET);
        v.setProperty (ids::id, sheetId, nullptr);
        v.setProperty (ids::lyricGrid, grid, nullptr);
        v.setProperty (ids::lyricLanguage, language, nullptr);
        v.setProperty (ids::lyricTopic, "", nullptr);
        v.setProperty (ids::lyricMood, "", nullptr);
        v.setProperty (ids::lyricExplicit, "allow", nullptr);
        v.setProperty (ids::lyricRhymeStrictness, "slant", nullptr);  // rap default (configurable)
        v.setProperty (ids::lyricSpecVersion, 1, nullptr);
        v.setProperty (ids::status, "empty", nullptr);
        v.appendChild (juce::ValueTree (ids::LYRIC_LINES), nullptr);
        return v;
    }

    /** The LYRIC_LINES container child (always present after create()). */
    static juce::ValueTree lines (const juce::ValueTree& sheet)
    {
        return sheet.getChildWithName (ids::LYRIC_LINES);
    }

    /** Sheet-wide staleness key for analyze_lyrics. The analysis service grades lines
        together (a changed line can become a rhyme-group anchor for its neighbours), so
        a result may land only while the exact submitted spec is still current. */
    static juce::String analysisFingerprint (const juce::var& spec)
    {
        const auto json = juce::JSON::toString (spec, true);
        return juce::SHA256 (json.toRawUTF8(),
                             (size_t) json.getNumBytesAsUTF8()).toHexString();
    }

    /** Per-line generation/cache STALENESS key (mirrors RenderLayer::fingerprint) —
        every constraint input that should invalidate a cached proposal. A line's
        rhyme strictness inherits the sheet default when blank. `contextHash` folds in
        the upstream lyric context (the rhyme group's already-chosen end-words / prior
        lines) so editing one line dirties only the dependent lines, not the sheet. */
    static juce::String lineFingerprint (const juce::ValueTree& sheet,
                                         const juce::ValueTree& line,
                                         const juce::String& contextHash,
                                         const juce::String& serviceBuild)
    {
        auto strictness = line[ids::lyricRhymeStrictness].toString();
        if (strictness.isEmpty())
            strictness = sheet[ids::lyricRhymeStrictness].toString();

        juce::StringArray parts {
            sheet[ids::lyricLanguage].toString(),
            sheet[ids::lyricGrid].toString(),
            sheet[ids::lyricTopic].toString(),
            sheet[ids::lyricMood].toString(),
            sheet[ids::lyricExplicit].toString(),
            line[ids::lyricRole].toString(),
            line[ids::lyricSeedText].toString(),
            line[ids::lyricSyllableTarget].toString() + ":" + line[ids::lyricSyllableTol].toString(),
            line[ids::lyricStress].toString(),
            line[ids::lyricRhymeGroup].toString(),
            strictness,
            line[ids::lyricLocked].toString(),
            contextHash,
            serviceBuild
        };

        const auto joined = parts.joinIntoString ("|");
        return juce::SHA256 (joined.toRawUTF8(),
                             (size_t) joined.getNumBytesAsUTF8()).toHexString();
    }

    /** Round-trip through XML (proves it serializes/reloads with the .tracktionedit). */
    static juce::ValueTree roundTripViaXml (const juce::ValueTree& v)
    {
        return juce::ValueTree::fromXml (v.toXmlString());
    }
};

} // namespace mosh
