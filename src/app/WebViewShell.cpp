#include "WebViewShell.h"
#include "webview/WebViewCameraPermission.h"

namespace mosh
{
WebViewShell::WebViewShell()
{
    webView = std::make_unique<juce::WebBrowserComponent> (webBridge.buildOptions());
    webBridge.attach (*webView);
    addAndMakeVisible (*webView);
   #if JUCE_MAC
    startTimer (150); // retry until the WKWebView is realized, then install the camera delegate
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
    if (webView != nullptr && mosh::installWebViewCameraPermission (*webView)) { stopTimer(); return; }
    if (++camPermAttempts >= 20)
    {
        stopTimer();
        juce::Logger::writeToLog ("[webview] camera permission delegate: WKWebView not found (camera disabled)");
    }
   #else
    stopTimer();
   #endif
}

} // namespace mosh
