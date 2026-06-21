#include "GenerativeJobManager.h"

namespace mosh
{
using namespace juce;

namespace
{
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
}

juce::var GenerativeJobManager::httpGet (const juce::String& path)
{
    URL url (baseUrl + path);
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (3000);
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

bool GenerativeJobManager::isHealthy()
{
    auto r = httpGet ("/health");
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

    auto script = locateServiceScript();
    if (! script.existsAsFile()) return false;

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
            if (isHealthy()) return true;
        }
    }
    return isHealthy();
}

juce::var GenerativeJobManager::listColors()
{
    return httpGet ("/colors");
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

} // namespace mosh
