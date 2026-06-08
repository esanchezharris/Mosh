#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "DslExecutor.h"

// ──────────────────────────────────────────────────────────────────────────────
// WebViewHost — the JUCE 8 WebView shell + the C++ side of the swappable seam (03).
//
// It is the ONLY place the backend touches the frontend. It:
//   • serves the bundled React/Vite UI (staged next to the exe) via a resource
//     provider, OR points at the Vite dev server when MOSH_DEV_SERVER is set;
//   • registers the native functions the bridge calls: executeCommand(name,args),
//     getSnapshot();
//   • pushes typed events to JS on the "mosh_event" channel by listening to the
//     DslExecutor and forwarding MoshEvent::toVar().
//
// No Tracktion/audio concepts cross here — only the command catalog + snapshot
// schema. That is what makes the frontend disposable.
//
// VERIFY (JUCE 8.0.8): the exact WebBrowserComponent::Options builder names
// (withResourceProvider / withNativeIntegrationEnabled / withNativeFunction /
// emitEventIfBrowserIsVisible) and getResourceProviderRoot() — confirm against
// the JUCE 8 WebBrowserComponent example when first building on macOS. The JS-side
// accessor (window.__JUCE__.backend.*) is the matching // VERIFY in ui/bridge.ts.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class WebViewHost : public juce::Component,
                        private MoshEventListener,
                        private juce::Timer
    {
    public:
        explicit WebViewHost (DslExecutor& executor);
        ~WebViewHost() override;

        void resized() override;

    private:
        void onMoshEvent (const MoshEvent& e) override;
        void timerCallback() override;   // one-shot re-navigate once the peer/env is ready

        // Resource provider: map a request path to a staged UI file.
        std::optional<juce::WebBrowserComponent::Resource> provideResource (const juce::String& url) const;
        static juce::File stagedUiDir();
        static juce::String mimeTypeFor (const juce::String& path);

        DslExecutor& exec;
        std::unique_ptr<juce::WebBrowserComponent> webView;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebViewHost)
    };
}
