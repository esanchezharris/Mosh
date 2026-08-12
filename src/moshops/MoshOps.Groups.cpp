#include "MoshOps.h"
#include "state/ClipGroup.h"
#include "state/TrackGroup.h"
#include "state/Ids.h"
#include "multiplayer/LogicalId.h"

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

static juce::var trackGroupResult (const juce::ValueTree& group)
{
    auto* data = new DynamicObject();
    data->setProperty ("groupId", group[ids::id].toString());
    data->setProperty ("name", group[ids::trackGroupName].toString());
    data->setProperty ("kind", group[ids::trackGroupKind].toString());
    Array<var> members;
    for (const auto& trackId : TrackGroup::memberIds (group)) members.add (trackId);
    data->setProperty ("trackIds", members);
    Array<var> attributes;
    for (const auto& attribute : TrackGroup::mixAttributes (group)) attributes.add (attribute);
    data->setProperty ("mixAttributes", attributes);
    return var (data);
}

static juce::StringArray trackGroupTrackIdsFromArgs (const juce::var& args)
{
    StringArray trackIds;
    if (auto* values = args.getProperty ("trackIds", var()).getArray())
        for (const auto& value : *values)
        {
            const auto trackId = value.toString();
            if (trackId.isNotEmpty()) trackIds.addIfNotAlreadyThere (trackId);
        }
    return trackIds;
}

static bool parseTrackGroupMixAttributes (const juce::var& value,
                                          juce::StringArray& attributes)
{
    const auto* values = value.getArray();
    if (values == nullptr) return false;
    for (const auto& item : *values)
    {
        const auto attribute = item.toString();
        if (! TrackGroup::validMixAttribute (attribute)) return false;
        attributes.addIfNotAlreadyThere (attribute);
    }
    return true;
}

juce::ValueTree MoshOps::findTrackGroupById (const juce::String& groupId)
{
    const auto groups = eng.edit().state.getChildWithName (ids::MOSH_TRACK_GROUPS);
    const auto group = groups.getChildWithProperty (ids::id, groupId);
    return group.hasType (ids::MOSH_TRACK_GROUP) ? group : juce::ValueTree {};
}

std::vector<te::AudioTrack*> MoshOps::trackGroupMembers (const juce::ValueTree& group)
{
    std::vector<te::AudioTrack*> out;
    for (const auto& trackId : TrackGroup::memberIds (group))
        if (auto* track = findTrack (trackId)) out.push_back (track);
    return out;
}

std::vector<te::AudioTrack*> MoshOps::mixLinkedTracks (const juce::String& trackId,
                                                       const juce::String& mixAttribute)
{
    std::vector<te::AudioTrack*> out;
    const auto groups = eng.edit().state.getChildWithName (ids::MOSH_TRACK_GROUPS);
    for (const auto& memberId : TrackGroup::linkedMemberIds (
             groups, trackId, TrackGroup::Axis::Mix, mixAttribute))
        if (auto* track = findTrack (memberId)) out.push_back (track);
    return out;
}

