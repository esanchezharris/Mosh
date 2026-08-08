#include "WebViewShell.h"
#include "webview/WebViewCameraPermission.h"
#include "webview/WebViewKeyboardFocus.h"

namespace mosh
{
WebViewShell::WebViewShell()
{
    webView = std::make_unique<juce::WebBrowserComponent> (webBridge.buildOptions());
    webBridge.attach (*webView);
    addAndMakeVisible (*webView);
   #if JUCE_MAC
    // So JUCE's own focus handoff (focusGainedWithDirection → makeFirstResponder)
    // agrees with the direct installWebViewKeyboardFocus the timer drives below.
    webView->setWantsKeyboardFocus (true);
    startTimer (150); // retry until the WKWebView is realized: camera delegate + keyboard first-responder
   #endif
}

void WebViewShell::load()
{
    if (loaded || webView == nullptr)
        return;

    loaded = true;

    if (auto dev = juce::SystemStats::getEnvironmentVariable ("MOSH_UI_DEV_SERVER", {});
        dev.isNotEmpty())
        webView->goToURL (dev);                                  // live Vite dev server
    else
        webView->goToURL (juce::WebBrowserComponent::getResourceProviderRoot()); // staged bundle
}

WebViewShell::~WebViewShell()
{
    webBridge.detach();
    webView.reset();
}

void WebViewShell::resized()
{
    if (webView != nullptr)
        webView->setBounds (getLocalBounds());
}

void WebViewShell::timerCallback()
{
   #if JUCE_MAC
    if (webView == nullptr) { stopTimer(); return; }

    // Both installs share this retry loop: each returns true once done (idempotent),
    // and the loop stops when both are installed (or the attempt budget runs out —
    // each failure is logged individually so a dead webview is diagnosable).
    const bool camDone = camInstalled || (camInstalled = mosh::installWebViewCameraPermission (*webView));
    const bool kbdDone = kbdInstalled || (kbdInstalled = mosh::installWebViewKeyboardFocus (*webView));
    if (camDone && kbdDone) { stopTimer(); return; }

    if (++webviewInstallAttempts >= 20)
    {
        stopTimer();
        if (! camDone) juce::Logger::writeToLog ("[webview] camera permission delegate: WKWebView not found (camera disabled)");
        if (! kbdDone) juce::Logger::writeToLog ("[webview] keyboard focus: WKWebView never became first responder (DOM keyboard input dead)");
    }
   #else
    stopTimer();
   #endif
}

} // namespace mosh
