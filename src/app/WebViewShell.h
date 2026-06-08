#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "webview/WebBridge.h"

namespace mosh
{
/** Hosts the JUCE 8 WebBrowserComponent that runs the React/Vite UI, and owns
    the WebBridge (the swappable seam). In dev, set MOSH_UI_DEV_SERVER (e.g.
    http://localhost:5173) to point at the Vite dev server; otherwise the staged
    bundle is served via the bridge's resource provider. */
class WebViewShell : public juce::Component
{
public:
    WebViewShell();
    ~WebViewShell() override;

    WebBridge& bridge() { return webBridge; }

    void load();
    void resized() override;

private:
    bool loaded = false;
    WebBridge webBridge;
    std::unique_ptr<juce::WebBrowserComponent> webView;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebViewShell)
};

} // namespace mosh
