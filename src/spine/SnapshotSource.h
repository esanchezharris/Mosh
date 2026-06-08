#pragma once
#include <juce_core/juce_core.h>

namespace mosh
{
    // The read side of the feed (02 §4.1). The app implements this by walking the
    // Tracktion Edit/model into the snapshot schema (ui/src/bridge.ts). Tests
    // implement it over a fake model. Returns the entire session as plain data.
    struct SnapshotSource
    {
        virtual ~SnapshotSource() = default;
        virtual juce::var getSnapshot() = 0;
    };
}
