#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include "WebViewHost.h"
#include "DslExecutor.h"

namespace mosh
{
    // The top-level application window. Hosts the WebView shell. Pure native chrome
    // around the swappable WebView frontend (03).
    class MainWindow : public juce::DocumentWindow
    {
    public:
        explicit MainWindow (juce::String name, DslExecutor& executor)
            : juce::DocumentWindow (std::move (name),
                                    juce::Colours::black,
                                    juce::DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (new WebViewHost (executor), true);
            setResizable (true, true);
            centreWithSize (1280, 800);
            setVisible (true);
        }

        void closeButtonPressed() override
        {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

    private:
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
    };
}
