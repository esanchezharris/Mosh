#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
struct LocalBrainExpectedProcess
{
    juce::File pythonRuntime;
    juce::File modelPath;
    juce::String host;
    int port = 0;
};

struct LocalBrainReapResult
{
    int terminated = 0;
    int staleRemoved = 0;
    int ignored = 0;
};

class LocalBrainProcessRegistry
{
public:
    static juce::File defaultDirectory();
    static bool recordMatchesExpected (const juce::File& recordFile,
                                       const LocalBrainExpectedProcess& expected);
    static bool terminateOwnedProcess (const juce::File& recordFile,
                                       const LocalBrainExpectedProcess& expected,
                                       int graceMs = 2000);
    static LocalBrainReapResult reapOwnedProcesses (const juce::File& recordDirectory,
                                                    int graceMs = 2000);
};
}
