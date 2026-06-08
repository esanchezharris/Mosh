#include "WebViewHost.h"

namespace mosh
{
    namespace
    {
        // A WebBrowserComponent that navigates to the local HTTP UI and, if the page
        // never finishes loading (e.g. WebView2 unavailable), invokes a fallback. It
        // retries a few times first because the HttpBridge listener may bind a beat
        // after the window is created (startup race), not because of a real failure.
        struct MoshWebView : juce::WebBrowserComponent, private juce::Timer
        {
            MoshWebView (const Options& opts, juce::String u,
                         std::function<bool()> connected, std::function<void()> onError)
                : juce::WebBrowserComponent (opts), navUrl (std::move (u)),
                  connectedCb (std::move (connected)), errorCb (std::move (onError))
            {
                goToURL (navUrl);
                startTimer (1500);
            }

            ~MoshWebView() override { stopTimer(); }

            bool pageLoadHadNetworkError (const juce::String&) override { return false; } // suppress error page

            void timerCallback() override
            {
                // "Connected" = the frontend fetched the snapshot (it actually rendered
                // + reached the backend). A WebView that loads a blank page never does.
                if (connectedCb && connectedCb()) { stopTimer(); return; }
                if (++attempts >= 5)              { stopTimer(); if (errorCb) errorCb(); return; }  // ~7.5s → browser
                if (attempts <= 2)                  goToURL (navUrl);  // re-nav early (server bind race)
            }

            juce::String navUrl;
            std::function<bool()> connectedCb;
            std::function<void()> errorCb;
            int attempts = 0;
        };
    }

    WebViewHost::WebViewHost ([[maybe_unused]] DslExecutor& executor, std::function<bool()> connected)
        : uiConnected (std::move (connected))
    {
        const int port = juce::SystemStats::getEnvironmentVariable ("MOSH_HTTP_PORT", "8080").getIntValue();
        url = "http://localhost:" + juce::String (port);

        status.setJustificationType (juce::Justification::centred);
        status.setColour (juce::Label::textColourId, juce::Colour (0xffb8c0d0));
        status.setColour (juce::Label::backgroundColourId, juce::Colour (0xff0b0f1a));
        status.setText ("Loading Mosh…\n" + url, juce::dontSendNotification);
        addAndMakeVisible (status);

        const auto mode = juce::SystemStats::getEnvironmentVariable ("MOSH_UI_MODE", "browser");

        // Headless: backend only, no UI client launched (open the URL yourself).
        if (mode.equalsIgnoreCase ("none"))
        {
            status.setText (juce::String ("Mosh backend running (headless).\nOpen ") + url
                            + " in a browser.", juce::dontSendNotification);
            return;
        }

        // Default to the system browser on Windows: the embedded WebView2 reliably
        // fails here (renders blank AND its connection pattern wedges the server).
        // The browser renders the UI correctly and drives the backend over HTTP.
        // Opt into the in-app view with MOSH_UI_MODE=webview.
        if (! mode.equalsIgnoreCase ("webview"))
        {
            launchInBrowser();
            return;
        }

        using WBC = juce::WebBrowserComponent;
        const auto wv2DataDir = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("MoshWebView2");
        wv2DataDir.createDirectory();

        auto options = WBC::Options{}
           #if JUCE_WINDOWS
            .withBackend (WBC::Options::Backend::webview2)
           #endif
            .withWinWebView2Options (WBC::Options::WinWebView2{}
                                         .withUserDataFolder (wv2DataDir)
                                         .withBackgroundColour (juce::Colour (0xff0b0f1a)));

        webView = std::make_unique<MoshWebView> (options, url, uiConnected, [this]
        {
            juce::MessageManager::callAsync ([this] { launchInBrowser(); });
        });
        addAndMakeVisible (*webView);
        resized();
    }

    WebViewHost::~WebViewHost() = default;

    void WebViewHost::launchInBrowser()
    {
        if (browserLaunched) return;
        browserLaunched = true;
        if (webView != nullptr) webView->setVisible (false);
        status.setText (juce::String::fromUTF8 ("Mosh — the audio engine + generative backend are running here.\n\n")
                        + "The interface opened in your web browser:\n" + url
                        + "\n\n(If it didn't open, paste that address into your browser.\n"
                        + "Keep this window open — closing it quits Mosh.)",
                        juce::dontSendNotification);
        status.toFront (false);
        juce::URL (url).launchInDefaultBrowser();
    }

    void WebViewHost::resized()
    {
        status.setBounds (getLocalBounds());
        if (webView != nullptr) webView->setBounds (getLocalBounds());
    }
}
