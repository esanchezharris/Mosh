#pragma once

#include <juce_core/juce_core.h>
#include <memory>

namespace mosh
{

inline constexpr auto kVst3ScanWorkerFlag = "--mosh-vst3-scan-worker";
inline constexpr auto kVst3ScanResultTag = "MOSH_VST3_SCAN";

struct Vst3ScanWorkerRequest
{
    juce::File pluginBundle;
    juce::File outputXml;
    bool valid = false;
};

inline Vst3ScanWorkerRequest parseVst3ScanWorkerRequest (const juce::StringArray& args)
{
    if (args.size() != 3
        || args[0] != kVst3ScanWorkerFlag
        || args[1].trim().isEmpty()
        || args[2].trim().isEmpty())
        return {};

    return { juce::File (args[1]), juce::File (args[2]), true };
}

inline bool isVst3ScanWorkerCommand (const juce::StringArray& args)
{
    return ! args.isEmpty() && args[0] == kVst3ScanWorkerFlag;
}

enum class Vst3ScanOutcome
{
    completed,
    launchFailed,
    crashed,
    timedOut,
    invalidOutput,
};

struct Vst3ScanChildResult
{
    Vst3ScanOutcome outcome = Vst3ScanOutcome::invalidOutput;
    std::unique_ptr<juce::XmlElement> descriptions;
};

/** Run inside the short-lived worker process. Never construct MoshOps or the UI. */
int runVst3ScanWorker (const juce::StringArray& args);

/** Load one VST3 factory in a direct child and return metadata without instantiating classes. */
Vst3ScanChildResult scanVst3InChild (const juce::File& pluginBundle,
                                    int timeoutMs = 60000);

} // namespace mosh
