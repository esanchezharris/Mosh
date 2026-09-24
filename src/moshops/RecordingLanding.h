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

/** loop_stop is the Booth's and the phone's panic button: it ends WHATEVER is recording. A
    pass the loop started is finalized as a pass (its own transaction, the pass id stamped, a
    Part). Any other recording -- the TopBar Record, an agent's set_transport record -- is
    landed the way a TopBar stop lands it: preserved, unstamped. The Booth shows its Stop pad
    for such a take (phase "recording") and the phone's Stop is always live once the loop is
    engaged. Until 2026-09-23 both cases went to the pass finalize, which returns at once when
    no pass is in flight, so the transport kept recording under a "Stopped" receipt. */
enum class LoopStopRoute { finalizePass, landTake, stopPlayback, nothing };

inline LoopStopRoute loopStopRoute (bool recording, bool passInFlight, bool playing)
{
    if (recording)
        return passInFlight ? LoopStopRoute::finalizePass : LoopStopRoute::landTake;
    return playing ? LoopStopRoute::stopPlayback : LoopStopRoute::nothing;
}

/** loop_stop's receipt: the one sentence the Booth and the phone show. It never says
    "Stopped" while the transport is still recording. `landed` is false for a stop inside
    the count-in, where nothing has been captured yet. */
inline juce::String loopStopDetail (bool wasRecording, bool stillRecording, bool landed)
{
    if (wasRecording && stillRecording)
        return juce::String (juce::CharPointer_UTF8 ("Still recording \xe2\x80\x94 press Stop again"));
    if (wasRecording && ! landed)
        return "Stopped before recording began";
    return "Stopped";
}

}
