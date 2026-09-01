#include "OwnerRuntime.h"
#include "BrainProxy.h"
#include "util/Env.h"
#include <juce_events/juce_events.h>
#include <sys/stat.h>
#if JUCE_MAC || JUCE_LINUX
 #include <cerrno>
 #include <csignal>
 #include <unistd.h>
#endif

namespace mosh
{
using namespace juce;

OwnerRuntimeConfig OwnerRuntimeConfig::fromVar (const var& root)
{
    OwnerRuntimeConfig c;
    c.enabled = (bool) root.getProperty ("enabled", false);
    c.modelPathRaw = root.getProperty ("modelPath", var()).toString().trim();
    c.pythonRuntimeRaw = root.getProperty ("pythonRuntime", var()).toString().trim();
    if (File::isAbsolutePath (c.modelPathRaw)) c.modelPath = File (c.modelPathRaw);
    if (File::isAbsolutePath (c.pythonRuntimeRaw)) c.pythonRuntime = File (c.pythonRuntimeRaw);
    c.preferredPort = jlimit (1024, 65500, (int) root.getProperty ("preferredPort", 8491));
    c.stableAudioReleaseIdle = jlimit (0.0, 1.0, (double) root.getProperty ("stableAudioReleaseIdle", 0.99));
    c.prewarmAfterUnload = (bool) root.getProperty ("prewarmAfterUnload", true);
    c.preferredShell = root.getProperty ("preferredShell", var()).toString().trim();
    return c;
}

OwnerRuntimeConfig OwnerRuntimeConfig::load()
{
    const auto overridePath = SystemStats::getEnvironmentVariable ("MOSH_OWNER_RUNTIME_CONFIG", {}).trim();
    auto file = overridePath.isNotEmpty()
        ? File (overridePath)
        : File::getSpecialLocation (File::userHomeDirectory).getChildFile (".config/mosh/owner-runtime.json");
    if (! file.existsAsFile()) return {};

   #if JUCE_MAC || JUCE_LINUX
    struct stat info {};
    if (::stat (file.getFullPathName().toRawUTF8(), &info) != 0 || (info.st_mode & 077) != 0)
    {
        OwnerRuntimeConfig bad; bad.enabled = true; bad.sourceFile = file;
        return bad;
    }
   #endif
    auto c = fromVar (JSON::parse (file.loadFileAsString()));
    c.sourceFile = file;
    return c;
}

String OwnerRuntimeConfig::validationError() const
{
    if (! enabled) return {};
    if (sourceFile.existsAsFile())
    {
       #if JUCE_MAC || JUCE_LINUX
        struct stat info {};
        if (::stat (sourceFile.getFullPathName().toRawUTF8(), &info) != 0 || (info.st_mode & 077) != 0)
            return "owner runtime config must have mode 600";
       #endif
    }
    if (modelPathRaw.contains ("://"))
        return "owner runtime refuses remote model paths";
    if (modelPathRaw.isEmpty() || ! File::isAbsolutePath (modelPathRaw))
        return "owner runtime modelPath must be an absolute local path";
    if (pythonRuntimeRaw.isEmpty() || ! File::isAbsolutePath (pythonRuntimeRaw))
        return "owner runtime pythonRuntime must be an absolute local path";
    if (preferredShell.isNotEmpty() && preferredShell != "live" && preferredShell != "protools"
        && preferredShell != "v2" && preferredShell != "classic")
        return "owner runtime preferredShell is invalid";
    return {};
}

LocalBrainManager::LocalBrainManager (OwnerRuntimeConfig c) : config (std::move (c))
{
    publish (config.enabled ? "starting" : "unavailable",
             config.enabled ? config.validationError() : "owner runtime disabled");
}

LocalBrainManager::~LocalBrainManager()
{
    stopping = true;
    if (startupThread.joinable()) startupThread.join();
    if (prewarmThread.joinable()) prewarmThread.join();
    // Capture BEFORE terminateSpawnedChild clears them, or the handshake of a
    // cleanly-terminated server is never deleted and goes stale for adoption.
    const bool ownedSpawn = spawnedByUs;
    const int ownedPid = spawnedPid;
    terminateSpawnedChild();
    BrainProxy::configureLocal ({}, {});
    if (ownedSpawn)
    {
        const auto hs = JSON::parse (handshakeFile().loadFileAsString());
        if ((int) hs.getProperty ("pid", -1) == ownedPid)
            handshakeFile().deleteFile();
    }
}

bool LocalBrainManager::terminateOwnedProcess (int pid, bool verifiedOwner, int graceMs)
{
    if (! verifiedOwner || pid <= 1) return false;
   #if JUCE_MAC || JUCE_LINUX
    if (::kill (pid, SIGTERM) != 0 && errno != ESRCH) return false;
    const auto deadline = Time::getMillisecondCounter() + (uint32) jmax (0, graceMs);
    while ((int32) (deadline - Time::getMillisecondCounter()) > 0)
    {
        if (::kill (pid, 0) != 0 && errno == ESRCH) return true;
        Thread::sleep (20);
    }
    if (::kill (pid, SIGKILL) != 0 && errno != ESRCH) return false;
    return true;
   #else
    ignoreUnused (graceMs);
    return false;
   #endif
}

void LocalBrainManager::terminateSpawnedChild()
{
    if (! spawnedByUs) return;
    if (spawnedPid > 1)
        terminateOwnedProcess (spawnedPid, true);
    if (wrapperPid > 1)
        terminateOwnedProcess (wrapperPid, true);
    if (child.isRunning())
    {
        child.waitForProcessToFinish (1500);
        if (child.isRunning()) child.kill();
    }
    removeSpawnLedgerEntry (spawnedPid);
    spawnedByUs = false;
    spawnedPid = 0;
    wrapperPid = 0;
}

File LocalBrainManager::handshakeFile() const
{
    return File::getSpecialLocation (File::userApplicationDataDirectory)
        .getChildFile ("Mosh/runtime/local-brain.json");
}

File LocalBrainManager::spawnLedgerFile() const
{
    return handshakeFile().getSiblingFile ("spawned-brains.jsonl");
}

// The ps-command test used for BOTH adoption and reaping. It must accept our
// two owned shapes (the mlx server itself, and the supervisor wrapper) and must
// NEVER match any other mlx_lm server — the owner runs standing launchd mlx
// agents for other models, and signalling one of those is forbidden.
bool LocalBrainManager::commandLooksLikeOwnedBrain (const String& psCommand, const String& modelPath)
{
    if (modelPath.isEmpty()) return false;
    return (psCommand.contains ("mlx_lm") || psCommand.contains ("launch_local_brain"))
        && psCommand.contains (modelPath);
}

bool LocalBrainManager::handshakeMatches (const var& hs, int port,
                                          const String& modelPath, const String& pythonRuntime)
{
    return hs.getProperty ("owner", var()).toString() == "Mosh"
        && (int) hs.getProperty ("port", -1) == port
        && hs.getProperty ("modelPath", var()).toString() == modelPath
        && hs.getProperty ("pythonRuntime", var()).toString() == pythonRuntime
        && (int) hs.getProperty ("pid", -1) > 1;
}

String LocalBrainManager::spawnLedgerLine (int pid, int port, const String& modelPath)
{
    auto* o = new DynamicObject();
    o->setProperty ("pid", pid);
    o->setProperty ("port", port);
    o->setProperty ("modelPath", modelPath);
    o->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    return JSON::toString (var (o), true) + "\n";
}

Array<var> LocalBrainManager::parseSpawnLedger (const String& jsonlText)
{
    Array<var> out;
    for (const auto& line : StringArray::fromLines (jsonlText))
    {
        const auto row = JSON::parse (line.trim());
        if (row.isObject() && (int) row.getProperty ("pid", -1) > 1
            && (int) row.getProperty ("port", -1) > 0)
            out.add (row);
    }
    return out;
}

void LocalBrainManager::writeHandshake (int pid, int port) const
{
    handshakeFile().getParentDirectory().createDirectory();
    auto* h = new DynamicObject();
    h->setProperty ("owner", "Mosh");
    h->setProperty ("pid", pid);
    h->setProperty ("port", port);
    h->setProperty ("modelPath", config.modelPath.getFullPathName());
    h->setProperty ("pythonRuntime", config.pythonRuntime.getFullPathName());
    handshakeFile().replaceWithText (JSON::toString (var (h), true));
}

void LocalBrainManager::removeSpawnLedgerEntry (int pid)
{
    const auto ledger = spawnLedgerFile();
    if (pid <= 1 || ! ledger.existsAsFile()) return;
    StringArray kept;
    for (const auto& rec : parseSpawnLedger (ledger.loadFileAsString()))
        if ((int) rec.getProperty ("pid", -1) != pid)
            kept.add (JSON::toString (rec, true));
    if (kept.isEmpty()) ledger.deleteFile();
    else ledger.replaceWithText (kept.joinIntoString ("\n") + "\n");
}

// Startup backstop against orphans the in-process paths could not reap (the app
// was force-quit, or the wrapper itself was SIGKILLed): every spawn is recorded
// in a JSONL ledger, and the next launch either re-adopts a healthy survivor
// (repairing its handshake so the port scan finds it — no fresh multi-GB spawn)
// or terminates it after re-verifying via ps that the pid is still OUR brain.
void LocalBrainManager::sweepStaleSpawns()
{
    const auto ledger = spawnLedgerFile();
    if (! ledger.existsAsFile()) return;
    StringArray kept;
    for (const auto& rec : parseSpawnLedger (ledger.loadFileAsString()))
    {
        if (stopping) return;
        const int pid = (int) rec.getProperty ("pid", -1);
        const int port = (int) rec.getProperty ("port", -1);
        const auto model = rec.getProperty ("modelPath", var()).toString();
        ChildProcess ps;
        if (! ps.start ({ "/bin/ps", "-p", String (pid), "-o", "command=" }))
        {
            kept.add (JSON::toString (rec, true)); // could not verify: keep the row, touch nothing
            continue;
        }
        ps.waitForProcessToFinish (1000);
        const auto command = ps.readAllProcessOutput().trim();
        if (command.isEmpty()) continue;                             // pid is gone: drop the row
        if (! commandLooksLikeOwnedBrain (command, model)) continue; // pid reused by a stranger: never signal it
        const bool adoptable = model == config.modelPath.getFullPathName()
                            && port >= config.preferredPort && port < config.preferredPort + 20
                            && probeExactModel (port, 3000);
        if (adoptable)
        {
            writeHandshake (pid, port);
            logRuntimeEvent ("stale_spawn_adopted", rec);
            kept.add (JSON::toString (rec, true));
        }
        else
        {
            logRuntimeEvent ("stale_spawn_reaped", rec);
            terminateOwnedProcess (pid, true);
        }
    }
    if (kept.isEmpty()) ledger.deleteFile();
    else ledger.replaceWithText (kept.joinIntoString ("\n") + "\n");
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

bool LocalBrainManager::canAdopt (int port) const
{
    const auto hs = JSON::parse (handshakeFile().loadFileAsString());
    if (! handshakeMatches (hs, port, config.modelPath.getFullPathName(),
                            config.pythonRuntime.getFullPathName()))
        return false;
    const int pid = (int) hs.getProperty ("pid", -1);
    ChildProcess ps;
    if (! ps.start ({ "/bin/ps", "-p", String (pid), "-o", "command=" })) return false;
    ps.waitForProcessToFinish (1000);
    return commandLooksLikeOwnedBrain (ps.readAllProcessOutput(),
                                       config.modelPath.getFullPathName());
}

void LocalBrainManager::publish (String state, String error, double ms)
{
    auto* o = new DynamicObject();
    o->setProperty ("state", state);
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

var LocalBrainManager::status() const
{
    const ScopedLock sl (lock);
    return currentStatus.clone();
}

void LocalBrainManager::setStatusCallback (std::function<void (var)> cb)
{
    const ScopedLock sl (lock); statusCallback = std::move (cb);
}

void LocalBrainManager::startAsync()
{
    if (! config.enabled || config.validationError().isNotEmpty() || startupThread.joinable()) return;
    const auto release = String (config.stableAudioReleaseIdle, 3);
    mosh::setEnvVar ("MOSH_SA3_RELEASE_IDLE", release.toRawUTF8());
    startupThread = std::thread ([this] { runStartup(); });
}

void LocalBrainManager::runStartup()
{
    if (! config.modelPath.isDirectory() || ! config.pythonRuntime.existsAsFile())
    {
        publish ("unavailable", "configured model or Python runtime is missing"); return;
    }
    publish ("starting");
    sweepStaleSpawns();
    bool preferredHeldByStranger = false;
    for (int port = config.preferredPort; port < config.preferredPort + 20 && ! stopping; ++port)
    {
        if (portIsOccupied (port))
        {
            if (probeExactModel (port) && canAdopt (port))
            {
                activePort = port;
                BrainProxy::configureLocal ("http://127.0.0.1:" + String (port) + "/v1",
                                            config.modelPath.getFullPathName());
                publish ("ready"); return;
            }
            // A stranger (e.g. a standing launchd agent) holds this port. Never
            // adopt it, never fight for it — and never SILENTLY walk past it.
            if (port == config.preferredPort) preferredHeldByStranger = true;
            logRuntimeEvent ("port_conflict", port);
            continue;
        }

        auto script = File::getSpecialLocation (File::currentExecutableFile)
                          .getParentDirectory().getParentDirectory().getChildFile ("Resources/service/sft/launch_local_brain.py");
        if (! script.existsAsFile())
            script = File::getCurrentWorkingDirectory().getChildFile ("service/sft/launch_local_brain.py");
        const auto pidFile = handshakeFile().getSiblingFile ("local-brain.pid");
        pidFile.deleteFile();
        StringArray args { config.pythonRuntime.getFullPathName(), script.getFullPathName(),
                           pidFile.getFullPathName(), config.pythonRuntime.getFullPathName(),
                           config.modelPath.getFullPathName(), String (port) };
        if (! child.start (args)) continue;
        spawnedByUs = true;
        for (int tries = 0; tries < 40 && ! pidFile.existsAsFile(); ++tries) Thread::sleep (50);
        const auto pids = JSON::parse (pidFile.loadFileAsString());
        wrapperPid = (int) pids.getProperty ("wrapper", 0);
        spawnedPid = (int) pids.getProperty ("server", 0);
        if (spawnedPid > 1)
            spawnLedgerFile().appendText (spawnLedgerLine (spawnedPid, port,
                                                           config.modelPath.getFullPathName()));
        activePort = port;
        const auto deadline = Time::getMillisecondCounter() + 120000u;
        while (! stopping && child.isRunning()
               && (int32) (deadline - Time::getMillisecondCounter()) > 0)
        {
            if (spawnedPid <= 1 && pidFile.existsAsFile())
            {
                // The wrapper wrote its pidfile late (loaded machine): catch up so
                // the ledger and handshake still identify the real server pid.
                const auto late = JSON::parse (pidFile.loadFileAsString());
                wrapperPid = (int) late.getProperty ("wrapper", 0);
                spawnedPid = (int) late.getProperty ("server", 0);
                if (spawnedPid > 1)
                    spawnLedgerFile().appendText (spawnLedgerLine (spawnedPid, port,
                                                                   config.modelPath.getFullPathName()));
            }
            if (probeExactModel (port, 700))
            {
                writeHandshake (spawnedPid, port);
                BrainProxy::configureLocal ("http://127.0.0.1:" + String (port) + "/v1",
                                            config.modelPath.getFullPathName());
                publish ("ready"); return;
            }
            Thread::sleep (250);
        }
        if (! child.isRunning() && ! stopping)
        {
            // The wrapper died on its own (bad env, or it lost a port-bind race):
            // nothing is left resident, so the next port cannot accumulate servers.
            terminateSpawnedChild();
            activePort = 0;
            logRuntimeEvent ("spawn_exited", port);
            continue;
        }
        // One live spawn per launch: a server that never became ready is reaped,
        // and we STOP here rather than cascading fresh multi-GB spawns up the
        // range (2026-09-01: four 17GB orphans, ~70GB swap).
        terminateSpawnedChild();
        activePort = 0;
        if (! stopping)
        {
            logRuntimeEvent ("spawn_ready_timeout", port);
            publish ("unavailable", "spawned local brain on port " + String (port)
                                        + " never became ready; not retrying");
        }
        return;
    }
    if (! stopping)
        publish ("unavailable", preferredHeldByStranger
            ? "preferred port " + String (config.preferredPort)
                + " is held by another local server (a standing launchd agent?) and no port in +20 was usable;"
                + " set ownerRuntime preferredPort to a free range"
            : "no verified local-brain endpoint available");
}

void LocalBrainManager::prewarmAfterStableAudioUnload (const var& unloadMetrics)
{
    if (! config.prewarmAfterUnload || activePort.load() <= 0 || prewarmInFlight.exchange (true)) return;
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
    publish ("ready", ok ? String() : "local-brain prewarm failed", ms);
}
}
