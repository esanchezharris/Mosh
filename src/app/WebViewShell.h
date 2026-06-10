#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "webview/WebBridge.h"

namespace mosh
{
/** Hosts the JUCE 8 WebBrowserComponent that runs the React/Vite UI, and owns
    the WebBridge (the swappable seam). In dev, set MOSH_UI_DEV_SERVER (e.g.
    http://localhost:5173) to point at the Vite dev server; otherwise the staged
    bundle is served via the bridge's resource provider. */
class WebViewShell : public juce::Component,
                     public juce::FileDragAndDropTarget
{
public:
    WebViewShell();
    ~WebViewShell() override;

    WebBridge& bridge() { return webBridge; }

    void load();
    void resized() override;

    /** Finder drag-drop (Stage 31): audio files dropped on the WINDOW import
        via the normal command path. The WebView itself can't deliver native
        paths to JS — the native component can. */
    using FilesDroppedFn = std::function<void (const juce::StringArray&)>;
    void setOnFilesDropped (FilesDroppedFn f) { onFilesDropped = std::move (f); }
    bool isInterestedInFileDrag (const juce::StringArray& files) override;
    void filesDropped (const juce::StringArray& files, int x, int y) override;

private:
    bool loaded = false;
    FilesDroppedFn onFilesDropped;
    WebBridge webBridge;
    std::unique_ptr<juce::WebBrowserComponent> webView;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebViewShell)
};

} // namespace mosh
