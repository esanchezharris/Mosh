#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include <functional>

namespace mosh
{
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
    WebBridge() = default;

    /** A command handler: takes a JSON command object, returns a JSON result
        envelope. Injected by the app once MoshOps exists (Stage 1). */
    using CommandHandler = std::function<juce::var (const juce::var& command)>;

    /** A snapshot provider: returns the full session snapshot as JSON. */
    using SnapshotProvider = std::function<juce::var()>;

    void setCommandHandler (CommandHandler h)   { commandHandler = std::move (h); }
    void setSnapshotProvider (SnapshotProvider p) { snapshotProvider = std::move (p); }

    /** Build the JUCE WebBrowserComponent Options with native integration,
        the resource provider (serving the staged UI bundle), and the native
        functions. Called by WebViewShell. */
    juce::WebBrowserComponent::Options buildOptions();

    /** Wire the live WebBrowserComponent so the bridge can push events to JS. */
    void attach (juce::WebBrowserComponent& wb) { webView = &wb; }
    void detach() { webView = nullptr; }

    /** Push a typed event to the UI (snapshot+events feed, 02 §4). Safe to call
        from the message thread only. */
    void emitEvent (const juce::Identifier& eventId, const juce::var& payload);

    /** App identity returned to the UI's `ping` (Stage 0 bridge proof). */
    static juce::var appInfo();

private:
    juce::WebBrowserComponent::Resource serveUiResource (const juce::String& url);

    CommandHandler    commandHandler;
    SnapshotProvider  snapshotProvider;
    juce::WebBrowserComponent* webView = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebBridge)
};

} // namespace mosh
