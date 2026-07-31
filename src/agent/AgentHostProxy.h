#pragma once

#include <juce_core/juce_core.h>

#include <optional>

namespace mosh
{
/**
    Private owner-cockpit transport. The WebView gives this proxy only a bounded
    supervisor-turn request; it owns the local Agent Host process, generated
    bearer capability, private playtest, and loopback HTTP hop.
*/
class AgentHostProxy
{
public:
    AgentHostProxy() = default;

    struct StartupEnvelope
    {
        juce::String host;
        int port = 0;
        juce::String capability;
    };

    ~AgentHostProxy();

    /** Blocking; callers must invoke this away from JUCE's message thread.
        Returns { ok:true, plan } or a deliberately token-free error envelope. */
    juce::var supervisorTurn (const juce::var& request);

    /** Pure parser used by the native self-test. The capability never leaves
        this native-only type and is never written to logs. */
    static std::optional<StartupEnvelope> parseStartupEnvelope (const juce::String& line);

private:
    bool ensureStarted();
    juce::var post (const juce::String& path, const juce::var& body, int& statusCode) const;
    juce::File locateEntry() const;
    void stop();

    mutable juce::CriticalSection lock;
    juce::ChildProcess process;
    juce::String origin;
    juce::String capability;
    juce::String playtestId;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AgentHostProxy)
};
} // namespace mosh
