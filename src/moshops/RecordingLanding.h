#pragma once

#include <juce_core/juce_core.h>

namespace mosh::recording
{

inline bool didLandClip (bool existedBefore,
                         const juce::String& beforeCaptureState,
                         const juce::String& afterCaptureState)
{
    if (! existedBefore)
        return true;

    return beforeCaptureState.isNotEmpty()
        && afterCaptureState.isNotEmpty()
        && beforeCaptureState != afterCaptureState;
}

inline bool captureApplied (int armedTrackCount, int landedTrackCount, bool discarded)
{
    return discarded || (armedTrackCount > 0 && landedTrackCount == armedTrackCount);
}

inline bool shouldFinalizeBeforeTransportAction (bool isRecording,
                                                 const juce::String& action)
{
    return isRecording
        && (action == "stop" || action == "toggle"
            || action == "record" || action == "to_start");
}

}
