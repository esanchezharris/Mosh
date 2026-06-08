// Minimal JUCE WebView2 probe — isolates the resource-provider mechanism from all of
// Mosh's code (no staged files, no React): the provider returns trivial inline HTML
// for ANY url. If this renders "PROBE OK", WebView2 + JUCE's resource provider work
// here and the bug is in WebViewHost; if it shows "Can't reach this page", it's a
// JUCE-8.0.8/Windows-WebView2 environment issue, not Mosh's code. (Diagnostic target.)
#include <juce_gui_extra/juce_gui_extra.h>

class ProbeWindow : public juce::DocumentWindow
{
public:
    ProbeWindow() : juce::DocumentWindow ("WVProbe", juce::Colours::black, allButtons)
    {
        using WBC = juce::WebBrowserComponent;
        auto opts = WBC::Options{}
                       .withBackend (WBC::Options::Backend::webview2)
                       .withWinWebView2Options (WBC::Options::WinWebView2{}
                                                    .withUserDataFolder (juce::File::getSpecialLocation (juce::File::tempDirectory)))
                       .withNativeIntegrationEnabled()
                       .withResourceProvider ([] (const juce::String& url) -> std::optional<WBC::Resource>
                       {
                           const juce::String html =
                               "<html><body style='background:#103a10;color:#7CFC7C;font-family:sans-serif'>"
                               "<h1>PROBE OK</h1><p>resource provider reached. url=" + url + "</p></body></html>";
                           std::vector<std::byte> data (html.getNumBytesAsUTF8());
                           std::memcpy (data.data(), html.toRawUTF8(), data.size());
                           return WBC::Resource { std::move (data), "text/html" };
                       });

        auto* wv = new WBC (opts);
        setContentOwned (wv, true);
        wv->goToURL (WBC::getResourceProviderRoot());
        setUsingNativeTitleBar (true);
        centreWithSize (820, 560);
        setVisible (true);
    }

    void closeButtonPressed() override { juce::JUCEApplication::getInstance()->systemRequestedQuit(); }
};

class ProbeApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override    { return "WVProbe"; }
    const juce::String getApplicationVersion() override { return "1.0"; }
    void initialise (const juce::String&) override      { window = std::make_unique<ProbeWindow>(); }
    void shutdown() override                            { window.reset(); }
    void systemRequestedQuit() override                 { quit(); }
private:
    std::unique_ptr<ProbeWindow> window;
};

START_JUCE_APPLICATION (ProbeApp)
