#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

// MP-001 (multiplayer) — stable cross-peer logical identity for tracks and buses.
//
// Tracktion's te::EditItemID is allocator-dependent, so the SAME track has a
// DIFFERENT EditItemID on each peer's engine. To address a track on commit/apply
// (and a bus, whose integer busNumber is a racing local-scan counter) we stamp a
// process-independent juce::Uuid as a plain property on the entity's own state
// tree — it saves/reloads with the .tracktionedit and is identical on both peers.
//
// Pure juce::ValueTree logic (engine-free) so it is unit-testable in the Catch2
// suite and reusable from the engine glue. Identity is not user state, so it is
// written WITHOUT the undo manager (nullptr), matching trackType/moshInputDevice.
namespace mosh::logicalid
{
    /** Stamp a fresh UUID on `state` under `prop` iff absent; return the id
        (existing or freshly minted). Safe on an invalid tree (returns ""). */
    inline juce::String ensure (juce::ValueTree state, const juce::Identifier& prop)
    {
        if (! state.isValid())
            return {};

        if (auto existing = state.getProperty (prop).toString(); existing.isNotEmpty())
            return existing;

        const auto id = juce::Uuid().toString();
        state.setProperty (prop, id, nullptr);   // nullptr UM — identity is not undoable
        return id;
    }

    inline juce::String ensureTrack (juce::ValueTree trackState) { return ensure (std::move (trackState), ids::moshLogicalId); }
    inline juce::String ensureBus   (juce::ValueTree busState)   { return ensure (std::move (busState),   ids::mpBusId); }

    /** Read an id (empty if absent or the tree is invalid). */
    inline juce::String get (const juce::ValueTree& state, const juce::Identifier& prop)
    {
        return state.isValid() ? state.getProperty (prop).toString() : juce::String();
    }

    inline juce::String track (const juce::ValueTree& s) { return get (s, ids::moshLogicalId); }
    inline juce::String bus   (const juce::ValueTree& s) { return get (s, ids::mpBusId); }

    /** Depth-first search for the first node (root or descendant) whose `prop`
        equals `value`. Returns an invalid tree on miss or empty query. */
    inline juce::ValueTree findByProp (const juce::ValueTree& root, const juce::Identifier& prop, const juce::String& value)
    {
        if (! root.isValid() || value.isEmpty())
            return {};

        if (root.getProperty (prop).toString() == value)
            return root;

        for (int i = 0; i < root.getNumChildren(); ++i)
            if (auto found = findByProp (root.getChild (i), prop, value); found.isValid())
                return found;

        return {};
    }

    inline juce::ValueTree findTrack (const juce::ValueTree& root, const juce::String& id) { return findByProp (root, ids::moshLogicalId, id); }
    inline juce::ValueTree findBus   (const juce::ValueTree& root, const juce::String& id) { return findByProp (root, ids::mpBusId, id); }
}
