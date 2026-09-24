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

/** V3-vocal (2026-09-19, found by `Mosh --v3-vocal-smoke` on a loopback): with a count-in,
    Tracktion records from the PRE-ROLL start (`prerollStart = punchIn − (countInBeats + 0.5)
    beats`, TransportControl::performRecord) and lands the clip there — the count-in bar,
    clicks and all, sits inside the take and the take starts a bar early. The producer
    counted in; they did not sing the count-in. So a landed clip that begins before the
    punch-in is trimmed to it (front-trim, source alignment preserved) whenever a count-in
    was in force. Without a count-in the landing is left exactly as Tracktion placed it —
    the record-latency shift of a few ms (ARE-003) is alignment, not pre-roll. */
inline bool shouldTrimLandedClipToPunchIn (bool countInActive, double clipStartSec, double punchInSec)
{
    return countInActive && clipStartSec < punchInSec - 0.0005;
}

inline bool captureApplied (int armedTrackCount, int landedTrackCount, bool discarded)
{
    return discarded || (armedTrackCount > 0 && landedTrackCount == armedTrackCount);
}

/** Every transport action that ENDS a recording lands it through cmdStopRecording first, so a
    Booth pass in flight is finalized as a pass. "continue" is Shift+Space (Live's Continue
    Playback): while recording the transport is playing, so cmdSetTransport takes it as a stop
    -- it was missing here until 2026-09-23 and ended a Booth take unstamped. */
inline bool shouldFinalizeBeforeTransportAction (bool isRecording,
                                                 const juce::String& action)
{
    return isRecording
        && (action == "stop" || action == "toggle" || action == "continue"
            || action == "record" || action == "to_start");
}

}
