#pragma once
#include <juce_core/juce_core.h>
#include "DslExecutor.h"
#include <deque>
#include <mutex>

// ──────────────────────────────────────────────────────────────────────────────
// HttpBridge — a minimal HTTP transport for the MoshOps seam, so a PLAIN BROWSER
// can drive the real C++/Tracktion backend (used when the JUCE WebView2 backend is
// unavailable, e.g. the JUCE-8.0.8 Windows-WebView2 resource-provider bug). It is
// just another transport for the SAME command surface — no prime directive is
// bent: every mutation is still a MoshOps command run on the message thread.
//
//   GET  /            → ui/index.html         GET /assets/*  → bundle files
//   GET  /api/snapshot → getSnapshot() JSON
//   POST /api/command  → { name, args } → MoshResult JSON
//   GET  /api/events?since=N → { events:[...], seq:M, resync:bool }
//
// Command/snapshot calls are marshalled to the message thread (Tracktion mutates
// there). Events are captured via a MoshEventListener into a thread-safe seq-log.
//
// RELIABILITY: /api/events is a NON-DESTRUCTIVE sequence-cursor feed. Each event
// gets a monotonic seq; a poll returns events with seq > `since` WITHOUT removing
// them, plus the new cursor. The client advances `since` only on a delivered
// response, so a dropped/refused response simply re-fetches the same events next
// poll (at-least-once; applyEvent handlers are idempotent). A bounded ring trims
// old events — if a client falls behind the retained window it gets resync=true
// and refetches the snapshot. This replaced a drain-on-read queue that lost any
// events whose response failed to deliver (single-threaded server under load).
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class HttpBridge : private juce::Thread,
                       private MoshEventListener
    {
    public:
        HttpBridge (DslExecutor& executor, juce::File uiDirToServe, int portToUse);
        ~HttpBridge() override;

        bool isListening() const { return listening; }
        int  getPort() const     { return port; }

    private:
        void run() override;                                  // accept loop
        void onMoshEvent (const MoshEvent&) override;         // queue events for /api/events
        void handleConnection (juce::StreamingSocket&);

        juce::var snapshotOnMessageThread();
        juce::var executeOnMessageThread (const juce::String& name, const juce::String& argsJson);

        static juce::String mimeFor (const juce::String& path);

        DslExecutor& exec;
        juce::File uiDir;
        int port;
        std::atomic<bool> listening { false };

        // Sequence-cursor event log (non-destructive reads; see header comment).
        struct SeqEvent { juce::int64 seq; juce::var data; };
        std::mutex eventMutex;
        std::deque<SeqEvent> eventLog;          // retained window, ascending seq
        juce::int64 lastSeq = 0;                // last assigned seq (monotonic)
        static constexpr int maxRetained = 5000;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (HttpBridge)
    };
}
