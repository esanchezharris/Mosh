#pragma once

#include <juce_core/juce_core.h>

#include <optional>

namespace mosh
{
class RemoteCompanionServer;
/**
    Private owner-cockpit transport. The WebView gives this proxy only a bounded
    supervisor-turn request; it owns the local Agent Host process, generated
    bearer capability, private playtest, and loopback HTTP hop.
*/
class AgentHostProxy
{
public:
    explicit AgentHostProxy (RemoteCompanionServer* ownerControl = nullptr)
        : ownerControlServer (ownerControl) {}

    struct StartupEnvelope
    {
        juce::String host;
        int port = 0;
        juce::String capability;
    };

    ~AgentHostProxy();

    juce::var startPlaytest (bool retainTranscript);
    juce::var closePlaytest (bool retainTranscript);
    juce::var realtimeSecret();
    juce::var createReport (const juce::var& request);
    juce::var approveReport (const juce::String& reportId);
    juce::var createRepair (const juce::String& reportId);
    juce::var launchRepair (const juce::String& repairId, const juce::String& buildPath);
    juce::var rollbackRepair (const juce::String& repairId, const juce::String& reason);
    juce::var events (int afterSequence);
    bool hasActivePlaytest() const;

    /** Blocking; callers must invoke this away from JUCE's message thread.
        Returns { ok:true, plan } or a deliberately token-free error envelope. */
    juce::var supervisorTurn (const juce::var& request);

    /** Pure parser used by the native self-test. The capability never leaves
        this native-only type and is never written to logs. */
    static std::optional<StartupEnvelope> parseStartupEnvelope (const juce::String& line);
    static juce::var parseHostFailure (const juce::var& response,
                                       const juce::String& fallbackMessage,
                                       const juce::String& fallbackCode,
                                       int statusCode);

private:
    bool ensureStarted();
    bool ensurePlaytest();
    juce::var post (const juce::String& path, const juce::var& body, int& statusCode) const;
    juce::String getEventStream (const juce::String& path, int& statusCode) const;
    juce::File locateEntry() const;
    void stop();
    juce::var sessionResult (bool disclosureRequired) const;

    mutable juce::CriticalSection lock;
    juce::ChildProcess process;
    juce::String origin;
    juce::String capability;
    juce::String playtestId;
    bool retainTranscript = false;
    bool disclosureDelivered = false;
    RemoteCompanionServer* ownerControlServer = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AgentHostProxy)
};
} // namespace mosh
