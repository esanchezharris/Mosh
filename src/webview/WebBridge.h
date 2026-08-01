#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include <functional>
#include <memory>

namespace mosh
{
class NativeSpeech;
class AgentHostProxy;
class RemoteCompanionServer;

/**
    The swappable seam (00 §0, "swappable-frontend principle").

    The React UI couples to the C++ backend ONLY through this bridge:
      • execute_command(json)  — the single mutation entry point (MoshOps, 02)
      • get_snapshot()         — full state snapshot on load/resync
      • a C++→JS event emitter  — typed deltas + decimated telemetry during a session

    In Stage 0 only the plumbing exists (a `ping` native function + the event
    emitter). MoshOps is injected via setCommandHandler() in Stage 1 so the bridge
    never depends on Tracktion/engine types — keeping the seam clean.
*/
class WebBridge
{
public:
    WebBridge();
    ~WebBridge();   // defined in the .cpp (NativeSpeech is incomplete here)

    /** A command handler: takes a JSON command object, returns a JSON result
        envelope. Injected by the app once MoshOps exists (Stage 1). */
    using CommandHandler = std::function<juce::var (const juce::var& command)>;

    /** A snapshot provider: returns the full session snapshot as JSON. */
    using SnapshotProvider = std::function<juce::var()>;
    using RemoteHandler = std::function<juce::var (const juce::var& args)>;
    using RemoteStatusProvider = std::function<juce::var()>;

    void setCommandHandler (CommandHandler h)   { commandHandler = std::move (h); }
    void setSnapshotProvider (SnapshotProvider p) { snapshotProvider = std::move (p); }
    void setRemoteStartHandler (RemoteHandler h) { remoteStartHandler = std::move (h); }
    void setRemoteStopHandler (RemoteHandler h) { remoteStopHandler = std::move (h); }
    void setRemoteStatusProvider (RemoteStatusProvider p) { remoteStatusProvider = std::move (p); }
    void setOwnerControlServer (RemoteCompanionServer* server) { ownerControlServer = server; }

    /** WP-11 best-of-n relays: UI → generative service, via native (the WebView
        cannot reach the service port itself). Same layering as brain_chat — brain
        traffic is UI-domain, NOT a MoshOps command. Both run on a launched thread
        (the escalation blocks up to ~60 s). Unbound ⇒ the native fns return
        { ok:false } and the UI keeps its single-shot reply. */
    using ServiceRelay = std::function<juce::var (const juce::var& payload)>;
    void setEscalateHandler (ServiceRelay h)    { escalateHandler = std::move (h); }
    void setArchivePairHandler (ServiceRelay h) { archivePairHandler = std::move (h); }

    /** Build the JUCE WebBrowserComponent Options with native integration,
        the resource provider (serving the staged UI bundle), and the native
        functions. Called by WebViewShell. */
    juce::WebBrowserComponent::Options buildOptions();

    /** Wire the live WebBrowserComponent so the bridge can push events to JS. */
    void attach (juce::WebBrowserComponent& wb)
    {
        webView = &wb;
        browserReadyForEvents = false;
    }
    void detach()
    {
        browserReadyForEvents = false;
        webView = nullptr;
    }

    /** Push a typed event to the UI (snapshot+events feed, 02 §4). Safe to call
        from the message thread only. */
    void emitEvent (const juce::Identifier& eventId, const juce::var& payload);

    /** App identity returned to the UI's `ping` (Stage 0 bridge proof). */
    static juce::var appInfo();
    static bool enforceOwnerOnlyEvidencePermissions (const juce::File& target,
                                                     bool directory);

private:
    static bool isSafeUiResourcePath (const juce::String& url);
    static bool isSafeUiResourcePath (const juce::File& uiDir, const juce::String& url);

    juce::WebBrowserComponent::Resource serveUiResource (const juce::String& url);
    juce::var reportRequestWithEvidence (const juce::var& request);

    CommandHandler    commandHandler;
    SnapshotProvider  snapshotProvider;
    RemoteHandler     remoteStartHandler;
    RemoteHandler     remoteStopHandler;
    RemoteStatusProvider remoteStatusProvider;
    ServiceRelay      escalateHandler;
    ServiceRelay      archivePairHandler;
    juce::WebBrowserComponent* webView = nullptr;
    bool browserReadyForEvents = false;
    juce::Array<juce::var> recentCommandResults;

    // Native speech-to-text (packaged-app voice). Created lazily on the first
    // voice_start; its transcripts are pushed to the UI as a `voice_event`.
    std::unique_ptr<NativeSpeech> speech;
    // Lazily created by the native-only supervisor relay. The generated Agent
    // Host capability and private playtest id stay in this process, not the UI.
    std::shared_ptr<AgentHostProxy> agentHost;
    RemoteCompanionServer* ownerControlServer = nullptr;

    // The native file dialog (wave: settings). launchAsync's callback must outlive
    // the dialog, so the FileChooser is held here, not in a local. Only one dialog at
    // a time: pickerBusy guards re-entry so a second request can't replace a live
    // FileChooser (which would drop its in-flight completion and hang that Promise).
    // The flag is cleared in the callback — we never destroy the chooser from inside
    // its own callback (that would be a use-after-free); it is replaced on next launch.
    std::unique_ptr<juce::FileChooser> fileChooser;
    bool pickerBusy = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebBridge)
};

} // namespace mosh
