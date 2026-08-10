#pragma once

#include <juce_core/juce_core.h>
#include <functional>

namespace mosh
{
class MoshEngine;
class MoshOps;

struct MultiplayerAudioRefSelfTestCallbacks
{
    std::function<void (const juce::String&)> section;
    std::function<void (bool, const juce::String&)> check;
    std::function<int (const juce::String&)> eventCount;
};

void runMultiplayerAudioRefSelfTest (MoshEngine&, MoshOps&,
                                     const MultiplayerAudioRefSelfTestCallbacks&);
}
