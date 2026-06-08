#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "app/WebViewShell.h"

namespace mosh
{
/** The single top-level window. Hosts the WebView shell as its content. */
class MainWindow : public juce::DocumentWindow
{
public:
    explicit MainWindow (juce::String name);
    ~MainWindow() override;

    void closeButtonPressed() override;

    WebViewShell& shell() { return *content; }

private:
    std::unique_ptr<WebViewShell> content;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
};

} // namespace mosh
