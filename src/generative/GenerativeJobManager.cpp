#include "GenerativeJobManager.h"
#include <cstdlib>

namespace mosh
{
using namespace juce;

namespace
{
    // Stable, spawner-agnostic handshake locations in the Mosh app-data dir (matches
    // MoshEngine's session base) so a FRESH launch can find a PRIOR run's service.
    File serviceStateDir()  { return File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Mosh"); }
    File servicePidFile()   { return serviceStateDir().getChildFile ("service.pid"); }
    File servicePortFile()  { return serviceStateDir().getChildFile ("service.port"); }

    void setEnvVar (const char* k, const String& v)
    {
       #if JUCE_WINDOWS
        _putenv_s (k, v.toRawUTF8());
       #else
        ::setenv (k, v.toRawUTF8(), 1);
       #endif
    }

    // Is `pid` a live process whose command line looks like OUR python service? (Guards
    // against killing an unrelated process that happens to have reused the recorded PID.)
    bool isLiveMoshService (int pid)
    {
        if (pid <= 0) return false;
        ChildProcess ps;
       #if JUCE_WINDOWS
        if (ps.start ("tasklist /FI \"PID eq " + String (pid) + "\" /FO csv /NH"))
            return ps.readAllProcessOutput().containsIgnoreCase ("python");
       #else
        if (ps.start (StringArray { "/bin/ps", "-p", String (pid), "-o", "command=" }))
            return ps.readAllProcessOutput().contains ("server.py");
       #endif
        return false;
    }

    void killPid (int pid)
    {
        ChildProcess k;
       #if JUCE_WINDOWS
        k.start ("taskkill /F /PID " + String (pid));
       #else
        k.start (StringArray { "/bin/kill", "-9", String (pid) });
       #endif
    }

    File locateServiceScript()
    {
        if (auto env = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_SCRIPT", {}); env.isNotEmpty())
            if (File f (env); f.existsAsFile()) return f;

        // dev: relative to the current working directory (harness runs from repo).
        auto cwd = File::getCurrentWorkingDirectory().getChildFile ("service/server.py");
        if (cwd.existsAsFile()) return cwd;

        // bundled: Mosh.app/Contents/Resources/service/server.py
        auto app = File::getSpecialLocation (File::currentApplicationFile);
        auto bundled = app.getChildFile ("Contents/Resources/service/server.py");
        if (bundled.existsAsFile()) return bundled;

        // flat layout (Windows): service/ staged next to the executable.
        auto beside = File::getSpecialLocation (File::currentExecutableFile)
                          .getParentDirectory().getChildFile ("service/server.py");
        if (beside.existsAsFile()) return beside;
        return {};
    }
}

GenerativeJobManager::GenerativeJobManager()
{
    const auto host = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_HOST", "127.0.0.1");
    const auto port = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_PORT", "8770");
    baseUrl = "http://" + host + ":" + port;
}

GenerativeJobManager::~GenerativeJobManager()
{
    if (spawnedByUs && serviceProcess.isRunning())
        serviceProcess.kill();        // cancel-on-close (05 §4)
    if (spawnedByUs)                  // C2 — clean shutdown clears the handshake files
    {
        servicePidFile().deleteFile();
        servicePortFile().deleteFile();
    }
}

void GenerativeJobManager::reapStaleService()
{
    auto pf = servicePidFile();
    if (! pf.existsAsFile()) return;

    // pidfile holds "<pid> <boundPort>". Only reap a stale service that squats OUR target
    // port — so a second instance on a different port never kills a healthy one.
    auto toks = StringArray::fromTokens (pf.loadFileAsString().trim(), " ", {});
    const int pid = toks.size() > 0 ? toks[0].getIntValue() : 0;
    const int stalePort = toks.size() > 1 ? toks[1].getIntValue() : 0;
    const int targetPort = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_PORT", "8770").getIntValue();

    if (pid > 0
        && (stalePort == 0 || stalePort == targetPort)
        && isLiveMoshService (pid))
    {
        killPid (pid);
        Thread::sleep (300);          // let the OS release the squatted port
    }
    pf.deleteFile();
    servicePortFile().deleteFile();
}

void GenerativeJobManager::adoptPortFromHandshake()
{
    auto pf = servicePortFile();
    if (! pf.existsAsFile()) return;
    const int p = pf.loadFileAsString().trim().getIntValue();
    if (p <= 0) return;
    const auto host = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_HOST", "127.0.0.1");
    auto want = "http://" + host + ":" + String (p);
    if (want != baseUrl) baseUrl = want;
}

juce::var GenerativeJobManager::httpGet (const juce::String& path, int connectMs)
{
    URL url (baseUrl + path);
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (connectMs);
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::httpPost (const juce::String& path, const juce::var& body)
{
    URL url = URL (baseUrl + path).withPOSTData (JSON::toString (body));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (10000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

bool GenerativeJobManager::isHealthy (int connectMs)
{
    auto r = httpGet ("/health", connectMs);
    if ((bool) r.getProperty ("ok", false))
    {
        svcBuild = r.getProperty ("build", svcBuild).toString();
        return true;
    }
    return false;
}

bool GenerativeJobManager::ensureServiceRunning()
{
    if (isHealthy()) return true;

    // C2 — health failed: a wedged/orphaned service from a crashed Mosh may be squatting the
    // port. Reap it (PID handshake + identity check) before spawning a fresh one.
    reapStaleService();
    if (isHealthy()) return true;     // (another instance may have raced in)

    auto script = locateServiceScript();
    if (! script.existsAsFile()) return false;

    // Hand the child the handshake paths: it records its PID (C2, so a future launch can reap
    // it) and the actual bound port (C3). Set in our env so the child inherits them on both
    // platforms. Clear any stale portfile so we don't adopt a dead port.
    serviceStateDir().createDirectory();
    servicePortFile().deleteFile();
    setEnvVar ("MOSH_SERVICE_PIDFILE", servicePidFile().getFullPathName());
    setEnvVar ("MOSH_SERVICE_PORTFILE", servicePortFile().getFullPathName());

    bool started = false;
#if JUCE_WINDOWS
    if (auto py = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_PYTHON", {}); py.isNotEmpty())
        started = serviceProcess.start (StringArray { py, script.getFullPathName() });
    else
    {
        started = serviceProcess.start (StringArray { "py", "-3", script.getFullPathName() });
        if (! started)
            started = serviceProcess.start (StringArray { "python", script.getFullPathName() });
    }
#else
    // Launch via run.sh (it selects the MLX venv python when MOSH_ENABLE_SA3=1),
    // forwarding the SA3 env so the carved engine can find the model + colours
    // (App. B). Falls back to system python3 (FakeAdapter) when SA3 is off.
    auto runSh = script.getParentDirectory().getChildFile ("run.sh");
    String env;
    for (auto* key : { "MOSH_ENABLE_SA3", "SA3_MLX_DIR", "COLORRACK_DATA", "SA3_SECONDS",
                       "SA3_STEPS", "MOSH_SA3_QA", "MOSH_JUDGES_PY", "MOSH_QA_TIMEOUT",
                       "MOSH_SERVICE_HOST", "MOSH_SERVICE_PORT" })
        if (auto v = SystemStats::getEnvironmentVariable (key, {}); v.isNotEmpty())
            env << key << "=" << v.quoted() << " ";

    String shell = runSh.existsAsFile()
        ? (env + "exec /bin/bash " + runSh.getFullPathName().quoted())
        : (env + "exec python3 " + script.getFullPathName().quoted());
    started = serviceProcess.start (StringArray { "/bin/sh", "-c", shell });
#endif
    if (started)
    {
        spawnedByUs = true;
        for (int i = 0; i < 60; ++i)     // up to ~12s for warmup
        {
            Thread::sleep (200);
            adoptPortFromHandshake();     // C3 — switch to the actual bound port if it differs
            if (isHealthy()) return true;
        }
    }
    return isHealthy();
}

juce::var GenerativeJobManager::listColors()
{
    return httpGet ("/colors");
}

juce::var GenerativeJobManager::listTransformTargets()
{
    return httpGet ("/transform_targets");
}

juce::String GenerativeJobManager::submitJob (const juce::String& adapter,
                                              const juce::File& inputWav, const juce::File& outputWav,
                                              const juce::File& manifest, const juce::var& params)
{
    auto* body = new DynamicObject();
    body->setProperty ("adapter", adapter.isNotEmpty() ? adapter : juce::String ("fake"));
    body->setProperty ("inputWav", inputWav.getFullPathName());
    body->setProperty ("outputWav", outputWav.getFullPathName());
    body->setProperty ("manifest", manifest.getFullPathName());
    body->setProperty ("params", params);
    auto r = httpPost ("/submit", var (body));
    return r.getProperty ("jobId", var()).toString();
}

juce::var GenerativeJobManager::jobStatus (const juce::String& jobId)
{
    return httpGet ("/status?jobId=" + jobId);
}

void GenerativeJobManager::cancelJob (const juce::String& jobId)
{
    auto* body = new DynamicObject();
    body->setProperty ("jobId", jobId);
    httpPost ("/cancel", var (body));
}

juce::var GenerativeJobManager::transcribe (const juce::File& inputWav, const juce::String& mode)
{
    if (! ensureServiceRunning())
        return {};

    auto* body = new DynamicObject();
    body->setProperty ("inputWav", inputWav.getFullPathName());
    body->setProperty ("mode", mode.isNotEmpty() ? mode : juce::String ("mono"));

    // Transcription runs a model-loading subprocess; give it a generous timeout
    // (the service caps the subprocess at 180s). This blocks, so the caller runs it
    // off the message thread.
    URL url = URL (baseUrl + "/transcribe").withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (185000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::transcribeWords (const juce::File& inputWav)
{
    if (! ensureServiceRunning())
        return {};

    auto* body = new DynamicObject();
    body->setProperty ("inputWav", inputWav.getFullPathName());

    // Whisper loads a model in a subprocess (generous timeout; the service caps at 180s).
    // Blocks → off the message thread. Mirrors transcribe(). Empty words when Whisper absent.
    URL url = URL (baseUrl + "/transcribe_words").withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (185000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::mumbleSpec (const juce::var& notes, const juce::var& words,
                                            double bpm, int tsNum, int tsDen, double confThreshold)
{
    if (! ensureServiceRunning())
        return {};

    Array<var> ts; ts.add (tsNum > 0 ? tsNum : 4); ts.add (tsDen > 0 ? tsDen : 4);
    auto* body = new DynamicObject();
    body->setProperty ("notes", notes);
    body->setProperty ("words", words);
    body->setProperty ("bpm", bpm > 0 ? bpm : 120.0);
    body->setProperty ("timeSig", var (ts));
    body->setProperty ("confThreshold", confThreshold > 0 ? confThreshold : 0.6);

    // In-process deterministic note/word math — fast; a short timeout. Off the message thread.
    URL url = URL (baseUrl + "/mumble_spec").withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (30000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::skeletonSpec (const juce::File& inputWav, double bpm,
                                              int tsNum, int tsDen, const juce::String& grid)
{
    if (! ensureServiceRunning())
        return {};

    Array<var> ts; ts.add (tsNum > 0 ? tsNum : 4); ts.add (tsDen > 0 ? tsDen : 4);
    auto* body = new DynamicObject();
    body->setProperty ("inputWav", inputWav.getFullPathName());
    body->setProperty ("bpm", bpm > 0 ? bpm : 120.0);
    body->setProperty ("timeSig", var (ts));
    body->setProperty ("grid", grid.isNotEmpty() ? grid : juce::String ("1/16"));

    // The server orchestrates the whole chain (Basic-Pitch notes + optional FCPE F0, then the
    // in-process bin) — the Basic-Pitch subprocess dominates, so give it transcribe's generous
    // timeout. Blocks → the caller runs it off the message thread. Mirrors transcribe().
    URL url = URL (baseUrl + "/skeleton_spec").withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (185000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::sketchBeatbox (const juce::File& inputWav, double bpm, int bars)
{
    if (! ensureServiceRunning())
        return {};

    auto* body = new DynamicObject();
    body->setProperty ("inputWav", inputWav.getFullPathName());
    body->setProperty ("bpm", bpm);
    body->setProperty ("bars", bars);

    // Onset analysis runs in a subprocess under the dedicated sketch venv; it is
    // model-free but still spawns a process, so give it a generous timeout and run it
    // off the message thread. Mirrors transcribe().
    URL url = URL (baseUrl + "/sketch").withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (60000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::getRhymes (const juce::String& word, const juce::String& strictness,
                                           int maxN, int syllables)
{
    if (! ensureServiceRunning())
        return {};

    auto* body = new DynamicObject();
    body->setProperty ("word", word);
    body->setProperty ("strictness", strictness.isNotEmpty() ? strictness : juce::String ("slant"));
    body->setProperty ("maxN", maxN > 0 ? maxN : 50);
    if (syllables > 0)
        body->setProperty ("syllables", syllables);

    // Fast + deterministic; the service caps the (optional) phonology subprocess at
    // 60s. A short timeout keeps an on-demand lookup snappy. Blocks → off the message
    // thread (or accept a brief block for an explicit lookup). Mirrors transcribe().
    URL url = URL (baseUrl + "/get_rhymes").withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (15000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::generateLyrics (const juce::String& mode, const juce::var& spec,
                                                int lineIndex, int afterIndex, const juce::var& regen)
{
    if (! ensureServiceRunning())
        return {};

    const juce::String path = mode == "fill" ? "/fill_lyric_gap"
                            : mode == "next" ? "/suggest_next_line"
                                             : "/complete_lyrics";
    auto* body = new DynamicObject();
    body->setProperty ("spec", spec);
    if (mode == "fill") body->setProperty ("lineIndex", lineIndex);
    if (mode == "next") body->setProperty ("afterIndex", afterIndex);
    if (regen.isObject()) body->setProperty ("regen", regen);

    // Fake backend is fast; a real LLM (L3) takes seconds — generous timeout, and the
    // caller runs this off the message thread (mirrors transcribe()).
    URL url = URL (baseUrl + path).withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (120000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

juce::var GenerativeJobManager::analyzeLyrics (const juce::var& spec)
{
    if (! ensureServiceRunning())
        return {};

    auto* body = new DynamicObject();
    body->setProperty ("spec", spec);

    // Fast + deterministic (phonology only, no LLM) — a short timeout keeps the precise
    // flow-meter snappy. Off the message thread (mirrors transcribe()).
    URL url = URL (baseUrl + "/analyze_lyrics").withPOSTData (JSON::toString (var (body)));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (15000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

int GenerativeJobManager::styleCorpusAdd (const juce::StringArray& lines, const juce::String& source)
{
    // NON-SPAWNING contract: only POST if the service is ALREADY up. isHealthy() pings
    // /health and never spawns (only ensureServiceRunning does) — so when the service is
    // down (e.g. during --selftest) this is a pure no-op. Do NOT route this through
    // ensureServiceRunning or any spawn path.
    if (lines.isEmpty() || ! isHealthy())
        return -1;

    Array<var> arr;
    for (auto& l : lines)
        if (l.trim().isNotEmpty())
            arr.add (l);
    if (arr.isEmpty())
        return -1;

    auto* body = new DynamicObject();
    body->setProperty ("action", "add");
    body->setProperty ("lines", arr);
    body->setProperty ("source", source.isNotEmpty() ? source : juce::String ("accept"));

    auto r = httpPost ("/style_corpus", var (body));   // 10s timeout; already healthy
    if (! (bool) r.getProperty ("ok", false))
        return -1;
    return (int) r.getProperty ("lines", -1);          // post-add corpus total
}

int GenerativeJobManager::styleCorpusStats()
{
    // Quick health probe: this runs on the message thread (the corpus readout pulls on panel
    // mount), so cap the worst-case block at ~0.8s if the service is wedged. NON-SPAWNING.
    if (! isHealthy (800))                             // (counts only)
        return -1;
    auto* body = new DynamicObject();
    body->setProperty ("action", "stats");
    auto r = httpPost ("/style_corpus", var (body));
    return (bool) r.getProperty ("ok", false) ? (int) r.getProperty ("lines", -1) : -1;
}

} // namespace mosh
