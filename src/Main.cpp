#include <juce_gui_extra/juce_gui_extra.h>
#include "app/MainWindow.h"

// NOTE (Stage 1/3): the out-of-process VST3 scan hook and the Engine + MoshOps
// bootstrap land here. For Stage 0 the app only opens the WebView window.
//   if (te::PluginManager::startChildProcessPluginScan (commandLine)) return;
//   engine = std::make_unique<te::Engine> ("Mosh", ...); ...

namespace mosh
{
class MoshApplication : public juce::JUCEApplication
{
public:
    MoshApplication() = default;

    const juce::String getApplicationName() override    { return "Mosh"; }
    const juce::String getApplicationVersion() override { return MOSH_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override          { return false; }

    void initialise (const juce::String& /*commandLine*/) override
    {
        mainWindow = std::make_unique<MainWindow> (getApplicationName());
    }

    void shutdown() override
    {
        mainWindow.reset();
    }

    void systemRequestedQuit() override
    {
        quit();
    }

private:
    std::unique_ptr<MainWindow> mainWindow;
};

} // namespace mosh

START_JUCE_APPLICATION (mosh::MoshApplication)
