#pragma once

// RFC 001 — MoshOps partial-class split: PRIVATE cross-TU helpers.
//
// Not installed anywhere; included only by the src/moshops/MoshOps*.cpp
// translation units. A helper lands here ONLY when the compiler forces it:
// an (ex-)anonymous-namespace helper referenced by BOTH a moved domain TU
// and code remaining in MoshOps.cpp. Everything else stays file-local in
// its own TU's anonymous namespace. Bodies are verbatim moves (plus the
// `inline` keyword) — never duplicated.

#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

namespace mosh
{
    inline bool lyricTextIsCompleteForSing (const juce::String& text)
    {
        const auto t = text.trim();
        if (t.isEmpty() || t.contains ("___"))
            return false;
        for (auto p = t.getCharPointer(); ! p.isEmpty(); ++p)
            if (juce::CharacterFunctions::isLetterOrDigit (*p))
                return true;
        return false;
    }

    inline bool lyricLineIsAssertedForSing (const juce::ValueTree& line)
    {
        return line.hasProperty (ids::lyricScore)
            && line[ids::status].toString() == "asserted"
            && lyricTextIsCompleteForSing (line[ids::lyricText].toString());
    }
} // namespace mosh
