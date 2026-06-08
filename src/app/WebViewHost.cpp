#include "WebViewHost.h"

namespace mosh
{
    namespace
    {
        // A WebBrowserComponent that navigates to the local HTTP UI and, if the page
        // never finishes loading (e.g. WebView2 unavailable), invokes a fallback.
        //
        // The initial navigation is DEFERRED to the first timer tick (not the ctor) so
        // the component is added-to-window, sized and realized first — a blank embedded
        // WebView2 is sometimes a nav-before-realize / nav-before-HttpBridge-bind race,
        // distinct from the synthetic-origin resource-provider bug. It also re-navigates
        // a few times (server bind race) and, only if the frontend never connects, hands
        // off to the fallback (the app-mode window / system browser).
        struct MoshWebView : juce::WebBrowserComponent, private juce::Timer
        {
            MoshWebView (const Options& opts, juce::String u,
                         std::function<bool()> connected, std::function<void()> onError)
                : juce::WebBrowserComponent (opts), navUrl (std::move (u)),
                  connectedCb (std::move (connected)), errorCb (std::move (onError))
            {
                startTimer (300);   // defer first nav until realized + sized (see above)
            }

            ~MoshWebView() override { stopTimer(); }

            bool pageLoadHadNetworkError (const juce::String&) override { return false; } // suppress error page

            void timerCallback() override
            {
                if (! navigated) { navigated = true; goToURL (navUrl); return; } // first tick: navigate

                // "Connected" = the frontend fetched the snapshot (it actually rendered
                // + reached the backend). A WebView that loads a blank page never does.
                if (connectedCb && connectedCb()) { stopTimer(); return; }
                if (++attempts >= 6)              { stopTimer(); if (errorCb) errorCb(); return; }  // ~1.8s → fallback
                if (attempts <= 3)                  goToURL (navUrl);  // re-nav (server bind race / blank)
            }

            juce::String navUrl;
            std::function<bool()> connectedCb;
            std::function<void()> errorCb;
            bool navigated = false;
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

        // Default shell: an app-mode window on Windows (the embedded WebView2 renders
        // blank here), the embedded WebView on macOS (WKWebView works). Override with
        // MOSH_UI_MODE = app | browser | webview | none.
       #if JUCE_WINDOWS
        const char* defaultMode = "app";
       #else
        const char* defaultMode = "webview";
       #endif
        const auto mode = juce::SystemStats::getEnvironmentVariable ("MOSH_UI_MODE", defaultMode);

        // Headless: backend only, no UI client launched (open the URL yourself).
        if (mode.equalsIgnoreCase ("none"))
        {
            status.setText (juce::String ("Mosh backend running (headless).\nOpen ") + url
                            + " in a browser.", juce::dontSendNotification);
            return;
        }

        // Embedded WebView (macOS default; opt-in on Windows). Add + size BEFORE the
        // deferred navigation so it's realized first.
        if (mode.equalsIgnoreCase ("webview"))
        {
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
                juce::MessageManager::callAsync ([this] { if (! launchAppWindow()) launchInBrowser(); });
            });
            addAndMakeVisible (*webView);
            resized();
            return;
        }

        // App-mode window (default on Windows): a frameless Chromium --app window. Falls
        // back to the system browser if no Edge/Chrome is found.
        if (! mode.equalsIgnoreCase ("browser"))
        {
            if (launchAppWindow())
            {
                browserLaunched = true;
                status.setText (juce::String::fromUTF8 ("Mosh — the audio engine + generative backend run here.\n\n")
                                + "The interface opened in an app window.\n" + url
                                + "\n\n(Keep this window open — closing it quits Mosh.)",
                                juce::dontSendNotification);
                status.toFront (false);
                return;
            }
            // no Chromium → system browser
        }

        launchInBrowser();
    }

    WebViewHost::~WebViewHost()
    {
        // The app-mode window is owned by us (its own user-data-dir) → close it with Mosh.
        if (appProc != nullptr && appProc->isRunning())
            appProc->kill();
    }

    juce::File WebViewHost::findChromiumExe()
    {
        const auto pf   = juce::SystemStats::getEnvironmentVariable ("ProgramFiles", "C:\\Program Files");
        const auto pfx  = juce::SystemStats::getEnvironmentVariable ("ProgramFiles(x86)", "C:\\Program Files (x86)");
        const auto lad  = juce::SystemStats::getEnvironmentVariable ("LOCALAPPDATA", {});

        juce::Array<juce::File> candidates;
        candidates.add (juce::File (pfx).getChildFile ("Microsoft/Edge/Application/msedge.exe"));
        candidates.add (juce::File (pf ).getChildFile ("Microsoft/Edge/Application/msedge.exe"));
        candidates.add (juce::File (pf ).getChildFile ("Google/Chrome/Application/chrome.exe"));
        candidates.add (juce::File (pfx).getChildFile ("Google/Chrome/Application/chrome.exe"));
        if (lad.isNotEmpty())
            candidates.add (juce::File (lad).getChildFile ("Google/Chrome/Application/chrome.exe"));
        for (const auto& c : candidates)
            if (c.existsAsFile())
                return c;

       #if JUCE_WINDOWS
        for (const char* exe : { "msedge.exe", "chrome.exe" })
        {
            const auto p = juce::WindowsRegistry::getValue (
                juce::String ("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\") + exe + "\\");
            if (p.isNotEmpty() && juce::File (p).existsAsFile())
                return juce::File (p);
        }
       #endif
        return {};
    }

    bool WebViewHost::launchAppWindow()
    {
        const auto exe = findChromiumExe();
        if (! exe.existsAsFile())
            return false;

        // A dedicated user-data-dir makes Chromium spawn a FRESH instance we own (rather
        // than handing the URL to an existing browser process), so killing appProc in the
        // dtor closes the window with Mosh.
        const auto udd = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("MoshAppWindow");
        udd.createDirectory();

        appProc = std::make_unique<juce::ChildProcess>();
        const bool ok = appProc->start (juce::StringArray {
            exe.getFullPathName(),
            "--app=" + url,
            "--user-data-dir=" + udd.getFullPathName(),
            "--window-size=1280,860",
            "--no-first-run",
            "--no-default-browser-check"
        });
        if (! ok) { appProc.reset(); return false; }
        return true;
    }

    void WebViewHost::launchInBrowser()
    {
        if (browserLaunched) return;
        browserLaunched = true;
        if (webView != nullptr) webView->setVisible (false);
        status.setText (juce::String::fromUTF8 ("Mosh — the audio engine + generative backend are running here.\n\n")
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
