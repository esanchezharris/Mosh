#include "TrackCommit.h"
#include "state/Ids.h"
#include "multiplayer/LogicalId.h"

namespace mosh::trackcommit
{

juce::String serialize (te::Track& track)
{
    // The whole track subtree as XML. The caller flushed Edit state first, so
    // plugin chunks/state are already written into the tree (unlike a display
    // projection such as trackToVar, which caps params and drops VST3 chunks).
    auto copy = track.state.createCopy();
    if (auto xml = copy.createXml())
        return xml->toString();
    return {};
}

ApplyResult apply (te::Edit& edit, const juce::String& blob,
                   const juce::String& expectedLogicalId)
{
    ApplyResult r;

    auto xml = juce::parseXML (blob);
    if (xml == nullptr)
    {
        r.error = "blob is not valid XML";
        return r;
    }

    auto incoming = juce::ValueTree::fromXml (*xml);
    if (! incoming.isValid())
    {
        r.error = "blob is not a valid ValueTree";
        return r;
    }

    const auto lid = logicalid::track (incoming);
    if (lid.isEmpty())
    {
        r.error = "incoming track has no moshLogicalId";
        return r;
    }
    if (expectedLogicalId.isNotEmpty() && lid != expectedLogicalId)
    {
        r.error = "incoming track logicalId does not match commit envelope";
        return r;
    }
    r.logicalId = lid;

    // Fresh copy + remap EditItemIDs so they cannot collide with anything live in
    // this engine (the peer's ids are allocator-dependent and meaningless here).
    // moshLogicalId is a plain property, so remapIDs leaves the identity intact.
    auto copy = incoming.createCopy();
    te::EditItemID::remapIDs (copy, nullptr, edit);   // nullptr UndoManager

    // Find the local track carrying the same logical identity.
    auto localState = logicalid::findTrack (edit.state, lid);

    if (localState.isValid())
    {
        // REPLACE in place, same parent + index, raw nullptr-UM splice (never the
        // undo stack — a peer's commit is incoming history, not the local user's).
        auto parent = localState.getParent();
        const int index = parent.indexOf (localState);
        parent.removeChild (localState, nullptr);
        parent.addChild (copy, index, nullptr);
        r.created = false;
    }
    else
    {
        // CREATE: append under the same parent top-level tracks use.
        juce::ValueTree parent = edit.state;
        if (auto tracks = te::getAudioTracks (edit); ! tracks.isEmpty())
            parent = tracks.getFirst()->state.getParent();
        parent.addChild (copy, -1, nullptr);
        r.created = true;
    }

    r.ok = true;
    return r;
}

}
