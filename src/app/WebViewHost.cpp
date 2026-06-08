#include "WebViewHost.h"

#ifndef MOSH_UI_STAGE_DIRNAME
 #define MOSH_UI_STAGE_DIRNAME "ui"
#endif

namespace mosh
{
    // The WebView event channel the frontend subscribes on (ui/src/bridge.ts).
    static const juce::Identifier kEventChannel { "mosh_event" };

    // Diagnostic: when MOSH_WV_DEBUG is set, append resource-request + native-fn
    // activity to temp/mosh_wv_log.txt — ground truth for debugging the WebView load
    // (esp. the Windows-WebView2 resource-interception issue; see STATUS "OPEN ISSUE").
    static void wvLog (const juce::String& line)
    {
        static const bool on = juce::SystemStats::getEnvironmentVariable ("MOSH_WV_DEBUG", {}).isNotEmpty();
        if (! on)
            return;
        juce::File::getSpecialLocation (juce::File::tempDirectory)
            .getChildFile ("mosh_wv_log.txt").appendText (line + "\n");
    }

    WebViewHost::WebViewHost (DslExecutor& executor) : exec (executor)
    {
        using WBC = juce::WebBrowserComponent;

        // Windows WebView2 wants an explicit, writable user-data folder + a dark
        // background (avoids a white flash before first paint). Ignored on macOS
        // (WKWebView). VERIFY (JUCE 8.0.8): WinWebView2 builder names.
        const auto wv2DataDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                    .getChildFile ("MoshWebView2");
        wv2DataDir.createDirectory();

        auto options = WBC::Options{}
           #if JUCE_WINDOWS
            .withBackend (WBC::Options::Backend::webview2)   // matches JUCE's WebViewPluginDemo
           #endif
            .withNativeIntegrationEnabled()
            .withWinWebView2Options (WBC::Options::WinWebView2{}
                                         .withUserDataFolder (wv2DataDir)
                                         .withBackgroundColour (juce::Colours::black))
            // Pass the resource-provider root origin as the allowed origin (matches
            // JUCE's WebViewPluginDemo) so the served page's CORS origin is accepted.
            .withResourceProvider ([this] (const auto& url) { return provideResource (url); },
                                   juce::URL (WBC::getResourceProviderRoot()).getOrigin())
            // executeCommand(name, argsJson) → MoshResult envelope (02 §1).
            .withNativeFunction ("executeCommand",
                [this] (const juce::Array<juce::var>& args, WBC::NativeFunctionCompletion complete)
                {
                    const auto name = args.size() > 0 ? args[0].toString() : juce::String();
                    const auto argsJson = args.size() > 1 ? args[1].toString() : juce::String ("{}");
                    wvLog ("NATIVE executeCommand " + name + " args=" + argsJson);
                    // execute() mutates the model → must run on the message thread.
                    // JUCE invokes native functions on the message thread already.
                    const auto result = exec.execute (MoshCommand::fromJsonArgs (name, argsJson));
                    complete (result.toVar());
                })
            // getSnapshot() → the full session as plain data (02 §4.1).
            .withNativeFunction ("getSnapshot",
                [this] (const juce::Array<juce::var>&, WBC::NativeFunctionCompletion complete)
                {
                    wvLog ("NATIVE getSnapshot called (UI connected to real backend)");
                    complete (exec.getSnapshot());
                });

        webView = std::make_unique<WBC> (options);
        addAndMakeVisible (*webView);

        // Forward backend events → JS.
        exec.addListener (this);

        // Reset the diagnostic log + record the navigation target.
        juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("mosh_wv_log.txt").deleteFile();
        wvLog ("HOST ctor; stagedUiDir=" + stagedUiDir().getFullPathName()
               + " exists=" + juce::String (stagedUiDir().getChildFile ("index.html").existsAsFile() ? 1 : 0)
               + " root=" + WBC::getResourceProviderRoot());

        // Dev override: point at the running Vite dev server for hot-reload UI work.
        if (auto devUrl = juce::SystemStats::getEnvironmentVariable ("MOSH_DEV_SERVER", {}); devUrl.isNotEmpty())
            webView->goToURL (devUrl);
        else
            webView->goToURL (WBC::getResourceProviderRoot());

        // Re-navigate once after the window/peer + WebView2 env are surely ready, in
        // case the ctor-time navigation was issued before the resource filter existed.
        startTimer (1500);
    }

