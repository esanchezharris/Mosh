#include "WebViewHost.h"

#ifndef MOSH_UI_STAGE_DIRNAME
 #define MOSH_UI_STAGE_DIRNAME "ui"
#endif

namespace mosh
{
    // The WebView event channel the frontend subscribes on (ui/src/bridge.ts).
    static const juce::Identifier kEventChannel { "mosh_event" };

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
            .withNativeIntegrationEnabled()
            .withWinWebView2Options (WBC::Options::WinWebView2{}
                                         .withUserDataFolder (wv2DataDir)
                                         .withBackgroundColour (juce::Colours::black))
            .withResourceProvider ([this] (const auto& url) { return provideResource (url); })
            // executeCommand(name, argsJson) → MoshResult envelope (02 §1).
            .withNativeFunction ("executeCommand",
                [this] (const juce::Array<juce::var>& args, WBC::NativeFunctionCompletion complete)
                {
                    const auto name = args.size() > 0 ? args[0].toString() : juce::String();
                    const auto argsJson = args.size() > 1 ? args[1].toString() : juce::String ("{}");
                    // execute() mutates the model → must run on the message thread.
                    // JUCE invokes native functions on the message thread already.
                    const auto result = exec.execute (MoshCommand::fromJsonArgs (name, argsJson));
                    complete (result.toVar());
                })
            // getSnapshot() → the full session as plain data (02 §4.1).
            .withNativeFunction ("getSnapshot",
                [this] (const juce::Array<juce::var>&, WBC::NativeFunctionCompletion complete)
                {
                    complete (exec.getSnapshot());
                });

        webView = std::make_unique<WBC> (options);
        addAndMakeVisible (*webView);

        // Forward backend events → JS.
        exec.addListener (this);

        // Dev override: point at the running Vite dev server for hot-reload UI work.
        if (auto devUrl = juce::SystemStats::getEnvironmentVariable ("MOSH_DEV_SERVER", {}); devUrl.isNotEmpty())
            webView->goToURL (devUrl);
        else
            webView->goToURL (WBC::getResourceProviderRoot());
    }

    WebViewHost::~WebViewHost()
    {
        exec.removeListener (this);
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
            return std::nullopt;

        juce::MemoryBlock mb;
        if (! file.loadFileAsData (mb))
            return std::nullopt;

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
