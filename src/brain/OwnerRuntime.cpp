#include "OwnerRuntime.h"
#include "BrainProxy.h"
#include "LocalBrainProcessRegistry.h"
#include "util/Env.h"
#include <juce_events/juce_events.h>
#include <sys/stat.h>
#if JUCE_MAC || JUCE_LINUX
 #include <unistd.h>
#endif

namespace mosh
{
using namespace juce;

LocalBrainManager::LocalBrainManager (OwnerRuntimeConfig c) : config (std::move (c))
{
    const auto error = config.validationError();
    if (! config.enabled) publish ("unavailable", "owner runtime disabled");
    else if (error.isNotEmpty()) publish ("unavailable", error);
    else publish ("off");
}

LocalBrainManager::~LocalBrainManager()
{
    if (stopAsync())
    {
        if (stopThread.joinable()) stopThread.join();
        return;
    }

    stopRequested = true;
    BrainProxy::configureLocal ({}, {});
    if (stopThread.joinable()) stopThread.join();
    else
    {
        if (startupThread.joinable()) startupThread.join();
        if (prewarmThread.joinable()) prewarmThread.join();
    }
    terminateSpawnedChild();
    removeHandshakeForSpawnedProcess();
}

void LocalBrainManager::terminateSpawnedChild()
{
    if (spawnedPid <= 1) return;
    const LocalBrainExpectedProcess expected {
        config.pythonRuntime, config.modelPath, "127.0.0.1", config.preferredPort
    };
    (void) LocalBrainProcessRegistry::terminateOwnedProcess (processRecordFile(), expected);
    if (child.isRunning())
        child.waitForProcessToFinish (500);
}

File LocalBrainManager::runtimeDirectory() const
{
    return LocalBrainProcessRegistry::defaultDirectory().getParentDirectory();
}

File LocalBrainManager::handshakeFile() const
{
    return runtimeDirectory().getChildFile ("local-brain.json");
}

File LocalBrainManager::pidFile() const
{
    return runtimeDirectory().getChildFile ("local-brain.pid");
}

File LocalBrainManager::processRecordFile() const
{
    return LocalBrainProcessRegistry::defaultDirectory().getChildFile (String (spawnedPid) + ".json");
}

void LocalBrainManager::removeHandshakeForSpawnedProcess()
{
    const auto handshake = JSON::parse (handshakeFile().loadFileAsString());
    if ((int) handshake.getProperty ("pid", -1) == spawnedPid)
        handshakeFile().deleteFile();
    if (pidFile().loadFileAsString().getIntValue() == spawnedPid)
        pidFile().deleteFile();
    spawnedPid = 0;
}

void LocalBrainManager::logRuntimeEvent (const String& event, const var& data) const
{
    auto file = handshakeFile().getSiblingFile ("owner-runtime.jsonl");
    file.getParentDirectory().createDirectory();
    auto* row = new DynamicObject(); row->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    row->setProperty ("event", event); row->setProperty ("model", config.modelPath.getFullPathName());
    row->setProperty ("port", activePort.load()); if (! data.isVoid()) row->setProperty ("data", data);
    file.appendText (JSON::toString (var (row), true) + "\n");
}

bool LocalBrainManager::modelsResponseMatches (const var& response, const String& exactModelPath)
{
    const auto data = response.getProperty ("data", var());
    if (auto* rows = data.getArray())
        for (const auto& row : *rows)
            if (row.getProperty ("id", var()).toString() == exactModelPath)
                return true;
    return false;
}

bool LocalBrainManager::probeExactModel (int port, int timeoutMs) const
{
    URL url ("http://127.0.0.1:" + String (port) + "/v1/models");
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (timeoutMs);
    if (auto s = url.createInputStream (opts))
        return modelsResponseMatches (JSON::parse (s->readEntireStreamAsString()),
                                      config.modelPath.getFullPathName());
    return false;
}

bool LocalBrainManager::portIsOccupied (int port) const
{
    StreamingSocket s;
    return s.connect ("127.0.0.1", port, 120);
}

void LocalBrainManager::publish (String state, String error, double ms)
{
    auto* o = new DynamicObject();
    o->setProperty ("state", state);
    o->setProperty ("configured", config.enabled && config.validationError().isEmpty());
    o->setProperty ("model", config.modelPath.getFullPathName());
    const auto port = activePort.load();
    o->setProperty ("port", port);
    o->setProperty ("endpoint", port > 0 ? "http://127.0.0.1:" + String (port) + "/v1" : String());
    if (config.preferredShell.isNotEmpty()) o->setProperty ("preferredShell", config.preferredShell);
    if (error.isNotEmpty()) o->setProperty ("error", error);
    if (ms > 0.0) o->setProperty ("ms", ms);
    const var next (o);
    std::function<void (var)> cb;
    { const ScopedLock sl (lock); currentStatus = next; cb = statusCallback; }
    if (cb) MessageManager::callAsync ([cb, next] { cb (next); });
}

String LocalBrainManager::state() const
{
    const ScopedLock sl (lock);
    return currentStatus.getProperty ("state", var()).toString();
}

var LocalBrainManager::status() const
{
    const ScopedLock sl (lock);
    return currentStatus.clone();
}

void LocalBrainManager::setStatusCallback (std::function<void (var)> cb)
{
    const ScopedLock sl (lock); statusCallback = std::move (cb);
}

bool LocalBrainManager::initializeAsync()
{
    if (! config.enabled || config.validationError().isNotEmpty()) return false;
    const ScopedLock lifecycle (lifecycleLock);
    if (state() != "off") return false;
    if (stopThread.joinable()) stopThread.join();
    if (startupThread.joinable()) startupThread.join();
    stopRequested = false;
    publish ("cleaning");
    startupThread = std::thread ([this] { runInitialization(); });
    return true;
}

void LocalBrainManager::runInitialization()
{
    (void) LocalBrainProcessRegistry::reapOwnedProcesses (
        LocalBrainProcessRegistry::defaultDirectory());
    handshakeFile().deleteFile();
    pidFile().deleteFile();
    if (stopRequested) return;
    if (config.autoStart)
    {
        publish ("starting");
        runStartup();
    }
    else publish ("off");
}

bool LocalBrainManager::startAsync()
{
    if (! config.enabled || config.validationError().isNotEmpty()) return false;
    const ScopedLock lifecycle (lifecycleLock);
    const auto current = state();
    if (current != "off" && current != "error") return false;
    if (stopThread.joinable()) stopThread.join();
    if (startupThread.joinable()) startupThread.join();
    const auto release = String (config.stableAudioReleaseIdle, 3);
    mosh::setEnvVar ("MOSH_SA3_RELEASE_IDLE", release.toRawUTF8());
    stopRequested = false;
    publish ("starting");
    startupThread = std::thread ([this]
    {
        (void) LocalBrainProcessRegistry::reapOwnedProcesses (
            LocalBrainProcessRegistry::defaultDirectory());
        if (! stopRequested) runStartup();
    });
    return true;
}

bool LocalBrainManager::stopAsync()
{
    if (! config.enabled || config.validationError().isNotEmpty()) return false;
    const ScopedLock lifecycle (lifecycleLock);
    const auto current = state();
    if (current == "stopping" || current == "unavailable") return false;
    if (stopThread.joinable()) stopThread.join();
    stopRequested = true;
    BrainProxy::configureLocal ({}, {});
    activePort = 0;
    publish ("stopping");
    stopThread = std::thread ([this]
    {
        if (startupThread.joinable()) startupThread.join();
        if (prewarmThread.joinable()) prewarmThread.join();
        terminateSpawnedChild();
        removeHandshakeForSpawnedProcess();
        publish ("off");
    });
    return true;
}

void LocalBrainManager::runStartup()
{
    if (! config.modelPath.isDirectory() || ! config.pythonRuntime.existsAsFile())
    {
        publish ("error", "configured model or Python runtime is missing"); return;
    }
    const int port = config.preferredPort;
    if (portIsOccupied (port))
    {
        publish ("error", "preferred local AI port " + String (port) + " is already in use");
        return;
    }

    auto script = File::getSpecialLocation (File::currentExecutableFile)
                      .getParentDirectory().getParentDirectory().getChildFile ("Resources/service/sft/launch_local_brain.py");
    if (! script.existsAsFile())
        script = File::getCurrentWorkingDirectory().getChildFile ("service/sft/launch_local_brain.py");
    runtimeDirectory().createDirectory();
    LocalBrainProcessRegistry::defaultDirectory().createDirectory();
   #if JUCE_MAC || JUCE_LINUX
    (void) ::chmod (runtimeDirectory().getFullPathName().toRawUTF8(), 0700);
    (void) ::chmod (LocalBrainProcessRegistry::defaultDirectory().getFullPathName().toRawUTF8(), 0700);
   #endif
    pidFile().deleteFile();
    StringArray args { config.pythonRuntime.getFullPathName(), script.getFullPathName(),
                       pidFile().getFullPathName(),
                       LocalBrainProcessRegistry::defaultDirectory().getFullPathName(),
                       config.pythonRuntime.getFullPathName(), config.modelPath.getFullPathName(),
                       String (port) };
    if (! child.start (args))
    {
        publish ("error", "could not launch the configured local AI runtime");
        return;
    }
    for (int tries = 0; tries < 40 && ! pidFile().existsAsFile() && child.isRunning(); ++tries)
        Thread::sleep (25);
    spawnedPid = pidFile().loadFileAsString().getIntValue();
    if (spawnedPid <= 1 || ! processRecordFile().existsAsFile())
    {
        publish ("error", "local AI launcher did not create a valid ownership record");
        return;
    }
    activePort = port;
    const auto deadline = Time::getMillisecondCounter() + 120000u;
    while (! stopRequested && child.isRunning()
           && (int32) (deadline - Time::getMillisecondCounter()) > 0)
    {
        if (probeExactModel (port, 700))
        {
            handshakeFile().getParentDirectory().createDirectory();
            auto* h = new DynamicObject();
            h->setProperty ("owner", "Mosh"); h->setProperty ("pid", spawnedPid);
            h->setProperty ("port", port); h->setProperty ("modelPath", config.modelPath.getFullPathName());
            h->setProperty ("pythonRuntime", config.pythonRuntime.getFullPathName());
            handshakeFile().replaceWithText (JSON::toString (var (h), true));
           #if JUCE_MAC || JUCE_LINUX
            (void) ::chmod (handshakeFile().getFullPathName().toRawUTF8(), 0600);
           #endif
            BrainProxy::configureLocal ("http://127.0.0.1:" + String (port) + "/v1",
                                        config.modelPath.getFullPathName());
            publish ("ready");
            return;
        }
        Thread::sleep (250);
    }
    if (stopRequested) return;
    terminateSpawnedChild();
    removeHandshakeForSpawnedProcess();
    activePort = 0;
    publish ("error", "local AI did not become ready on port " + String (port));
}

void LocalBrainManager::prewarmAfterStableAudioUnload (const var& unloadMetrics)
{
    if (! config.prewarmAfterUnload || stopRequested || activePort.load() <= 0
        || prewarmInFlight.exchange (true)) return;
    logRuntimeEvent ("stable_audio_unloaded", unloadMetrics);
    if (prewarmThread.joinable()) prewarmThread.join();
    prewarmThread = std::thread ([this] { runPrewarm(); prewarmInFlight = false; });
}

void LocalBrainManager::runPrewarm()
{
    publish ("prewarming");
    const auto t0 = Time::getMillisecondCounterHiRes();
    auto* msg = new DynamicObject(); msg->setProperty ("role", "user"); msg->setProperty ("content", "{}");
    Array<var> messages; messages.add (var (msg));
    auto* body = new DynamicObject(); body->setProperty ("model", config.modelPath.getFullPathName());
    body->setProperty ("messages", messages); body->setProperty ("max_tokens", 1); body->setProperty ("temperature", 0);
    URL url = URL ("http://127.0.0.1:" + String (activePort.load()) + "/v1/chat/completions")
                  .withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (2500).withExtraHeaders ("Content-Type: application/json\r\nAuthorization: Bearer local");
    bool ok = false;
    if (auto s = url.createInputStream (opts)) ok = JSON::parse (s->readEntireStreamAsString()).isObject();
    const double ms = Time::getMillisecondCounterHiRes() - t0;
    auto* log = new DynamicObject(); log->setProperty ("ok", ok); log->setProperty ("durationMs", ms);
    logRuntimeEvent ("brain_prewarm", var (log));
    // A failed optimization never demotes an already-verified server: the render is
    // complete and normal inference remains available, merely without a warm cache.
    if (! stopRequested)
        publish ("ready", ok ? String() : "local-brain prewarm failed", ms);
}
}