juce::var MoshOps::cmdCreateTrackGroup (const juce::var& args)
{
    const auto trackIds = trackGroupTrackIdsFromArgs (args);
    if (trackIds.isEmpty())
        return errResult ("create_track_group", "trackIds must contain at least one track");
    for (const auto& trackId : trackIds)
        if (findTrack (trackId) == nullptr)
            return errResult ("create_track_group", "no supported track: " + trackId);

    const auto kind = args.getProperty ("kind", "edit_mix").toString();
    if (! TrackGroup::validKind (kind))
        return errResult ("create_track_group", "kind must be edit, mix, or edit_mix");
    auto state = eng.edit().state;
    auto groups = state.getChildWithName (ids::MOSH_TRACK_GROUPS);
    auto name = args.getProperty ("name", var()).toString().trim();
    if (name.isEmpty()) name = "Group " + String (groups.getNumChildren() + 1);
    auto mixAttributes = TrackGroup::defaultMixAttributes();
    if (args.hasProperty ("mixAttributes"))
    {
        mixAttributes.clear();
        if (! parseTrackGroupMixAttributes (args.getProperty ("mixAttributes", var()), mixAttributes))
            return errResult ("create_track_group", "mixAttributes must contain only supported attributes");
    }
    // MP-003 — stable cross-peer id: reuse the caller's if supplied (the
    // structural-broadcast re-exec passes its own resolved id back — see the
    // broadcast below), else mint one. Idempotent on replay: a re-delivered
    // create must not append a duplicate group (mirrors create_annotation).
    auto groupId = args.getProperty ("groupId", var()).toString();
    if (groupId.isNotEmpty())
        if (const auto existing = findTrackGroupById (groupId); existing.isValid())
            return okResult ("create_track_group", trackGroupResult (existing));
    if (groupId.isEmpty()) groupId = Uuid().toString();

    beginTxn ("create_track_group");
    if (! groups.isValid())
    {
        groups = ValueTree (ids::MOSH_TRACK_GROUPS);
        state.appendChild (groups, &undoManager());
    }
    auto groupState = TrackGroup::create (groupId, name, kind, trackIds);
    TrackGroup::replaceMixAttributes (groupState, mixAttributes, nullptr);
    groups.appendChild (groupState, &undoManager());
    const auto group = groups.getChildWithProperty (ids::id, groupId);
    logLine ("create_track_group", args, true, {}, true);
    emitSnapshotInvalidated();

    // Broadcast the RESOLVED groupId; translateTrackGroupTrackIds (via
    // broadcastStructuralIfActive's caller contract) still needs `trackIds`
    // translated from our local raw ids to the cross-peer-stable moshLogicalId —
    // done here explicitly (not by the dispatch site) because this function also
    // owns minting groupId.
    auto* broadcastArgs = new DynamicObject();
    broadcastArgs->setProperty ("groupId", groupId);
    broadcastArgs->setProperty ("name", name);
    broadcastArgs->setProperty ("kind", kind);
    Array<var> trackIdVars;
    for (const auto& t : trackIds) trackIdVars.add (t);
    broadcastArgs->setProperty ("trackIds", trackIdVars);
    Array<var> mixAttrVars;
    for (const auto& a : mixAttributes) mixAttrVars.add (a);
    broadcastArgs->setProperty ("mixAttributes", mixAttrVars);
    return broadcastStructuralIfActive (
        "create_track_group",
        translateTrackGroupTrackIds ("create_track_group", var (broadcastArgs), true),
        okResult ("create_track_group", trackGroupResult (group)));
}

juce::var MoshOps::cmdConfigureTrackGroup (const juce::var& args)
{
    auto group = findTrackGroupById (args.getProperty ("groupId", var()).toString());
    if (! group.isValid()) return errResult ("configure_track_group", "track group not found");
    const auto name = args.getProperty ("name", var()).toString().trim();
    if (name.isEmpty()) return errResult ("configure_track_group", "track group name cannot be empty");
    const auto kind = args.getProperty ("kind", var()).toString();
    if (! TrackGroup::validKind (kind))
        return errResult ("configure_track_group", "kind must be edit, mix, or edit_mix");
    const auto trackIds = trackGroupTrackIdsFromArgs (args);
    if (trackIds.isEmpty())
        return errResult ("configure_track_group", "trackIds must contain at least one track");
    for (const auto& trackId : trackIds)
        if (findTrack (trackId) == nullptr)
            return errResult ("configure_track_group", "no supported track: " + trackId);
    StringArray mixAttributes;
    if (! parseTrackGroupMixAttributes (args.getProperty ("mixAttributes", var()), mixAttributes))
        return errResult ("configure_track_group", "mixAttributes must contain only supported attributes");

    if (group[ids::trackGroupName].toString() == name
        && group[ids::trackGroupKind].toString() == kind
        && TrackGroup::memberIds (group) == trackIds
        && TrackGroup::mixAttributes (group) == mixAttributes)
        return okResult ("configure_track_group", trackGroupResult (group));

    beginTxn ("configure_track_group");
    group.setProperty (ids::trackGroupName, name, &undoManager());
    group.setProperty (ids::trackGroupKind, kind, &undoManager());
    TrackGroup::replaceMemberIds (group, trackIds, &undoManager());
    TrackGroup::replaceMixAttributes (group, mixAttributes, &undoManager());
    logLine ("configure_track_group", args, true, {}, true);
    emitSnapshotInvalidated();

    // MP-003 — groupId is already a portable UUID; only trackIds needs
    // translating to the cross-peer-stable moshLogicalId before broadcasting.
    return broadcastStructuralIfActive (
        "configure_track_group",
        translateTrackGroupTrackIds ("configure_track_group", args, true),
        okResult ("configure_track_group", trackGroupResult (group)));
}

