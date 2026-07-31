#include "AgentHostProxy.h"

namespace mosh
{
namespace
{
    constexpr int kStartupTimeoutMs = 10000;
    constexpr int kRequestTimeoutMs = 12000;

    juce::var error (const juce::String& message = "agent host unavailable")
    {
        auto* value = new juce::DynamicObject();
        value->setProperty ("ok", false);
        value->setProperty ("error", message);
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

    auto dev = juce::File::getCurrentWorkingDirectory().getChildFile ("service/agent-host/src/main.ts");
    if (dev.existsAsFile()) return dev;
    auto bundled = appResource ("agent-host/src/main.ts");
    if (bundled.existsAsFile()) return bundled;
    return {};
}

void AgentHostProxy::stop()
{
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
}

bool AgentHostProxy::ensureStarted()
{
    if (origin.isNotEmpty() && capability.isNotEmpty() && playtestId.isNotEmpty() && process.isRunning())
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

    int statusCode = 0;
    const auto playtest = post ("/v1/playtests", juce::JSON::parse ("{\"retainTranscript\":false}"), statusCode);
    playtestId = playtest.getProperty ("id", juce::var()).toString();
    if (statusCode != 201 || playtestId.isEmpty())
    {
        stop();
        return false;
    }
    return true;
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

juce::var AgentHostProxy::supervisorTurn (const juce::var& request)
{
    const juce::ScopedLock guard (lock);
    if (! request.isObject() || ! ensureStarted()) return error();

    // Round-trip through JSON before appending the private playtest id so this
    // never mutates the WebView's request object.
    auto body = juce::JSON::parse (juce::JSON::toString (request));
    if (auto* object = body.getDynamicObject()) object->setProperty ("playtestId", playtestId);
    else return error();

    int statusCode = 0;
    const auto plan = post ("/v1/supervisor/turns", body, statusCode);
    if (statusCode < 200 || statusCode >= 300 || ! plan.isObject()) return error();
    auto* result = new juce::DynamicObject();
    result->setProperty ("ok", true);
    result->setProperty ("plan", plan);
    return juce::var (result);
}
} // namespace mosh
