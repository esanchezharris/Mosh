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
// MOSH_UI_MODE selects the shell:
//   "app"     (default on Windows) — a frameless Edge/Chrome --app window owned by
//             the host (closes with Mosh); falls back to "browser" if none found.
//   "browser" — the system default browser at the URL (a normal tab).
//   "webview" — the embedded JUCE WebView2 (works on macOS WKWebView; on this
//             Windows machine it renders blank, a JUCE-8.0.8 limitation).
//   "none"    — headless backend only.
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
        // Launch a frameless app-mode Chromium window (Edge, then Chrome) at the URL,
        // owned by this host. Returns false (→ caller falls back to the browser) if no
        // Chromium is found or it won't start.
        bool launchAppWindow();
        // Locate msedge.exe / chrome.exe (standard install dirs + App Paths registry).
        static juce::File findChromiumExe();

        juce::String url;
        juce::Label  status;
        std::function<bool()> uiConnected;
        std::unique_ptr<juce::WebBrowserComponent> webView;
        std::unique_ptr<juce::ChildProcess> appProc;   // the owned app-mode window
        bool browserLaunched = false;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebViewHost)
    };
}
