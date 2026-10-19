#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <functional>

namespace mosh::reimagine
{
// Offline time-stretch for the M1 conform step (ReImagineSession.h planConform). Uses the
// SoundTouch library vendored inside Tracktion Engine (modules/tracktion_engine/3rd_party/
// soundtouch) with Tracktion's "SoundTouch (Better)" settings: the stretcher the main app's
// warp uses. The plug-in does not link the engine, so the library is compiled into its own
// namespace here. Pitch is unchanged. Worker-thread only: it allocates and is not real-time.
//
// stretchRatio is output length / input length; the output has exactly
// round(frames * stretchRatio) frames. Returns false (and an error) on bad input, or when
// shouldAbort (polled between chunks) returns true.
bool stretchForConform (const juce::AudioBuffer<float>& input, double sampleRate, double stretchRatio,
                        juce::AudioBuffer<float>& output, juce::String& error,
                        const std::function<bool()>& shouldAbort = {});
}