    WebViewHost::~WebViewHost()
    {
        stopTimer();
        exec.removeListener (this);
    }

    void WebViewHost::timerCallback()
    {
        stopTimer();   // one-shot
        if (webView != nullptr)
        {
            if (auto devUrl = juce::SystemStats::getEnvironmentVariable ("MOSH_DEV_SERVER", {}); devUrl.isNotEmpty())
                webView->goToURL (devUrl);
            else
                webView->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
            wvLog ("RENAV to root");
        }
    }

    void WebViewHost::resized()
    {
        if (webView != nullptr)
            webView->setBounds (getLocalBounds());
    }

    void WebViewHost::onMoshEvent (const MoshEvent& e)
    {
        if (webView != nullptr)
            webView->emitEventIfBrowserIsVisible (kEventChannel, e.toVar());
    }

    juce::File WebViewHost::stagedUiDir()
    {
        return juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                   .getParentDirectory()
                   .getChildFile (MOSH_UI_STAGE_DIRNAME);
    }

    std::optional<juce::WebBrowserComponent::Resource>
    WebViewHost::provideResource (const juce::String& url) const
    {
        wvLog ("REQ url=" + url);
        // The provider may receive a bare path ("/assets/x.js") or, defensively, a
        // full URL — normalize both. Strip the resource root / scheme+host, the
        // query string, then map "/" → index.html.
        auto path = url;
        for (auto* prefix : { "https://juce.backend", "juce://juce.backend" })
            if (path.startsWith (prefix))
                path = path.fromFirstOccurrenceOf (prefix, false, false);
        path = path.upToFirstOccurrenceOf ("?", false, false)
                   .upToFirstOccurrenceOf ("#", false, false);
        if (path.isEmpty() || path == "/")
            path = "/index.html";

        auto file = stagedUiDir().getChildFile (path.trimCharactersAtStart ("/"));
        if (! file.existsAsFile())
        {
            // Diagnostic fallback: if the provider is reached but the file is missing,
            // render a visible page (proves the provider path works vs. a canceled
            // navigation). Only for the document request, so missing assets still 404.
            if (path == "/index.html")
            {
                const auto html = "<html><body style='background:#111;color:#eee;font-family:sans-serif;padding:24px'>"
                                  "<h1>Mosh</h1><p>WebView resource provider reached, but the UI bundle was not found.</p>"
                                  "<p>Looked in: " + stagedUiDir().getFullPathName() + "</p>"
                                  "<p>Build with MOSH_BUILD_UI=ON to stage ui/dist next to the executable.</p>"
                                  "</body></html>";
                const auto utf8 = html.toRawUTF8();
                std::vector<std::byte> data (html.getNumBytesAsUTF8());
                std::memcpy (data.data(), utf8, data.size());
                return juce::WebBrowserComponent::Resource { std::move (data), "text/html" };
            }
            return std::nullopt;
        }

        juce::MemoryBlock mb;
        if (! file.loadFileAsData (mb))
        {
            wvLog ("FAIL-READ " + file.getFullPathName());
            return std::nullopt;
        }

        wvLog ("SERVE " + file.getFullPathName() + " (" + juce::String (mb.getSize()) + "B) mime=" + mimeTypeFor (file.getFileName()));
        std::vector<std::byte> data (mb.getSize());
        std::memcpy (data.data(), mb.getData(), mb.getSize());
        return juce::WebBrowserComponent::Resource { std::move (data),
                                                     mimeTypeFor (file.getFileName()) };
    }

    juce::String WebViewHost::mimeTypeFor (const juce::String& path)
    {
        const auto ext = path.fromLastOccurrenceOf (".", false, false).toLowerCase();
        if (ext == "html") return "text/html";
        if (ext == "js" || ext == "mjs") return "text/javascript";
        if (ext == "css") return "text/css";
        if (ext == "json") return "application/json";
        if (ext == "svg") return "image/svg+xml";
        if (ext == "png") return "image/png";
        if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
        if (ext == "gif") return "image/gif";
        if (ext == "ico") return "image/x-icon";
        if (ext == "woff2") return "font/woff2";
        if (ext == "woff") return "font/woff";
        if (ext == "ttf") return "font/ttf";
        if (ext == "wasm") return "application/wasm";
        if (ext == "map") return "application/json";
        return "application/octet-stream";
    }
}
