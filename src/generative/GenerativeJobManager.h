#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
/** The native Generative Job Manager (05 §4). Talks to the model service over a
    local job protocol — control via HTTP/JSON, audio via files+manifests. Owns
    service lifecycle (spawn/detect, health handshake, cancel) and never blocks
    the audio thread (renders are background jobs; the source take keeps playing).

    Tier B is a JOB, not an insert — the only out-of-process component. */
class GenerativeJobManager
{
public:
    GenerativeJobManager();
    ~GenerativeJobManager();

    /** Ensure the service is reachable: probe /health, spawning the bundled
        Python service (service/server.py) if needed. Returns true if healthy. */
    bool ensureServiceRunning();
    bool isHealthy();

    juce::var capabilities();

    /** Submit a render job. Returns the jobId (empty on failure). Non-blocking. */
    juce::String submitJob (const juce::File& inputWav, const juce::File& outputWav,
                            const juce::File& manifest, const juce::var& params);

    /** Poll a job's status: { ok, status, progress, outputWav, manifest }. */
    juce::var jobStatus (const juce::String& jobId);
    void cancelJob (const juce::String& jobId);

    juce::String serviceBuild() const { return svcBuild; }

private:
    juce::var httpGet (const juce::String& path);
    juce::var httpPost (const juce::String& path, const juce::var& body);

    juce::String baseUrl;
    juce::ChildProcess serviceProcess;
    bool spawnedByUs = false;
    juce::String svcBuild;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GenerativeJobManager)
};

} // namespace mosh
