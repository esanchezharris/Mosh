// add_drum_pattern (DRM-002) — pure pattern-string DSL parser. Header-only,
// juce_core/juce_data_structures only (NO tracktion) so tests/test_drum_pattern.cpp
// runs it hermetically.
//
// Lane pitches MUST mirror kDefaultKit (MoshOps.cpp) and DRUM_LANES
// (ui/src/ui/drumGrid.ts); the parser semantics + error strings are MIRRORED 1:1
// by ui/src/ui/drumPatternUtil.ts, and the golden vectors by
// tests/test_drum_pattern.cpp ⇄ ui/src/ui/drumPatternUtil.test.ts — keep in lockstep.
#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>
#include <vector>

namespace mosh
{

struct DrumPatternStep { int pitch = 0; int step = 0; int velocity = 100; };

struct DrumPatternResult
{
    bool ok = false;
    juce::String error;
    int stepsPerBar = 0, bars = 0, totalSteps = 0;
    std::vector<DrumPatternStep> steps;   // lanes in input order, steps ascending
    std::vector<int> lanePitches;         // every named lane (even all-rest) — drives per-lane replace
};

/** GM pitch for a lane key (case-insensitive; spaces/underscores/hyphens stripped),
    or -1 if unknown. Integer keys 0..127 are raw pitches (handled by the parser,
    BEFORE normalization — stripping '-' would corrupt negative keys). */
inline int drumPatternLanePitch (const juce::String& key)
{
    const auto norm = key.removeCharacters (" \t_-").toLowerCase();
    if (norm == "kick")                                        return 36;
    if (norm == "snare")                                       return 38;
    if (norm == "clap")                                        return 39;
    if (norm == "hat" || norm == "hihat"
        || norm == "closedhat" || norm == "ch")                return 42;
    if (norm == "openhat" || norm == "oh")                     return 46;
    if (norm == "lowtom")                                      return 45;
    if (norm == "midtom")                                      return 47;
    if (norm == "crash")                                       return 49;
    return -1;
}

/** Beats per step — mirrors ui drumGrid stepBeats(beatsPerBar, steps). */
inline double drumPatternStepBeats (double beatsPerBar, int stepsPerBar)
{
    return beatsPerBar / (double) stepsPerBar;
}

/** Parse a pattern (object {lane: steps} or flat string "lane: steps; lane: steps").
    barsOrZero == 0 derives bars from the longest lane. */
inline DrumPatternResult parseDrumPattern (const juce::var& pattern,
                                           int stepsPerBar, int barsOrZero, int defaultVelocity)
{
    DrumPatternResult r;
    auto fail = [&r] (const juce::String& e) { r.ok = false; r.error = e; return r; };

    if (stepsPerBar < 1 || stepsPerBar > 64)
        return fail ("stepsPerBar must be 1-64 (got " + juce::String (stepsPerBar) + ")");
    if (barsOrZero < 0 || barsOrZero > 16)
        return fail ("bars must be 1-16 (got " + juce::String (barsOrZero) + ")");
    if (defaultVelocity < 1 || defaultVelocity > 127)
        return fail ("velocity must be 1-127 (got " + juce::String (defaultVelocity) + ")");

    // Normalize both accepted shapes into ordered (laneKey, laneSteps) entries.
    std::vector<std::pair<juce::String, juce::var>> entries;
    if (pattern.isString())
    {
        const auto s = pattern.toString();
        if (s.trim().isEmpty())
            return fail ("empty pattern");
        juce::StringArray parts;
        parts.addTokens (s, ";\n", {});
        for (const auto& part : parts)
        {
            if (part.trim().isEmpty()) continue;
            const int i = part.indexOfChar (':');
            if (i < 0)
                return fail ("pattern lane \"" + part.trim() + "\" is missing ':' (expected \"lane: steps\")");
            entries.push_back ({ part.substring (0, i), juce::var (part.substring (i + 1)) });
        }
    }
    else if (auto* dyn = pattern.getDynamicObject())
    {
        for (const auto& prop : dyn->getProperties())
            entries.push_back ({ prop.name.toString(), prop.value });
    }
    else
    {
        return fail ("pattern must be an object of lanes or a \"lane: steps\" string");
    }
    if (entries.empty())
        return fail ("pattern has no lanes");

    struct Lane { juce::String key; int pitch; juce::String chars; };
    std::vector<Lane> lanes;
    for (const auto& [rawKey, rawSteps] : entries)
    {
        const auto key = rawKey.trim();
        if (! rawSteps.isString())
            return fail ("lane \"" + key + "\" steps must be a string");

        int pitch = -1;
        const bool isNumeric = key.isNotEmpty()
            && (key[0] == '-' ? key.length() > 1 && key.substring (1).containsOnly ("0123456789")
                              : key.containsOnly ("0123456789"));
        if (isNumeric)
        {
            pitch = key.getIntValue();
            if (pitch < 0 || pitch > 127)
                return fail ("lane pitch " + key + " out of range 0-127");
        }
        else
        {
            pitch = drumPatternLanePitch (key);
            if (pitch < 0)
                return fail ("unknown lane \"" + key + "\"");
        }
        for (const auto& l : lanes)
            if (l.pitch == pitch)
                return fail ("duplicate lane \"" + key + "\" (pitch " + juce::String (pitch) + ")");

        const auto chars = rawSteps.toString().removeCharacters ("| \t\r\n");
        if (chars.isEmpty())
            return fail ("lane \"" + key + "\" is empty");
        for (int i = 0; i < chars.length(); ++i)
        {
            const auto c = chars[i];
            if (c != 'x' && c != 'X' && c != '.' && c != '-')
                return fail ("lane \"" + key + "\" has invalid step char \"" + juce::String::charToString (c)
                             + "\" (use x X . - |)");
        }
        lanes.push_back ({ key, pitch, chars });
    }

    int longest = 0;
    for (const auto& l : lanes) longest = juce::jmax (longest, l.chars.length());
    const int bars = barsOrZero == 0 ? juce::jmax (1, (longest + stepsPerBar - 1) / stepsPerBar)
                                     : barsOrZero;
    if (bars > 16)
        return fail ("pattern needs " + juce::String (bars) + " bars (max 16)");
    const int totalSteps = stepsPerBar * bars;
    for (const auto& l : lanes)
    {
        if (l.chars.length() > totalSteps)
            return fail ("lane \"" + l.key + "\" is " + juce::String (l.chars.length())
                         + " steps but the pattern is " + juce::String (totalSteps));
        if (totalSteps % l.chars.length() != 0)
            return fail ("lane \"" + l.key + "\" (" + juce::String (l.chars.length())
                         + " steps) doesn't divide the pattern (" + juce::String (totalSteps)
                         + " steps) — can't tile");
    }

    for (const auto& l : lanes)
    {
        for (int s = 0; s < totalSteps; ++s)
        {
            const auto c = l.chars[s % l.chars.length()];
            if (c == 'x')      r.steps.push_back ({ l.pitch, s, defaultVelocity });
            else if (c == 'X') r.steps.push_back ({ l.pitch, s, 127 });
        }
        r.lanePitches.push_back (l.pitch);
    }

    r.ok = true;
    r.stepsPerBar = stepsPerBar;
    r.bars = bars;
    r.totalSteps = totalSteps;
    return r;
}

} // namespace mosh
