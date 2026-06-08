#include <juce_gui_extra/juce_gui_extra.h>
#include <tracktion_engine/tracktion_engine.h>
#include "app/MainWindow.h"
#include "app/SelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"

namespace mosh
{
namespace te = tracktion::engine;

class MoshApplication : public juce::JUCEApplication
{
public:
    MoshApplication() = default;

    const juce::String getApplicationName() override    { return "Mosh"; }
    const juce::String getApplicationVersion() override { return MOSH_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override          { return true; }   // allow scan children + headless runs

    void initialise (const juce::String& commandLine) override
    {
        // Out-of-process VST3 scan worker hook (04 §1.1): if this launch is a
        // scan child, handle it and bail before building any UI/engine.
        if (te::PluginManager::startChildProcessPluginScan (commandLine))
            return;

        const bool headless = commandLine.contains ("--selftest");
        engine  = std::make_unique<MoshEngine> (! headless);   // no audio device in headless runs
        moshOps = std::make_unique<MoshOps> (*engine);

        // Headless command-surface harness (06 §4): `Mosh --selftest`.
        if (headless)
        {
            const int fails = runSelfTest (*engine, *moshOps);
            setApplicationReturnValue (fails);
            quit();
            return;
        }

        mainWindow = std::make_unique<MainWindow> (getApplicationName());

        // Wire the swappable seam to the MoshOps spine (the ONLY backend coupling).
        auto& bridge = mainWindow->shell().bridge();
        bridge.setCommandHandler  ([this] (const juce::var& cmd) { return moshOps->execute (cmd); });
        bridge.setSnapshotProvider([this] { return moshOps->snapshot(); });
        moshOps->setEventSink ([&bridge] (const juce::var& e)
                               { bridge.emitEvent (juce::Identifier ("mosh_event"), e); });

        // Scripted Stage 3 demo: build a hosted-plugin session + open a native
        // editor, then leave the GUI running for visual verification.
        if (commandLine.contains ("--demo3"))
            juce::MessageManager::callAsync ([this] { runPluginDemo (*moshOps); });
        if (commandLine.contains ("--demo4"))
            juce::MessageManager::callAsync ([this] { runNeuralDemo (*moshOps); });
    }

    void shutdown() override
    {
        mainWindow.reset();
        moshOps.reset();
        engine.reset();
    }

    void systemRequestedQuit() override { quit(); }

private:
    std::unique_ptr<MoshEngine> engine;
    std::unique_ptr<MoshOps>    moshOps;
    std::unique_ptr<MainWindow> mainWindow;
};

} // namespace mosh

START_JUCE_APPLICATION (mosh::MoshApplication)
