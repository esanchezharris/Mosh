#pragma once

#include <juce_core/juce_core.h>

namespace mosh::directory_listing
{
inline constexpr int kMaxEntries = 512;
inline constexpr int kMaxVisitedEntries = 8192;

/** Build the data object returned by list_directory.

    This helper is engine-free so the WebView bridge may run it on a worker thread.
    Results and filesystem visits are bounded; callers can discard an obsolete result
    without blocking the audio/message thread.
*/
juce::var buildData (const juce::File& sessionDir,
                     const juce::var& args,
                     juce::Array<juce::File> sampleFolders = {});
}
