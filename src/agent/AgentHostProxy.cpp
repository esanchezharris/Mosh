#include "AgentHostProxy.h"

namespace mosh
{
namespace
{
    constexpr int kStartupTimeoutMs = 10000;
    constexpr int kRequestTimeoutMs = 12000;

    juce::var error (const juce::String& message = "agent host unavailable",
                     const juce::String& code = {},
                     bool retryable = true)
    {
        auto* value = new juce::DynamicObject();
        value->setProperty ("ok", false);
        value->setProperty ("error", message);
        if (code.isNotEmpty()) value->setProperty ("code", code);
        value->setProperty ("retryable", retryable);
        return juce::var (value);
    }

    juce::File appResource (const juce::String& relative)
    {
        return juce::File::getSpecialLocation (juce::File::currentApplicationFile)
            .getChildFile ("Contents/Resources")
            .getChildFile (relative);
    }
}

AgentHostProxy::~AgentHostProxy()
{
    const juce::ScopedLock guard (lock);
    stop();
}

std::optional<AgentHostProxy::StartupEnvelope> AgentHostProxy::parseStartupEnvelope (const juce::String& line)
{
    const auto value = juce::JSON::parse (line);
    if (! value.isObject()
        || value.getProperty ("type", juce::var()).toString() != "mosh.agent-host.ready"
        || (int) value.getProperty ("version", 0) != 1)
        return std::nullopt;

    StartupEnvelope envelope {
        value.getProperty ("host", juce::var()).toString(),
        (int) value.getProperty ("port", 0),
        value.getProperty ("capability", juce::var()).toString(),
    };
    if (envelope.host != "127.0.0.1" || envelope.port <= 0 || envelope.port > 65535
        || envelope.capability.isEmpty())
        return std::nullopt;
    return envelope;
}

juce::File AgentHostProxy::locateEntry() const
{
    if (const auto configured = juce::SystemStats::getEnvironmentVariable ("MOSH_AGENT_HOST_ENTRY", {});
        configured.isNotEmpty())
    {
        juce::File entry (configured);
        if (entry.existsAsFile()) return entry;
    }

    // Deployed apps use the deterministic bundle first. The development checkout
    // fallback stays useful for a source-tree executable but cannot mask a missing
    // packaged runtime in a built app.
    auto bundled = appResource ("agent-host/agent-host.mjs");
    if (bundled.existsAsFile()) return bundled;

    auto dev = juce::File::getCurrentWorkingDirectory().getChildFile ("service/agent-host/src/main.ts");
    if (dev.existsAsFile()) return dev;
    return {};
}

void AgentHostProxy::stop()
{
    if (process.isRunning() && origin.isNotEmpty() && capability.isNotEmpty() && playtestId.isNotEmpty())
    {
        auto* request = new juce::DynamicObject();
        request->setProperty ("retainTranscript", retainTranscript);
        int ignoredStatus = 0;
        post ("/v1/playtests/" + playtestId + "/close", juce::var (request), ignoredStatus);
    }
    if (process.isRunning())
    {
        process.kill();
        // ChildProcess::kill() signals only; wait briefly so its direct Node child
        // is reaped before this proxy can be destroyed or restarted.
        process.waitForProcessToFinish (1000);
    }
    origin.clear();
    capability.clear();
    playtestId.clear();
    retainTranscript = false;
    disclosureDelivered = false;
}

bool AgentHostProxy::ensureStarted()
{
    if (origin.isNotEmpty() && capability.isNotEmpty() && process.isRunning())
        return true;

    stop();
    const auto entry = locateEntry();
    if (! entry.existsAsFile()) return false;

    juce::StringArray command;
    // `/usr/bin/env PORT=0 …` supplies no secret through argv. The Agent Host
    // generates its capability and prints one startup envelope that is consumed
    // below into this native object's memory only.
    command.addArray ({ "/usr/bin/env", "PORT=0", "node" });
    if (entry.hasFileExtension (".ts"))
    {
        const auto hostRoot = entry.getParentDirectory().getParentDirectory(); // src/main.ts -> agent-host
        const auto tsxDist = hostRoot.getChildFile ("node_modules/tsx/dist");
        const auto preflight = tsxDist.getChildFile ("preflight.cjs");
        const auto loader = tsxDist.getChildFile ("loader.mjs");
        if (! preflight.existsAsFile() || ! loader.existsAsFile()) return false;
        // Do not invoke node_modules/.bin/tsx: it forks the real Node host, which
        // would escape ChildProcess::kill() on app shutdown. Loading tsx directly
        // makes this tracked child the HTTP server and gives stop() full ownership.
        command.addArray ({ "--require", preflight.getFullPathName(), "--import",
                            "file://" + loader.getFullPathName() });
    }
    command.add (entry.getFullPathName());
    if (! process.start (command, juce::ChildProcess::wantStdOut)) return false;

    juce::String line;
    const auto deadline = juce::Time::getMillisecondCounter() + kStartupTimeoutMs;
    while (process.isRunning() && juce::Time::getMillisecondCounter() < deadline)
    {
        char character = 0;
        const auto read = process.readProcessOutput (&character, 1);
        // A process can be alive before its stdout pipe has a complete line. Do
        // not mistake that transient zero-byte read for startup failure: tolerate
        // it until the deadline (or a real child exit) so slow Node/tsx startup is
        // still bounded by kStartupTimeoutMs.
        if (read <= 0)
        {
            if (! process.isRunning()) break;
            juce::Thread::sleep (10);
            continue;
        }
        if (character != '\n')
        {
            if (line.length() < 4096) line += juce::String::charToString (character);
            continue;
        }
        if (const auto envelope = parseStartupEnvelope (line))
        {
            origin = "http://127.0.0.1:" + juce::String (envelope->port);
            capability = envelope->capability;
            break;
        }
        line.clear();
    }
    if (origin.isEmpty() || capability.isEmpty())
    {
        stop();
        return false;
    }

    return true;
}

bool AgentHostProxy::ensurePlaytest()
{
    const auto requestedRetention = retainTranscript;
    if (! ensureStarted()) return false;
    retainTranscript = requestedRetention;
    if (playtestId.isNotEmpty()) return true;
    int statusCode = 0;
    auto* request = new juce::DynamicObject();
    request->setProperty ("retainTranscript", retainTranscript);
    const auto playtest = post ("/v1/playtests", juce::var (request), statusCode);
    playtestId = playtest.getProperty ("id", juce::var()).toString();
    disclosureDelivered = false;
    return statusCode == 201 && playtestId.isNotEmpty();
}

juce::var AgentHostProxy::post (const juce::String& path, const juce::var& body, int& statusCode) const
{
    juce::StringArray headers;
    headers.add ("Content-Type: application/json");
    headers.add ("Authorization: Bearer " + capability);
    const auto url = juce::URL (origin + path).withPOSTData (juce::JSON::toString (body));
    const auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
        .withConnectionTimeoutMs (kRequestTimeoutMs)
        .withExtraHeaders (headers.joinIntoString ("\r\n"))
        .withStatusCode (&statusCode);
    const auto stream = url.createInputStream (options);
    if (stream == nullptr) return {};
    return juce::JSON::parse (stream->readEntireStreamAsString());
}

juce::String AgentHostProxy::getEventStream (const juce::String& path, int& statusCode) const
{
    juce::StringArray headers;
    headers.add ("Authorization: Bearer " + capability);
    const auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
        .withConnectionTimeoutMs (kRequestTimeoutMs)
        .withExtraHeaders (headers.joinIntoString ("\r\n"))
        .withStatusCode (&statusCode);
    const auto stream = juce::URL (origin + path).createInputStream (options);
    if (stream == nullptr) return {};
    return stream->readEntireStreamAsString();
}

juce::var AgentHostProxy::sessionResult (bool disclosureRequired) const
{
    auto* result = new juce::DynamicObject();
    result->setProperty ("ok", true);
    result->setProperty ("active", playtestId.isNotEmpty());
    result->setProperty ("retainTranscript", retainTranscript);
    result->setProperty ("disclosureRequired", disclosureRequired);
    return juce::var (result);
}

juce::var AgentHostProxy::startPlaytest (bool shouldRetain)
{
    const juce::ScopedLock guard (lock);
    retainTranscript = shouldRetain;
    if (! ensurePlaytest()) return error();
    const auto disclosure = ! disclosureDelivered;
    disclosureDelivered = true;
    return sessionResult (disclosure);
}

juce::var AgentHostProxy::closePlaytest (bool shouldRetain)
{
    const juce::ScopedLock guard (lock);
    retainTranscript = shouldRetain;
    if (playtestId.isEmpty()) return sessionResult (false);
    if (! ensureStarted()) return error();
    auto* request = new juce::DynamicObject();
    request->setProperty ("retainTranscript", shouldRetain);
    int statusCode = 0;
    const auto result = post ("/v1/playtests/" + playtestId + "/close", juce::var (request), statusCode);
    if (statusCode < 200 || statusCode >= 300 || ! result.isObject()) return error();
    playtestId.clear();
    disclosureDelivered = false;
    return sessionResult (false);
}

juce::var AgentHostProxy::realtimeSecret()
{
    const juce::ScopedLock guard (lock);
    if (! ensurePlaytest()) return error();
    int statusCode = 0;
    const auto result = post ("/v1/realtime/client-secret", juce::var (new juce::DynamicObject()), statusCode);
    if (statusCode < 200 || statusCode >= 300 || ! result.isObject())
        return error ("OpenAI Realtime unavailable",
                      result.getProperty ("error", juce::var()).getProperty ("code", juce::var()).toString());
    auto* response = new juce::DynamicObject();
    response->setProperty ("ok", true);
    response->setProperty ("value", result.getProperty ("value", juce::var()));
    response->setProperty ("expiresAt", result.getProperty ("expires_at", juce::var()));
    return juce::var (response);
}

bool AgentHostProxy::hasActivePlaytest() const
{
    const juce::ScopedLock guard (lock);
    return playtestId.isNotEmpty()
        && origin.isNotEmpty()
        && capability.isNotEmpty()
        && process.isRunning();
}

juce::var AgentHostProxy::createReport (const juce::var& request)
{
    const juce::ScopedLock guard (lock);
    if (! request.isObject()) return error ("invalid report request", "invalid_response", false);
    if (playtestId.isEmpty()) return error ("playtest not started", "playtest_not_started", false);
    if (origin.isEmpty() || capability.isEmpty() || ! process.isRunning()) return error();
    auto body = juce::JSON::parse (juce::JSON::toString (request));
    body.getDynamicObject()->setProperty ("playtestId", playtestId);
    int statusCode = 0;
    const auto report = post ("/v1/reports", body, statusCode);
    if (statusCode != 201 || ! report.isObject()) return error ("report persistence failed");
    auto* result = new juce::DynamicObject();
    result->setProperty ("ok", true);
    result->setProperty ("id", report.getProperty ("id", juce::var()));
    result->setProperty ("kind", report.getProperty ("kind", juce::var()));
    result->setProperty ("title", report.getProperty ("title", juce::var()));
    result->setProperty ("body", report.getProperty ("body", juce::var()));
    result->setProperty ("status", report.getProperty ("status", juce::var()));
    return juce::var (result);
}

juce::var AgentHostProxy::approveReport (const juce::String& reportId)
{
    const juce::ScopedLock guard (lock);
    if (reportId.isEmpty() || ! ensureStarted()) return error();
    int statusCode = 0;
    const auto report = post ("/v1/reports/" + reportId + "/approve",
                              juce::var (new juce::DynamicObject()), statusCode);
    if (statusCode < 200 || statusCode >= 300 || ! report.isObject())
        return error ("report approval failed");
    auto* result = new juce::DynamicObject();
    result->setProperty ("ok", true);
    result->setProperty ("id", report.getProperty ("id", juce::var()));
    result->setProperty ("status", report.getProperty ("status", juce::var()));
    return juce::var (result);
}

juce::var AgentHostProxy::createRepair (const juce::String& reportId)
{
    const juce::ScopedLock guard (lock);
    if (reportId.isEmpty() || ! ensureStarted()) return error();
    int statusCode = 0;
    const auto repair = post ("/v1/reports/" + reportId + "/repairs",
                              juce::var (new juce::DynamicObject()), statusCode);
    if (statusCode < 200 || statusCode >= 300 || ! repair.isObject())
    {
        const auto hostError = repair.getProperty ("error", juce::var());
        return error (hostError.getProperty ("message", "repair start failed").toString(),
                      hostError.getProperty ("code", juce::var()).toString(),
                      statusCode >= 500);
    }
    auto* result = new juce::DynamicObject();
    result->setProperty ("ok", true);
    result->setProperty ("id", repair.getProperty ("id", juce::var()));
    result->setProperty ("status", repair.getProperty ("status", juce::var()));
    return juce::var (result);
}

juce::var AgentHostProxy::events (int afterSequence)
{
    const juce::ScopedLock guard (lock);
    if (! ensurePlaytest()) return error();
    int statusCode = 0;
    const auto stream = getEventStream ("/v1/playtests/" + playtestId
        + "/events?afterSequence=" + juce::String (juce::jmax (0, afterSequence))
        + "&windowMs=150", statusCode);
    if (statusCode < 200 || statusCode >= 300)
        return error ("event delivery unavailable");
    juce::Array<juce::var> events;
    for (const auto& line : juce::StringArray::fromLines (stream))
    {
        if (! line.startsWith ("data:")) continue;
        const auto event = juce::JSON::parse (line.substring (5).trim());
        if (event.isObject()
            && (int) event.getProperty ("sequence", 0) > afterSequence
            && events.size() < 100)
            events.add (event);
    }
    auto* response = new juce::DynamicObject();
    response->setProperty ("ok", true);
    response->setProperty ("events", juce::var (events));
    return juce::var (response);
}

juce::var AgentHostProxy::supervisorTurn (const juce::var& request)
{
    const juce::ScopedLock guard (lock);
    if (! request.isObject() || ! ensurePlaytest()) return error();

    // Round-trip through JSON before appending the private playtest id so this
    // never mutates the WebView's request object.
    auto body = juce::JSON::parse (juce::JSON::toString (request));
    if (auto* object = body.getDynamicObject()) object->setProperty ("playtestId", playtestId);
    else return error();

    int statusCode = 0;
    const auto plan = post ("/v1/supervisor/turns", body, statusCode);
    if (statusCode < 200 || statusCode >= 300 || ! plan.isObject())
    {
        const auto hostError = plan.getProperty ("error", juce::var());
        const auto code = hostError.getProperty ("code", juce::var()).toString();
        return error ("agent host unavailable", code);
    }
    auto* result = new juce::DynamicObject();
    result->setProperty ("ok", true);
    result->setProperty ("plan", plan);
    return juce::var (result);
}
} // namespace mosh
