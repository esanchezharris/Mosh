#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

namespace mosh
{
/** Persistent Pro Tools-style arrangement group metadata. This is deliberately
    independent of Tracktion folder tracks: it changes edit selection/clip motion,
    never routing. Group nodes stay in the Edit tree while inactive so Regroup can
    restore the most recently ungrouped definition. */
struct ClipGroup
{
    static juce::ValueTree create (const juce::String& groupId,
                                   const juce::String& name,
                                   const juce::StringArray& clipIds)
    {
        juce::ValueTree group (ids::MOSH_CLIP_GROUP);
        group.setProperty (ids::id, groupId, nullptr);
        group.setProperty (ids::clipGroupName, name, nullptr);
        group.setProperty (ids::clipGroupActive, true, nullptr);
        for (const auto& clipId : clipIds)
        {
            juce::ValueTree member (ids::MOSH_CLIP_GROUP_MEMBER);
            member.setProperty (ids::clipGroupClipId, clipId, nullptr);
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
            if (! member.hasType (ids::MOSH_CLIP_GROUP_MEMBER))
                continue;
            const auto clipId = member[ids::clipGroupClipId].toString();
            if (clipId.isNotEmpty() && ! out.contains (clipId))
                out.add (clipId);
        }
        return out;
    }
};
}
