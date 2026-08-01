#pragma once

#include <juce_events/juce_events.h>

namespace mosh::instancepolicy
{
inline bool allowsMultipleInstances (const juce::StringArray& arguments)
{
    static const juce::StringArray independentModes {
        "--brain-smoke",
        "--golden-selftest",
        "--live-audio-smoke",
        "--run-script",
        "--scan-plugins-deep",
        "--selftest",
        "--selftest-undo",
        "--voice-smoke",
    };

    for (const auto& argument : arguments)
        if (independentModes.contains (argument)
            || argument.startsWith ("--PluginScan:"))
            return true;

    return false;
}
}
