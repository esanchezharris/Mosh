#pragma once

#include "engine/MoshEngine.h"
#include "generative/DirectRenderJob.h"
#include "state/RenderLayer.h"

namespace mosh::direct_render
{
inline const juce::Identifier policy ("decisionPolicy"), committed ("committedArtifact"), anchor ("directCommittedAnchor"),
    pending ("hasPending"), request ("requestId"), jobIdProperty ("jobId"), audition ("audition"),
    pendingShape ("directPendingShape"), pendingStart ("directSourceStart"), provenance ("directManifest"),
    pendingSourceHash ("directPendingSourceHash"), fixtureProperty ("testFixture");

inline bool explicitLayer (const juce::ValueTree& node) { return node[policy].toString() == "explicit"; }
inline bool fixtureEnabled()
{
    return juce::SystemStats::getEnvironmentVariable ("MOSH_DIRECT_RENDER_TEST_FIXTURE", "0") == "1"
        && juce::SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {}).isNotEmpty();
}
inline juce::String unsupported (const te::WaveAudioClip& clip)
{
    if (clip.isLooping() || clip.getAutoTempo() || clip.getWarpTime() || clip.getIsReversed()
        || clip.getAutoPitch() || std::abs (clip.getSpeedRatio() - 1.0) > 1.0e-8)
        return "Direct Re-Imagine needs a non-looping, unwarped, unreversed audio clip at its original speed. Bounce this material first.";
    return {};
}
inline juce::String shape (const te::WaveAudioClip& clip, const juce::ValueTree& layer)
{
    const auto p = clip.getPosition();
    return clip.itemID.toString() + ":" + clip.getTrack()->itemID.toString()
        + ":" + juce::String (p.getStart().inSeconds(), 12) + ":" + juce::String (p.getLength().inSeconds(), 12)
        + ":" + juce::String (p.getOffset().inSeconds(), 12) + ":" + juce::String (clip.getSpeedRatio(), 12)
        + ":" + juce::String (int (clip.isLooping())) + juce::String (int (clip.getAutoTempo())) + juce::String (int (clip.getWarpTime()))
        + juce::String (int (clip.getIsReversed())) + juce::String (int (clip.getAutoPitch()))
        + ":" + layer[ids::seed].toString() + ":" + layer.getChildWithName (ids::PARAMS).toXmlString();
}

inline void pointSource (te::WaveAudioClip& clip, const juce::File& file, double offset, const juce::File& parent)
{
    auto& source = clip.getSourceFileReference().source;
    source.setValue (file.isAChildOf (parent)
        ? file.getRelativePathFrom (parent).replaceCharacter ('\\', '/') : file.getFullPathName(), nullptr);
    clip.sourceMediaChanged();
    clip.state.setProperty (te::IDs::offset, offset, nullptr);
}

struct SourceAction final : juce::UndoableAction
{
    te::Edit& edit;
    te::EditItemID clipId;
    juce::File before, after, parent;
    double beforeOffset, afterOffset;

    SourceAction (te::WaveAudioClip& clip, juce::File destination, double offset, juce::File directory)
        : edit (clip.edit), clipId (clip.itemID), before (clip.getCurrentSourceFile()), after (destination), parent (directory),
          beforeOffset (clip.getPosition().getOffset().inSeconds()), afterOffset (offset) {}

    bool set (const juce::File& file, double offset)
    {
        if (auto* clip = dynamic_cast<te::WaveAudioClip*> (te::findClipForID (edit, clipId)); clip && file.existsAsFile())
        { pointSource (*clip, file, offset, parent); return true; }
        return false;
    }

    bool perform() override { return set (after, afterOffset); }
    bool undo() override { return set (before, beforeOffset); }
};
}

struct mosh::MoshOps::DirectRenderRequest
{
    DirectRenderJob work;
    juce::ValueTree edit, clip, layer;
    juce::String shapeAtSubmit, lastStatus, lastJobId, decision;
    juce::File liveSource, liveOutput;
    juce::int64 sourceSize = 0, sourceModified = 0, outputSize = 0, outputModified = 0;
};

struct mosh::MoshOps::DirectAudition
{
    juce::ValueTree edit, clip, layer;
    juce::File source;
    double offset = 0;
};
