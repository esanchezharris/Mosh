#include "MainWindow.h"

namespace mosh
{
MainWindow::MainWindow (juce::String name)
    : juce::DocumentWindow (name,
        juce::Desktop::getInstance().getDefaultLookAndFeel()
            .findColour (juce::ResizableWindow::backgroundColourId),
        juce::DocumentWindow::allButtons)
{
    setUsingNativeTitleBar (true);
    content = std::make_unique<WebViewShell>();
    setContentNonOwned (content.get(), false);

    setResizable (true, false);
    centreWithSize (1440, 900);
    setVisible (true);
}

MainWindow::~MainWindow()
{
    content.reset();
}

void MainWindow::closeButtonPressed()
{
    juce::JUCEApplication::getInstance()->systemRequestedQuit();
}

} // namespace mosh
