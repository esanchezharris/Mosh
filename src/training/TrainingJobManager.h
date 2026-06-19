#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
class TrainingJobManager
{
public:
    TrainingJobManager();
    ~TrainingJobManager();

    bool ensureServiceRunning();
    bool isHealthy();

    juce::String submitJob (const juce::String& corpusBundle,
                            const juce::var& config,
                            const juce::String& outputDir = {});
    juce::var jobStatus (const juce::String& jobId);
    void cancelJob (const juce::String& jobId);

private:
    juce::var httpGet (const juce::String& path);
    juce::var httpPost (const juce::String& path, const juce::var& body);
    juce::File locateServiceScript() const;

    juce::String baseUrl;
    juce::ChildProcess serviceProcess;
    bool spawnedByUs = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrainingJobManager)
};

} // namespace mosh

