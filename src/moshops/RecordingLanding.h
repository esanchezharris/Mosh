#pragma once

#include <juce_core/juce_core.h>

namespace mosh::recording
{

inline bool didLandClip (bool existedBefore,
                         bool isMidi,
                         const juce::String& beforeMidiNotes,
                         const juce::String& afterMidiNotes)
{
    if (! existedBefore)
        return true;

    return isMidi
        && beforeMidiNotes.isNotEmpty()
        && afterMidiNotes.isNotEmpty()
        && beforeMidiNotes != afterMidiNotes;
}

}
