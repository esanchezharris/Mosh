#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <functional>
#include "RemoteCompanionProtocol.h"

namespace mosh
{

class RemoteCompanionServer : private juce::Thread
{
public:
    using CommandHandler = std::function<juce::var (const juce::var& command)>;
    using SnapshotProvider = std::function<juce::var()>;

    explicit RemoteCompanionServer (juce::File takeRoot);
    ~RemoteCompanionServer() override;

    void setCommandHandler (CommandHandler h) { commandHandler = std::move (h); }
    void setSnapshotProvider (SnapshotProvider p) { snapshotProvider = std::move (p); }

    juce::var startPairing (const juce::var& args = {});
    // Design-lab feed: same listener as pairing, but a caller-supplied stable token
    // and a 24h TTL so a local browser playground can poll /events without the
    // pairing dance. Opt-in (env-gated in Main); LAN-visible like pairing.
    juce::var startLabFeed (const juce::String& token);
    juce::var startOwnerControl (const juce::String& token);
    juce::var stopServer();
    juce::var status (bool includePairingSecrets = true) const;
    void pushEvent (const juce::var& event);

#if MOSH_TESTING
    juce::var handleTestRequest (const juce::String& method,
                                 const juce::String& path,
                                 const juce::var& body);
#endif

private:
    struct Request
    {
        juce::String method;
        juce::String path;
        juce::String query;
        juce::String body;
        juce::String authToken;
        int contentLength = 0;
    };

    void run() override;
    void handleClient (std::unique_ptr<juce::StreamingSocket> client);
    juce::var handleRequest (const Request& request);

    static bool parseRequest (juce::StreamingSocket& socket, Request& request);
    static juce::String readHeaders (juce::StreamingSocket& socket);
    static juce::String headerValue (const juce::StringArray& lines, const juce::String& name);
    static void writeJsonResponse (juce::StreamingSocket& socket, int statusCode, const juce::var& body);
    static void writeTextResponse (juce::StreamingSocket& socket, int statusCode,
                                   const juce::String& contentType, const juce::String& body);
    static juce::String webCompanionHtml();
    static juce::String legacyWebCompanionHtml(); // inline fallback when the built page isn't staged
    static juce::var ok (juce::var data = {});
    static juce::var err (const juce::String& message);
    static juce::var toVar (const RemotePairingInfo& info, bool includeSecrets = true);
    static juce::String localBonjourHost();

    juce::var callOnMessageThread (const std::function<juce::var()>& fn,
                                   int timeoutMs = 5000) const;
    RemoteAuthResult authorizeRequest (const Request& request, const juce::var& body) const;
    juce::var eventsSince (int sinceSeq) const;
    void startBonjour();
    void stopBonjour();

    RemoteCompanionProtocol protocol;
    RemotePhoneTakeStore takeStore;
    RemoteMonitorStore monitorStore;
    CommandHandler commandHandler;
    SnapshotProvider snapshotProvider;

    mutable juce::CriticalSection lock;
    std::unique_ptr<juce::StreamingSocket> listener;
    bool running = false;
    bool ownerControl = false;
    int port = RemoteCompanionProtocol::defaultPort();
    juce::Array<juce::var> eventQueue;
    int eventSeq = 0;
    void* bonjourRef = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (RemoteCompanionServer)
};

} // namespace mosh