juce::var MoshOps::cmdDuplicateTrackGroup (const juce::var& args)
{
    const auto source = findTrackGroupById (args.getProperty ("groupId", var()).toString());
    if (! source.isValid()) return errResult ("duplicate_track_group", "track group not found");
    const auto name = args.getProperty ("name", var()).toString().trim();
    if (name.isEmpty()) return errResult ("duplicate_track_group", "track group name cannot be empty");
    const auto kind = args.getProperty ("kind", var()).toString();
    if (! TrackGroup::validKind (kind))
        return errResult ("duplicate_track_group", "kind must be edit, mix, or edit_mix");
    const auto trackIds = trackGroupTrackIdsFromArgs (args);
    if (trackIds.isEmpty())
        return errResult ("duplicate_track_group", "trackIds must contain at least one track");
    for (const auto& trackId : trackIds)
        if (findTrack (trackId) == nullptr)
            return errResult ("duplicate_track_group", "no supported track: " + trackId);
    StringArray mixAttributes;
    if (! parseTrackGroupMixAttributes (args.getProperty ("mixAttributes", var()), mixAttributes))
        return errResult ("duplicate_track_group", "mixAttributes must contain only supported attributes");

    // MP-003 — the DUPLICATE's id, distinct from `groupId` above (which names the
    // SOURCE, already a portable UUID and unchanged by this op). newGroupId is
    // reused from a peer's replay if supplied (resolved-id broadcast pattern, like
    // create_track_group) so both peers' copies share one identity; idempotent on
    // a re-delivered duplicate.
    auto newGroupId = args.getProperty ("newGroupId", var()).toString();
    if (newGroupId.isNotEmpty())
        if (const auto existing = findTrackGroupById (newGroupId); existing.isValid())
            return okResult ("duplicate_track_group", trackGroupResult (existing));
    if (newGroupId.isEmpty()) newGroupId = Uuid().toString();

    auto duplicate = TrackGroup::create (newGroupId, name, kind, trackIds);
    TrackGroup::replaceMixAttributes (duplicate, mixAttributes, nullptr);
    beginTxn ("duplicate_track_group");
    source.getParent().appendChild (duplicate, &undoManager());
    const auto group = source.getParent().getChildWithProperty (ids::id, newGroupId);
    logLine ("duplicate_track_group", args, true, {}, true);
    emitSnapshotInvalidated();

    auto* broadcastArgs = new DynamicObject();
    broadcastArgs->setProperty ("groupId", args.getProperty ("groupId", var()).toString());   // source, portable
    broadcastArgs->setProperty ("newGroupId", newGroupId);
    broadcastArgs->setProperty ("name", name);
    broadcastArgs->setProperty ("kind", kind);
    Array<var> trackIdVars;
    for (const auto& t : trackIds) trackIdVars.add (t);
    broadcastArgs->setProperty ("trackIds", trackIdVars);
    Array<var> mixAttrVars;
    for (const auto& a : mixAttributes) mixAttrVars.add (a);
    broadcastArgs->setProperty ("mixAttributes", mixAttrVars);
    return broadcastStructuralIfActive (
        "duplicate_track_group",
        translateTrackGroupTrackIds ("duplicate_track_group", var (broadcastArgs), true),
        okResult ("duplicate_track_group", trackGroupResult (group)));
}

juce::var MoshOps::cmdSetTrackGroupMembers (const juce::var& args)
{
    auto group = findTrackGroupById (args.getProperty ("groupId", var()).toString());
    if (! group.isValid()) return errResult ("set_track_group_members", "track group not found");

    const auto trackIds = trackGroupTrackIdsFromArgs (args);
    if (trackIds.isEmpty())
        return errResult ("set_track_group_members", "trackIds must contain at least one track");
    for (const auto& trackId : trackIds)
        if (findTrack (trackId) == nullptr)
            return errResult ("set_track_group_members", "no supported track: " + trackId);
    if (TrackGroup::memberIds (group) == trackIds)
        return okResult ("set_track_group_members", trackGroupResult (group));

    beginTxn ("set_track_group_members");
    TrackGroup::replaceMemberIds (group, trackIds, &undoManager());
    logLine ("set_track_group_members", args, true, {}, true);
    emitSnapshotInvalidated();
    return broadcastStructuralIfActive (
        "set_track_group_members",
        translateTrackGroupTrackIds ("set_track_group_members", args, true),
        okResult ("set_track_group_members", trackGroupResult (group)));
}

