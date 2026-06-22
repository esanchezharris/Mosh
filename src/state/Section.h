#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

namespace mosh
{
/** A named song-structure region (Intro / Verse / Hook / …), stored as a
    MOSH_SECTION node under the Edit's MOSH_SECTIONS container. Beat-based so it's
    tempo-independent; used by the section navigator and (later) as an agent scope
    handle ("rework the hook"). A thin typed builder over a juce::ValueTree — the
    tree is authoritative; the command handlers do the undoable writes (mirrors
    RenderLayer). Construction here is pure so it's unit-testable without the engine. */
struct Section
{
    /** Build a fresh MOSH_SECTION node. The node isn't parented yet, so the property
        sets are non-undoable here; the handler's appendChild to the container (with the
        undo manager) makes the whole add one undoable step. */
    static juce::ValueTree create (const juce::String& sectionId,
                                   const juce::String& name,
                                   double startBeat, double endBeat,
                                   const juce::String& color = {})
    {
        juce::ValueTree v (ids::MOSH_SECTION);
        v.setProperty (ids::id, sectionId, nullptr);
        v.setProperty (ids::sectionName, name, nullptr);
        v.setProperty (ids::sectionStartBeat, startBeat, nullptr);
        v.setProperty (ids::sectionEndBeat, endBeat, nullptr);
        if (color.isNotEmpty())
            v.setProperty (ids::sectionColor, color, nullptr);
        return v;
    }
};

} // namespace mosh
