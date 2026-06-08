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

    StringArray cmd { "python3", script.getFullPathName() };
    if (serviceProcess.start (cmd))
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

juce::var GenerativeJobManager::capabilities()
{
    return httpGet ("/capabilities");
}

juce::String GenerativeJobManager::submitJob (const juce::File& inputWav, const juce::File& outputWav,
                                              const juce::File& manifest, const juce::var& params)
{
    auto* body = new DynamicObject();
    body->setProperty ("adapter", "fake");
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

} // namespace mosh
