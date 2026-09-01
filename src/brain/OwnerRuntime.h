#pragma once

#include <juce_core/juce_core.h>
#include <atomic>
#include <functional>
#include <thread>

namespace mosh
{
struct OwnerRuntimeConfig
{
    bool enabled = false;
    bool autoStart = false;
    juce::File sourceFile;
    juce::File modelPath;
    juce::File pythonRuntime;
    juce::String modelPathRaw;
    juce::String pythonRuntimeRaw;
    int preferredPort = 8091;
    double stableAudioReleaseIdle = 0.99;
    bool prewarmAfterUnload = true;
    juce::String preferredShell;

    static OwnerRuntimeConfig load();
    static OwnerRuntimeConfig fromVar (const juce::var&);
    juce::String validationError() const;
};

class LocalBrainManager
{
public:
    explicit LocalBrainManager (OwnerRuntimeConfig);
    ~LocalBrainManager();

    bool initializeAsync();
    bool startAsync();
    bool stopAsync();
    void prewarmAfterStableAudioUnload (const juce::var& unloadMetrics = {});
    juce::var status() const;
    void setStatusCallback (std::function<void (juce::var)> cb);

    static bool modelsResponseMatches (const juce::var&, const juce::String& exactModelPath);

private:
    void runStartup();
    void runInitialization();
    void runPrewarm();
    bool probeExactModel (int port, int timeoutMs = 1000) const;
    bool portIsOccupied (int port) const;
    void publish (juce::String state, juce::String error = {}, double ms = 0.0);
    juce::String state() const;
    juce::File runtimeDirectory() const;
    juce::File handshakeFile() const;
    juce::File pidFile() const;
    juce::File processRecordFile() const;
    void logRuntimeEvent (const juce::String& event, const juce::var& data = {}) const;
    void terminateSpawnedChild();
    void removeHandshakeForSpawnedProcess();

    OwnerRuntimeConfig config;
    mutable juce::CriticalSection lock;
    juce::CriticalSection lifecycleLock;
    juce::var currentStatus;
    std::function<void (juce::var)> statusCallback;
    juce::ChildProcess child;
    std::thread startupThread;
    std::thread stopThread;
    std::thread prewarmThread;
    std::atomic<bool> stopRequested { false };
    std::atomic<bool> prewarmInFlight { false };
    std::atomic<int> activePort { 0 };
    int spawnedPid = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LocalBrainManager)
};
}
