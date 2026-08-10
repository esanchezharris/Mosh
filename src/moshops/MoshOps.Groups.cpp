#include "MoshOps.h"
#include "state/ClipGroup.h"
#include "state/Ids.h"

namespace mosh
{
using namespace juce;

static juce::var clipGroupResult (const juce::ValueTree& group)
{
    auto* data = new DynamicObject();
    data->setProperty ("groupId", group[ids::id].toString());
    Array<var> members;
    for (const auto& clipId : ClipGroup::memberIds (group)) members.add (clipId);
    data->setProperty ("clipIds", members);
    return var (data);
}

juce::ValueTree MoshOps::findClipGroupForClip (const juce::String& clipId,
                                                bool activeOnly)
{
    const auto groups = eng.edit().state.getChildWithName (ids::MOSH_CLIP_GROUPS);
    for (int index = 0; index < groups.getNumChildren(); ++index)
    {
        const auto group = groups.getChild (index);
        if (! group.hasType (ids::MOSH_CLIP_GROUP))
            continue;
        if (activeOnly && ! (bool) group.getProperty (ids::clipGroupActive, false))
            continue;
        if (ClipGroup::memberIds (group).contains (clipId))
            return group;
    }
    return {};
}

std::vector<te::Clip*> MoshOps::clipGroupMembers (const juce::ValueTree& group)
{
    std::vector<te::Clip*> out;
    for (const auto& clipId : ClipGroup::memberIds (group))
        if (auto* clip = findClip (clipId))
            out.push_back (clip);
    return out;
}

juce::var MoshOps::cmdCreateClipGroup (const juce::var& args)
{
    StringArray clipIds;
    if (auto* values = args.getProperty ("clipIds", var()).getArray())
        for (const auto& value : *values)
        {
            const auto clipId = value.toString();
            if (clipId.isNotEmpty()) clipIds.addIfNotAlreadyThere (clipId);
        }
    if (clipIds.isEmpty())
        return errResult ("create_clip_group", "clipIds must contain at least one clip");
    for (const auto& clipId : clipIds)
    {
        if (findClip (clipId) == nullptr)
            return errResult ("create_clip_group", "no clip: " + clipId);
        if (findClipGroupForClip (clipId, true).isValid())
            return errResult ("create_clip_group", "one or more clips are already grouped");
    }

    auto name = args.getProperty ("name", "Clip Group").toString().trim();
    if (name.isEmpty()) name = "Clip Group";
    const auto groupId = Uuid().toString();
    beginTxn ("create_clip_group");
    auto state = eng.edit().state;
    auto groups = state.getChildWithName (ids::MOSH_CLIP_GROUPS);
    if (! groups.isValid())
    {
        groups = ValueTree (ids::MOSH_CLIP_GROUPS);
        state.appendChild (groups, &undoManager());
    }
    groups.appendChild (ClipGroup::create (groupId, name, clipIds), &undoManager());

    const auto group = groups.getChildWithProperty (ids::id, groupId);
    logLine ("create_clip_group", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_clip_group", clipGroupResult (group));
}

juce::var MoshOps::cmdUngroupClipGroup (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto group = findClipGroupForClip (clipId, true);
    if (! group.isValid())
        return errResult ("ungroup_clip_group", "active clip group not found");

    beginTxn ("ungroup_clip_group");
    group.setProperty (ids::clipGroupActive, false, &undoManager());
    auto groups = group.getParent();
    groups.setProperty (ids::lastUngroupedClipGroupId, group[ids::id], &undoManager());
    logLine ("ungroup_clip_group", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("ungroup_clip_group", clipGroupResult (group));
}

juce::var MoshOps::cmdRegroupClipGroup (const juce::var& args)
{
    auto groups = eng.edit().state.getChildWithName (ids::MOSH_CLIP_GROUPS);
    auto groupId = args.getProperty ("groupId", var()).toString();
    if (groupId.isEmpty()) groupId = groups[ids::lastUngroupedClipGroupId].toString();
    auto group = groups.getChildWithProperty (ids::id, groupId);
    if (! group.isValid() || (bool) group.getProperty (ids::clipGroupActive, false))
        return errResult ("regroup_clip_group", "no ungrouped clip group is available to regroup");

    const auto members = clipGroupMembers (group);
    if (members.empty())
        return errResult ("regroup_clip_group", "the clip group's members no longer exist");
    for (auto* member : members)
        if (const auto other = findClipGroupForClip (member->itemID.toString(), true);
            other.isValid() && other != group)
            return errResult ("regroup_clip_group", "one or more former members now belong to another clip group");

    beginTxn ("regroup_clip_group");
    group.setProperty (ids::clipGroupActive, true, &undoManager());
    if (groups[ids::lastUngroupedClipGroupId].toString() == groupId)
        groups.removeProperty (ids::lastUngroupedClipGroupId, &undoManager());
    logLine ("regroup_clip_group", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("regroup_clip_group", clipGroupResult (group));
}

juce::var MoshOps::cmdRenameClipGroup (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto group = findClipGroupForClip (clipId, false);
    const auto name = args.getProperty ("name", var()).toString().trim();
    if (! group.isValid()) return errResult ("rename_clip_group", "clip group not found");
    if (name.isEmpty()) return errResult ("rename_clip_group", "clip group name cannot be empty");

    beginTxn ("rename_clip_group");
    group.setProperty (ids::clipGroupName, name, &undoManager());
    logLine ("rename_clip_group", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_clip_group", clipGroupResult (group));
}

juce::var MoshOps::clipGroupsToVar()
{
    Array<var> out;
    const auto groups = eng.edit().state.getChildWithName (ids::MOSH_CLIP_GROUPS);
    for (int index = 0; index < groups.getNumChildren(); ++index)
    {
        const auto group = groups.getChild (index);
        if (! group.hasType (ids::MOSH_CLIP_GROUP)) continue;
        auto* object = new DynamicObject();
        object->setProperty ("id", group[ids::id].toString());
        object->setProperty ("name", group[ids::clipGroupName].toString());
        object->setProperty ("active", (bool) group.getProperty (ids::clipGroupActive, false));
        Array<var> memberIds;
        for (const auto& clipId : ClipGroup::memberIds (group))
            if (findClip (clipId) != nullptr) memberIds.add (clipId);
        object->setProperty ("clipIds", memberIds);
        out.add (var (object));
    }
    return out;
}
}
