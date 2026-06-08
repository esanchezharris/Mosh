#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "DslExecutor.h"

// ──────────────────────────────────────────────────────────────────────────────
// WebViewHost — the PC UI shell. A single native window hosting a WebView2 that
// navigates to the in-process HTTP server (the HttpBridge) at
// http://localhost:<MOSH_HTTP_PORT>. The React UI loads over HTTP and drives the
// backend via `fetch` (the swappable seam — identical to a plain browser). This
// sidesteps the broken-on-Windows JUCE WebView2 resource-provider/native-fn path
// entirely (a normal http navigation just works; for that origin JUCE does not
// inject window.__JUCE__, so ui/bridge.ts selects the HTTP transport).
//
// On a persistent WebView2 load failure — or when MOSH_UI_MODE=browser — it falls
// back to launching the system default browser at the same URL and shows a note.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class WebViewHost : public juce::Component
    {
    public:
        // uiConnected() returns true once the frontend has fetched the snapshot (i.e.
        // it actually initialized). A blank in-app WebView never connects → we fall
        // back to the system browser. Pass {} to skip the check (always trust load).
        WebViewHost (DslExecutor& executor, std::function<bool()> uiConnected = {});
        ~WebViewHost() override;

        void resized() override;

    private:
        void launchInBrowser();

        juce::String url;
        juce::Label  status;
        std::function<bool()> uiConnected;
        std::unique_ptr<juce::WebBrowserComponent> webView;
        bool browserLaunched = false;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebViewHost)
    };
}
