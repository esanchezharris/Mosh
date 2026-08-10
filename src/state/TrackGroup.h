#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

namespace mosh
{
/** Persistent Pro Tools-style Edit/Mix linkage. It is deliberately independent
    of Tracktion folder tracks, so grouping never changes routing or hides rows. */
struct TrackGroup
{
    enum class Axis { Edit, Mix };

    static bool validKind (const juce::String& kind)
    {
        return kind == "edit" || kind == "mix" || kind == "edit_mix";
    }

    static juce::ValueTree create (const juce::String& groupId,
                                   const juce::String& name,
                                   const juce::String& kind,
                                   const juce::StringArray& trackIds)
    {
        juce::ValueTree group (ids::MOSH_TRACK_GROUP);
        group.setProperty (ids::id, groupId, nullptr);
        group.setProperty (ids::trackGroupName, name, nullptr);
        group.setProperty (ids::trackGroupKind, kind, nullptr);
        group.setProperty (ids::trackGroupEnabled, true, nullptr);
        for (const auto& trackId : trackIds)
        {
            juce::ValueTree member (ids::MOSH_TRACK_GROUP_MEMBER);
            member.setProperty (ids::trackGroupTrackId, trackId, nullptr);
            group.appendChild (member, nullptr);
        }
        return group;
    }

    static juce::StringArray memberIds (const juce::ValueTree& group)
    {
        juce::StringArray out;
        for (int index = 0; index < group.getNumChildren(); ++index)
        {
            const auto member = group.getChild (index);
            if (! member.hasType (ids::MOSH_TRACK_GROUP_MEMBER)) continue;
            const auto trackId = member[ids::trackGroupTrackId].toString();
            if (trackId.isNotEmpty()) out.addIfNotAlreadyThere (trackId);
        }
        return out;
    }

    static bool supports (const juce::ValueTree& group, Axis axis)
    {
        const auto kind = group[ids::trackGroupKind].toString();
        return kind == "edit_mix" || (axis == Axis::Edit ? kind == "edit" : kind == "mix");
    }

    static juce::StringArray linkedMemberIds (const juce::ValueTree& groups,
                                               const juce::String& seedTrackId,
                                               Axis axis)
    {
        juce::StringArray linked;
        if (seedTrackId.isNotEmpty()) linked.add (seedTrackId);
        if ((bool) groups.getProperty (ids::trackGroupsSuspended, false)) return linked;

        bool changed = true;
        while (changed)
        {
            changed = false;
            for (int index = 0; index < groups.getNumChildren(); ++index)
            {
                const auto group = groups.getChild (index);
                if (! group.hasType (ids::MOSH_TRACK_GROUP)
                    || ! (bool) group.getProperty (ids::trackGroupEnabled, true)
                    || ! supports (group, axis)) continue;
                const auto members = memberIds (group);
                bool intersects = false;
                for (const auto& member : members)
                    if (linked.contains (member)) { intersects = true; break; }
                if (! intersects) continue;
                for (const auto& member : members)
                    if (! linked.contains (member)) { linked.add (member); changed = true; }
            }
        }
        return linked;
    }
};
}
