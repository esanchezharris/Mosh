#pragma once

#include <juce_core/juce_core.h>

namespace mosh::mac
{
enum class MicrophonePermissionStatus
{
    granted,
    denied,
    restricted,
    timedOut
};

inline juce::String microphonePermissionError (MicrophonePermissionStatus status)
{
    switch (status)
    {
        case MicrophonePermissionStatus::granted:
            return {};
        case MicrophonePermissionStatus::denied:
            return "Microphone access is off for Mosh. Enable it in System Settings > Privacy & Security > Microphone, then arm the track again.";
        case MicrophonePermissionStatus::restricted:
            return "Microphone access is not available on this Mac.";
        case MicrophonePermissionStatus::timedOut:
            return "The microphone permission request did not finish. Playback remains available; arm the track again to retry.";
    }
    return "Microphone access is not available on this Mac.";
}

#if JUCE_MAC
MicrophonePermissionStatus requestMicrophonePermission (int timeoutMs = 120000);
#else
inline MicrophonePermissionStatus requestMicrophonePermission (int = 120000)
{
    return MicrophonePermissionStatus::granted;
}
#endif
}
