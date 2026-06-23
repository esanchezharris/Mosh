#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

namespace mosh
{
/** A lightweight, authored timeline comment pin ("fix this transition"), stored as a
    MOSH_ANNOTATION node under the Edit's MOSH_ANNOTATIONS container. Beat-anchored so
    it stays on its musical spot across tempo edits (like Section). A thin typed builder
    over a juce::ValueTree — the tree is authoritative; the command handlers do the
    undoable writes (mirrors Section / RenderLayer). Construction here is pure so it's
    unit-testable without the engine. Annotations broadcast over multiplayer, carrying
    `author` so a collaborator sees who flagged it. */
struct Annotation
{
    /** Build a fresh MOSH_ANNOTATION node. Not parented yet, so the property sets are
        non-undoable here; the handler's appendChild to the container (with the undo
        manager) makes the whole add one undoable step. */
    static juce::ValueTree create (const juce::String& annotationId,
                                   const juce::String& text,
                                   double beat,
                                   const juce::String& color = {},
                                   const juce::String& author = {})
    {
        juce::ValueTree v (ids::MOSH_ANNOTATION);
        v.setProperty (ids::id, annotationId, nullptr);
        v.setProperty (ids::annotationText, text, nullptr);
        v.setProperty (ids::annotationBeat, beat, nullptr);
        if (color.isNotEmpty())  v.setProperty (ids::annotationColor, color, nullptr);
        if (author.isNotEmpty()) v.setProperty (ids::annotationAuthor, author, nullptr);
        return v;
    }
};

} // namespace mosh
