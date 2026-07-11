#include "TrainingJobManager.h"

namespace mosh
{
using namespace juce;

namespace
{
    constexpr int serviceDiscardedOutputStreams = 0;
}

TrainingJobManager::TrainingJobManager()
{
    const auto host = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_HOST", "127.0.0.1");
    const auto port = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_PORT", "8770");
    baseUrl = "http://" + host + ":" + port;
}

TrainingJobManager::~TrainingJobManager()
{
    if (spawnedByUs && serviceProcess.isRunning())
        serviceProcess.kill();
}

File TrainingJobManager::locateServiceScript() const
{
    if (auto env = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_SCRIPT", {}); env.isNotEmpty())
        if (File f (env); f.existsAsFile()) return f;

    auto cwd = File::getCurrentWorkingDirectory().getChildFile ("service/server.py");
    if (cwd.existsAsFile()) return cwd;

    auto app = File::getSpecialLocation (File::currentApplicationFile);
    auto bundled = app.getChildFile ("Contents/Resources/service/server.py");
    if (bundled.existsAsFile()) return bundled;

    // flat layout (Windows): service/ staged next to the executable.
    auto beside = File::getSpecialLocation (File::currentExecutableFile)
                      .getParentDirectory().getChildFile ("service/server.py");
    if (beside.existsAsFile()) return beside;
    return {};
}

var TrainingJobManager::httpGet (const String& path)
{
    URL url (baseUrl + path);
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (3000);
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

var TrainingJobManager::httpPost (const String& path, const var& body)
{
    URL url = URL (baseUrl + path).withPOSTData (JSON::toString (body));
    auto opts = URL::InputStreamOptions (URL::ParameterHandling::inPostData)
                    .withConnectionTimeoutMs (10000)
                    .withExtraHeaders ("Content-Type: application/json");
    if (auto s = url.createInputStream (opts))
        return JSON::parse (s->readEntireStreamAsString());
    return {};
}

bool TrainingJobManager::isHealthy()
{
    auto r = httpGet ("/training/health");
    return (bool) r.getProperty ("ok", false);
}

bool TrainingJobManager::ensureServiceRunning()
{
    if (isHealthy()) return true;

    auto script = locateServiceScript();
    if (! script.existsAsFile())
        return false;

    bool started = false;
#if JUCE_WINDOWS
    if (auto py = SystemStats::getEnvironmentVariable ("MOSH_SERVICE_PYTHON", {}); py.isNotEmpty())
        started = serviceProcess.start (StringArray { py, script.getFullPathName() }, serviceDiscardedOutputStreams);
    else
    {
        started = serviceProcess.start (StringArray { "py", "-3", script.getFullPathName() }, serviceDiscardedOutputStreams);
        if (! started)
            started = serviceProcess.start (StringArray { "python", script.getFullPathName() }, serviceDiscardedOutputStreams);
    }
#else
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
    started = serviceProcess.start (StringArray { "/bin/sh", "-c", shell }, serviceDiscardedOutputStreams);
#endif
    if (started)
    {
        spawnedByUs = true;
        for (int i = 0; i < 60; ++i)
        {
            Thread::sleep (200);
            if (isHealthy()) return true;
        }
    }
    return isHealthy();
}

String TrainingJobManager::submitJob (const String& corpusBundle, const var& config, const String& outputDir)
{
    auto* body = new DynamicObject();
    body->setProperty ("corpusBundle", corpusBundle);
    if (outputDir.isNotEmpty())
        body->setProperty ("outputDir", outputDir);
    body->setProperty ("config", config);
    auto r = httpPost ("/training/submit", var (body));
    return r.getProperty ("jobId", var()).toString();
}

var TrainingJobManager::jobStatus (const String& jobId)
{
    return httpGet ("/training/status?jobId=" + jobId);
}

void TrainingJobManager::cancelJob (const String& jobId)
{
    auto* body = new DynamicObject();
    body->setProperty ("jobId", jobId);
    httpPost ("/training/cancel", var (body));
}

} // namespace mosh