juce::var MoshOps::cmdSetTrackGroupEnabled (const juce::var& args)
{
    auto group = findTrackGroupById (args.getProperty ("groupId", var()).toString());
    if (! group.isValid()) return errResult ("set_track_group_enabled", "track group not found");
    const bool enabled = (bool) args.getProperty ("enabled", true);
    beginTxn ("set_track_group_enabled");
    group.setProperty (ids::trackGroupEnabled, enabled, &undoManager());
    logLine ("set_track_group_enabled", args, true, {}, true);
    emitSnapshotInvalidated();
    auto result = trackGroupResult (group);
    result.getDynamicObject()->setProperty ("enabled", enabled);
    return okResult ("set_track_group_enabled", result);
}

juce::var MoshOps::cmdSetTrackGroupsSuspended (const juce::var& args)
{
    auto state = eng.edit().state;
    auto groups = state.getChildWithName (ids::MOSH_TRACK_GROUPS);
    beginTxn ("set_track_groups_suspended");
    if (! groups.isValid())
    {
        groups = ValueTree (ids::MOSH_TRACK_GROUPS);
        state.appendChild (groups, &undoManager());
    }
    const bool suspended = (bool) args.getProperty ("suspended", true);
    groups.setProperty (ids::trackGroupsSuspended, suspended, &undoManager());
    logLine ("set_track_groups_suspended", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("suspended", suspended);
    return okResult ("set_track_groups_suspended", var (data));
}

juce::var MoshOps::cmdRenameTrackGroup (const juce::var& args)
{
    auto group = findTrackGroupById (args.getProperty ("groupId", var()).toString());
    const auto name = args.getProperty ("name", var()).toString().trim();
    if (! group.isValid()) return errResult ("rename_track_group", "track group not found");
    if (name.isEmpty()) return errResult ("rename_track_group", "track group name cannot be empty");
    beginTxn ("rename_track_group");
    group.setProperty (ids::trackGroupName, name, &undoManager());
    logLine ("rename_track_group", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_track_group", trackGroupResult (group));
}

juce::var MoshOps::cmdRemoveTrackGroup (const juce::var& args)
{
    auto group = findTrackGroupById (args.getProperty ("groupId", var()).toString());
    if (! group.isValid()) return errResult ("remove_track_group", "track group not found");
    const auto result = trackGroupResult (group);
    beginTxn ("remove_track_group");
    group.getParent().removeChild (group, &undoManager());
    logLine ("remove_track_group", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_track_group", result);
}

juce::var MoshOps::trackGroupsToVar()
{
    Array<var> out;
    const auto groups = eng.edit().state.getChildWithName (ids::MOSH_TRACK_GROUPS);
    for (int index = 0; index < groups.getNumChildren(); ++index)
    {
        const auto group = groups.getChild (index);
        if (! group.hasType (ids::MOSH_TRACK_GROUP)) continue;
        auto* object = new DynamicObject();
        object->setProperty ("id", group[ids::id].toString());
        object->setProperty ("name", group[ids::trackGroupName].toString());
        object->setProperty ("kind", group[ids::trackGroupKind].toString());
        object->setProperty ("enabled", (bool) group.getProperty (ids::trackGroupEnabled, true));
        Array<var> mixAttributes;
        for (const auto& attribute : TrackGroup::mixAttributes (group)) mixAttributes.add (attribute);
        object->setProperty ("mixAttributes", mixAttributes);
        Array<var> memberIds;
        for (const auto& trackId : TrackGroup::memberIds (group))
            if (findTrack (trackId) != nullptr) memberIds.add (trackId);
        object->setProperty ("trackIds", memberIds);
        out.add (var (object));
    }
    return out;
}
}
