#pragma once
#include "MoshEngine.h"
#include "SnapshotSource.h"

namespace mosh
{
    // Shared serializers (the snapshot source AND command handlers build event
    // payloads from these, so a track/clip looks identical in a snapshot and in a
    // track_added/clip_added event).
    juce::var trackToVar (te::AudioTrack*);
    juce::var clipToVar  (te::Clip*);

    // Walks the Tracktion Edit into the snapshot schema the UI renders (02 §4.1,
    // ui/src/bridge.ts). The ONLY place engine internals are projected to the
    // frontend's plain-data vocabulary — no Tracktion concepts leak past here.
    class EngineSnapshotSource : public SnapshotSource
    {
    public:
        explicit EngineSnapshotSource (MoshEngine& e) : eng (e) {}
        juce::var getSnapshot() override;

    private:
        MoshEngine& eng;
    };
}
