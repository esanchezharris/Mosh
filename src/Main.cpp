#include <juce_gui_extra/juce_gui_extra.h>
#include <tracktion_engine/tracktion_engine.h>
#include <cstdlib>
#include "app/MainWindow.h"
#include "app/SelfTest.h"
#include "app/Harness.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "moshir/MoshIR.h"
#include "moshir/SessionRecorder.h"

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

        const bool undoSelfTest = commandLine.contains ("--selftest-undo");
        const bool liveAudioSmoke = commandLine.contains ("--live-audio-smoke");
        const bool harness = commandLine.contains ("--harness");
        const bool headless = undoSelfTest || harness || commandLine.contains ("--selftest");
        // Headless: no audio device, and an isolated cold session so the harness is
        // idempotent (it saves/reloads itself) and never touches the GUI session.
        engine  = std::make_unique<MoshEngine> ((! headless) || liveAudioSmoke,
                                                /*freshSession=*/ headless || liveAudioSmoke);
        moshOps = std::make_unique<MoshOps> (*engine);

        // MoshIR sits above MoshOps (phase0 §3): it lowers IR ops and feeds
        // them back through execute(), preserving the one mutation path.
        irExecutor = std::make_unique<ir::Executor> (*moshOps, *engine);
        moshOps->setIRHook ([this] (const juce::var& a) { return irExecutor->executeOps (a); });

        // The op logger / session recorder (phase0 §5) — always on, a product
        // feature; consent gates corpus entry, not recording. Headless runs
        // get an isolated identity so harness/selftest never touch the user's.
        if (headless && juce::SystemStats::getEnvironmentVariable ("MOSH_IDENTITY_FILE", {}).isEmpty())
            setenv ("MOSH_IDENTITY_FILE",
                    engine->sessionDir().getChildFile ("identity.json").getFullPathName().toRawUTF8(), 1);
        recorder = std::make_unique<ir::SessionRecorder> (*engine);
        moshOps->setCommandObserver ([this] (const juce::String& n, const juce::var& a, const juce::var& r)
                                     { recorder->afterCommand (n, a, r); });

        // Headless replay harness (phase0 §4): `Mosh --harness job.json`.
        if (harness)
        {
            const int code = runHarness (*engine, *moshOps, commandLine);
            setApplicationReturnValue (code);
            quit();
            return;
        }

        // Headless command-surface harness (06 §4): `Mosh --selftest`.
        if (undoSelfTest)
        {
            const int fails = runUndoSelfTest (*engine, *moshOps);
            setApplicationReturnValue (fails);
            quit();
            return;
        }

        if (headless)
        {
            const int fails = runSelfTest (*engine, *moshOps);
            setApplicationReturnValue (fails);
            quit();
            return;
        }

        if (liveAudioSmoke)
        {
            const int fails = runLiveAudioSmoke (*engine, *moshOps);
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
        mainWindow->shell().load();

        // Scripted Stage 3 demo: build a hosted-plugin session + open a native
        // editor, then leave the GUI running for visual verification.
        if (commandLine.contains ("--demo3"))
            juce::MessageManager::callAsync ([this] { runPluginDemo (*moshOps); });
        if (commandLine.contains ("--demo4"))
            juce::MessageManager::callAsync ([this] { runNeuralDemo (*moshOps); });
        if (commandLine.contains ("--demo5"))
            juce::MessageManager::callAsync ([this] { runGenerativeDemo (*moshOps); });
        if (commandLine.contains ("--demo6"))
            juce::MessageManager::callAsync ([this] { runConsolidationDemo (*moshOps); });
    }

    void shutdown() override
    {
        mainWindow.reset();
        recorder.reset();
        irExecutor.reset();
        moshOps.reset();
        engine.reset();
    }

    void systemRequestedQuit() override { quit(); }

private:
    std::unique_ptr<MoshEngine>          engine;
    std::unique_ptr<MoshOps>             moshOps;
    std::unique_ptr<ir::Executor>        irExecutor;
    std::unique_ptr<ir::SessionRecorder> recorder;
    std::unique_ptr<MainWindow>          mainWindow;
};

} // namespace mosh

START_JUCE_APPLICATION (mosh::MoshApplication)
