#include "Telemetry.h"
#include "TelemetryConfig.h"
#include <map>
#include <mutex>
#include <thread>
#include <chrono>

namespace mosh::telemetry
{

namespace
{
    std::mutex stateMutex_;
    bool started_ = false;
    juce::String installId_;
    int launches_ = 0;
    juce::int64 sessionStartMs_ = 0;
    juce::int64 priorTotalSessionSeconds_ = 0;
    std::map<juce::String, int> commandCounts_; // GUARDED BY stateMutex_

    constexpr int kFlushIntervalSeconds = 60; // production-only background cadence

    // Caller must hold stateMutex_.
    juce::var loadPersistedStateLocked()
    {
        auto f = TelemetryConfig::telemetryStateDir().getChildFile ("state.json");
        if (! f.existsAsFile())
            return {};
        return juce::JSON::parse (f.loadFileAsString());
    }

    // Caller must hold stateMutex_.
    void persistStateLocked()
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty ("installId", installId_);
        obj->setProperty ("launches", launches_);
        const juce::int64 elapsedSeconds =
            sessionStartMs_ > 0 ? (juce::Time::currentTimeMillis() - sessionStartMs_) / 1000 : (juce::int64) 0;
        obj->setProperty ("totalSessionSeconds", (int) (priorTotalSessionSeconds_ + elapsedSeconds));

        auto* counts = new juce::DynamicObject();
        for (auto& kv : commandCounts_)
            counts->setProperty (kv.first, kv.second);
        obj->setProperty ("commandCounts", juce::var (counts));

        TelemetryConfig::telemetryStateDir().getChildFile ("state.json")
            .replaceWithText (juce::JSON::toString (juce::var (obj)));
    }

    // Caller must hold stateMutex_. Builds the same payload shape persistStateLocked
    // writes locally, for the (opt-in-gated, endpoint-gated) upload path.
    juce::String uploadPayloadLocked()
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty ("installId", installId_);
        obj->setProperty ("launches", launches_);
        auto* counts = new juce::DynamicObject();
        for (auto& kv : commandCounts_)
            counts->setProperty (kv.first, kv.second);
        obj->setProperty ("commandCounts", juce::var (counts));
        return juce::JSON::toString (juce::var (obj));
    }
}

bool Telemetry::defaultUploader (const juce::String& url, const juce::String& jsonBody)
{
    juce::URL u = juce::URL (url).withPOSTData (jsonBody);
    int statusCode = 0;
    auto stream = u.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
            .withConnectionTimeoutMs (5000)
            .withExtraHeaders ("Content-Type: application/json")
            .withStatusCode (&statusCode));
    return stream != nullptr && statusCode >= 200 && statusCode < 300;
}

void Telemetry::onAppLaunch()
{
    // THE GATE (1/1 for this entry point): opted out ⇒ nothing below ever runs —
    // no file read, no id resolution, no thread.
    if (! TelemetryConfig::isOptedIn())
        return;

    bool justStarted = false;
    {
        std::lock_guard<std::mutex> lock (stateMutex_);
        if (started_)
            return; // idempotent — a second onAppLaunch() in the same process no-ops
        started_ = true;
        justStarted = true;

        installId_ = TelemetryConfig::installId();
        auto persisted = loadPersistedStateLocked();
        launches_ = (int) persisted.getProperty ("launches", 0) + 1;
        priorTotalSessionSeconds_ = (juce::int64) (int) persisted.getProperty ("totalSessionSeconds", 0);
        sessionStartMs_ = juce::Time::currentTimeMillis();
        commandCounts_.clear();

        persistStateLocked();
    }

   #if ! MOSH_TESTING
    // Production only: a detached best-effort heartbeat so session length + the
    // command histogram are captured without a clean-shutdown hook (this module
    // does not touch Main.cpp's shutdown() — see the coordination note in
    // docs/telemetry/PRIVACY.md). Never started under MOSH_TESTING; tests call
    // flush() directly for deterministic, timing-free assertions.
    if (justStarted)
    {
        std::thread ([]
        {
            for (;;)
            {
                std::this_thread::sleep_for (std::chrono::seconds (kFlushIntervalSeconds));
                flush();
            }
        }).detach();
    }
   #else
    juce::ignoreUnused (justStarted);
   #endif
}

void Telemetry::onCommand (const juce::String& sanitizedCommandName)
{
    std::lock_guard<std::mutex> lock (stateMutex_);
    if (! started_)
        return; // opted out (or not yet launched this process) — pure no-op, no I/O
    ++commandCounts_[sanitizedCommandName];
}

void Telemetry::flush (Uploader uploader)
{
    // THE GATE (2/2 — the other half of "off by default"): re-checked on every
    // flush (not just at onAppLaunch()) so a mid-session opt-out via Settings
    // takes effect within one flush interval, not just on next launch.
    const bool optedIn = TelemetryConfig::isOptedIn();

    juce::String urlToUpload, bodyToUpload;
    bool shouldUpload = false;
    {
        std::lock_guard<std::mutex> lock (stateMutex_);
        if (! optedIn)
        {
            started_ = false;
            commandCounts_.clear();
            return; // touches nothing further — no state.json write, no network
        }
        if (! started_)
            return; // opted in on disk, but onAppLaunch() never ran this process

        persistStateLocked();

        urlToUpload = juce::SystemStats::getEnvironmentVariable ("MOSH_TELEMETRY_URL", {}).trim();
        if (urlToUpload.isNotEmpty())
        {
            bodyToUpload = uploadPayloadLocked();
            shouldUpload = true;
        }
    }

    // The network call (if any) happens OUTSIDE the lock — best-effort, and only
    // ever reachable when BOTH isOptedIn() and MOSH_TELEMETRY_URL are true/set.
    if (shouldUpload && uploader)
        uploader (urlToUpload, bodyToUpload);
}

void Telemetry::resetForTests()
{
    std::lock_guard<std::mutex> lock (stateMutex_);
    started_ = false;
    installId_ = {};
    launches_ = 0;
    sessionStartMs_ = 0;
    priorTotalSessionSeconds_ = 0;
    commandCounts_.clear();
}

bool Telemetry::isRunningForTests()
{
    std::lock_guard<std::mutex> lock (stateMutex_);
    return started_;
}

juce::var Telemetry::stateForTests()
{
    std::lock_guard<std::mutex> lock (stateMutex_);
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("installId", installId_);
    obj->setProperty ("launches", launches_);
    obj->setProperty ("started", started_);
    auto* counts = new juce::DynamicObject();
    for (auto& kv : commandCounts_)
        counts->setProperty (kv.first, kv.second);
    obj->setProperty ("commandCounts", juce::var (counts));
    return juce::var (obj);
}

} // namespace mosh::telemetry
