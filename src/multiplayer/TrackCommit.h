#pragma once

#include <tracktion_engine/tracktion_engine.h>

// MP-001 (multiplayer) — the commit (serialize a locked track) + apply (rebuild
// it in the other peer's engine) mechanics. The track is the atomic sync unit:
// on commit we serialize the WHOLE track subtree; on apply we replace the local
// track carrying the same moshLogicalId (or create it), so regenerated local
// EditItemIDs are invisible to the receiver (who was locked out of that track).
namespace mosh
{
namespace te = tracktion::engine;

namespace trackcommit
{
    /** Serialize a track to a portable XML blob (its full state subtree: clips,
        MIDI notes, plugin chain + plugin state, mixer, moshLogicalId). The caller
        MUST `edit.flushState()` first so plugin chunks/state are written into the
        tree (a display projection like trackToVar would drop them). */
    juce::String serialize (te::Track& track);

    struct ApplyResult
    {
        bool         ok = false;
        bool         created = false;   // true = new track made, false = existing replaced
        juce::String logicalId;
        juce::String error;
    };

    /** Apply a serialized track blob to `edit`: find the local track with the same
        moshLogicalId and REPLACE it (remove + re-add a remapped copy at the same
        position), or CREATE it if absent. ALL ValueTree mutations use a nullptr
        UndoManager — the local user's undo stack is never touched — and nothing is
        emitted (no relay echo; the caller repaints locally by other means).
        EditItemIDs are remapped fresh to avoid collisions; moshLogicalId (a plain
        property, not an EditItemID) is preserved. */
    ApplyResult apply (te::Edit& edit, const juce::String& blob);
}
}
