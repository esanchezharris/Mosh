#include "WebViewShell.h"

namespace mosh
{
WebViewShell::WebViewShell()
{
    webView = std::make_unique<juce::WebBrowserComponent> (webBridge.buildOptions());
    webBridge.attach (*webView);
    addAndMakeVisible (*webView);
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

} // namespace mosh
