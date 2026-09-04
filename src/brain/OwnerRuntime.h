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
    juce::File sourceFile;
    juce::File modelPath;
    juce::File pythonRuntime;
    juce::String modelPathRaw;
    juce::String pythonRuntimeRaw;
    // Default range 8491+: 8091 is contended on the owner machine by a standing
    // launchd KeepAlive mlx agent, which cascaded fresh spawns every launch.
    int preferredPort = 8491;
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

    void startAsync();
    void prewarmAfterStableAudioUnload (const juce::var& unloadMetrics = {});
    juce::var status() const;
    void setStatusCallback (std::function<void (juce::var)> cb);

    static bool modelsResponseMatches (const juce::var&, const juce::String& exactModelPath);
    static bool terminateOwnedProcess (int pid, bool verifiedOwner, int graceMs = 2000);
    static bool commandLooksLikeOwnedBrain (const juce::String& psCommand, const juce::String& modelPath);
    static bool handshakeMatches (const juce::var& handshake, int port,
                                  const juce::String& modelPath, const juce::String& pythonRuntime);
    static juce::String spawnLedgerLine (int pid, int port, const juce::String& modelPath);
    static juce::Array<juce::var> parseSpawnLedger (const juce::String& jsonlText);

private:
    void runStartup();
    void runPrewarm();
    bool probeExactModel (int port, int timeoutMs = 1000) const;
    bool portIsOccupied (int port) const;
    bool canAdopt (int port) const;
    void publish (juce::String state, juce::String error = {}, double ms = 0.0);
    juce::File handshakeFile() const;
    juce::File spawnLedgerFile() const;
    void writeHandshake (int pid, int port) const;
    void sweepStaleSpawns();
    void removeSpawnLedgerEntry (int pid);
    void logRuntimeEvent (const juce::String& event, const juce::var& data = {}) const;
    void terminateSpawnedChild();

    OwnerRuntimeConfig config;
    mutable juce::CriticalSection lock;
    juce::var currentStatus;
    std::function<void (juce::var)> statusCallback;
    juce::ChildProcess child;
    std::thread startupThread;
    std::thread prewarmThread;
    std::atomic<bool> stopping { false };
    std::atomic<bool> prewarmInFlight { false };
    bool spawnedByUs = false;
    std::atomic<int> activePort { 0 };
    int spawnedPid = 0;
    int wrapperPid = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LocalBrainManager)
};
}
