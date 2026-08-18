#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

// Skill Foundry Slice B, Task 1 — stable, persisted take identity.
//
// Tracktion's own take model has no persisted per-take identity: the only handle a
// caller has ever had is a LANE INDEX into WaveAudioClip's TAKES tree, which shifts
// under deleteAllUnusedTakes/promote/undo. `capture-review-choose-take` (Slice B's
// take journey) needs a handle that survives Keep, Undo, save, and relaunch — so this
// module adds ONE additive property (`moshTakeId`) directly on each source-bearing
// TAKE child, written the first time that take is ever seen and never touched again.
//
// This is deliberately a pure, engine-free ValueTree utility (juce_core/
// juce_data_structures only, matching RecordingLanding.h's posture, and — unlike
// MoshOps.cpp — buildable by the engine-free MoshTests target). It knows the SHAPE of
// a Tracktion TAKES node (a child named "TAKES" whose own children each carry a
// "source" property when they are a real take) but nothing about WaveAudioClip, the
// engine, or MoshOps, so it declares its own local `juce::Identifier`s for those two
// names rather than including tracktion_engine for `te::IDs::TAKES`/`te::IDs::source`
// — `DECLARE_ID(name)` in tracktion_Identifiers.h is exactly
// `const juce::Identifier name (#name);`, so these are byte-identical to Tracktion's
// own constants, just declared locally to keep this header dependency-free. Callers
// that already hold a `te::WaveAudioClip&` pass its
// `.state.getChildWithName (te::IDs::TAKES)` in — `juce::Identifier` compares by
// string, so a Mosh-local `TAKES_ID` and Tracktion's own `te::IDs::TAKES` are
// interchangeable wherever a `juce::ValueTree` operation compares them.
namespace mosh::takeidentity
{

namespace detail
{
    const juce::Identifier takesNodeType ("TAKES");
    const juce::Identifier sourceProperty ("source");
}

/** Lowercase dashed UUID shape: 8-4-4-4-12 lowercase hex, exactly 36 characters. This is
 *  intentionally a SHAPE check only (this module never "fixes" or reinterprets a
 *  malformed id — see `backfill` below) so a caller can reject a malformed/foreign id
 *  before it ever reaches a mutation guard. */
inline bool isValid (const juce::String& id)
{
    if (id.length() != 36)
        return false;

    for (int i = 0; i < id.length(); ++i)
    {
        const auto c = id[i];
        if (i == 8 || i == 13 || i == 18 || i == 23)
        {
            if (c != '-')
                return false;
            continue;
        }
        if (! (juce::CharacterFunctions::isDigit (c) || (c >= 'a' && c <= 'f')))
            return false;
    }
    return true;
}

/** A fresh, lowercase, dashed UUID — the one shape every id this module writes has. */
inline juce::String newId()
{
    return juce::Uuid().toDashedString().toLowerCase();
}

/** The persisted id of one take child, or an empty string if it has none (a take that
 *  predates this module and has not yet been backfilled). Never mutates. */
inline juce::String idFor (const juce::ValueTree& take)
{
    return take.getProperty (mosh::ids::moshTakeId).toString();
}

/** Ordered ids of every source-bearing child under one TAKES node, one id per take in
 *  take-INDEX order (so `orderedIds (takesNode)[i]` names the same take every other
 *  take-index projection in MoshOps calls take `i`). A take with no id yet (not
 *  backfilled) contributes an empty string at its index rather than shifting the
 *  array — callers must backfill before relying on every entry being non-empty. */
inline juce::StringArray orderedIds (const juce::ValueTree& takesNode)
{
    juce::StringArray ids;
    for (auto take : takesNode)
    {
        if (! take.hasProperty (detail::sourceProperty))
            continue;
        ids.add (idFor (take));
    }
    return ids;
}

/**
 * Recursively visit every node reachable from `tree`; for each node that IS a
 * Tracktion `TAKES` node, write a fresh `moshTakeId` onto each direct,
 * source-bearing child that does not already have one. Always writes with a NULL
 * UndoManager (a backfill is a one-time identity stamp, not a producer edit — it
 * must never appear in undo history, mirroring how `MOSH_PROJECT`'s preference
 * fields in Ids.h are written). Never replaces or "fixes" an existing id, however it
 * is shaped — a malformed legacy id is left exactly as it is; only a genuinely
 * ABSENT property is filled in. Returns the number of ids actually written, so a
 * caller (and this task's own RED test) can observe idempotency: a second call over
 * the same tree with no new takes always returns 0.
 *
 * Does not stamp clips, plug-ins, or the TAKES node itself — only source-bearing TAKE
 * children, which is the only place `moshTakeId` is ever read from.
 */
inline int backfill (juce::ValueTree tree)
{
    int written = 0;

    if (tree.getType() == detail::takesNodeType)
    {
        for (auto take : tree)
        {
            if (! take.hasProperty (detail::sourceProperty))
                continue;
            if (take.hasProperty (mosh::ids::moshTakeId))
                continue;
            take.setProperty (mosh::ids::moshTakeId, newId(), nullptr);
            ++written;
        }
    }

    for (auto child : tree)
        written += backfill (child);

    return written;
}

}
