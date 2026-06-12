#include <juce_gui_extra/juce_gui_extra.h>
#include <tracktion_engine/tracktion_engine.h>
#include "app/MainWindow.h"
#include "app/SelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "remote/RemoteCompanionServer.h"

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
        const bool headless = undoSelfTest || commandLine.contains ("--selftest");
        const juce::String freshSessionName = undoSelfTest ? "session-selftest-undo"
                                            : (liveAudioSmoke ? "session-live-audio-smoke"
                                                              : "session-selftest");
        // Headless: no audio device, and an isolated cold session so the harness is
        // idempotent (it saves/reloads itself) and never touches the GUI session.
        engine  = std::make_unique<MoshEngine> ((! headless) || liveAudioSmoke,
                                                /*freshSession=*/ headless || liveAudioSmoke,
                                                freshSessionName);
        moshOps = std::make_unique<MoshOps> (*engine);
        remoteServer = std::make_unique<RemoteCompanionServer> (
            engine->sessionDir().getChildFile ("phone-takes"));
        remoteServer->setCommandHandler ([this] (const juce::var& cmd) { return moshOps->execute (cmd); });
        remoteServer->setSnapshotProvider ([this] { return moshOps->snapshot(); });

        // Design-lab feed (opt-in): MOSH_LAB_FEED=1 autostarts the companion server
        // with a stable token (MOSH_LAB_TOKEN, default "mosh-lab") and a 24h TTL so
        // the playground at localhost:5180 can poll transport/levels. Never in
        // headless/selftest runs.
        if (! headless
            && juce::SystemStats::getEnvironmentVariable ("MOSH_LAB_FEED", "0") == "1")
        {
            const auto labToken = juce::SystemStats::getEnvironmentVariable ("MOSH_LAB_TOKEN", "mosh-lab");
            remoteServer->startLabFeed (labToken);
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
        bridge.setRemoteStartHandler ([this] (const juce::var& args) { return remoteServer->startPairing (args); });
        bridge.setRemoteStopHandler  ([this] (const juce::var&) { return remoteServer->stopServer(); });
        bridge.setRemoteStatusProvider ([this] { return remoteServer->status(); });
        moshOps->setEventSink ([&bridge, this] (const juce::var& e)
                               {
                                   bridge.emitEvent (juce::Identifier ("mosh_event"), e);
                                   if (remoteServer != nullptr)
                                       remoteServer->pushEvent (e);
                               });
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
        remoteServer.reset();
        moshOps.reset();
        engine.reset();
    }

    void systemRequestedQuit() override { quit(); }

private:
    std::unique_ptr<MoshEngine> engine;
    std::unique_ptr<MoshOps>    moshOps;
    std::unique_ptr<RemoteCompanionServer> remoteServer;
    std::unique_ptr<MainWindow> mainWindow;
};

} // namespace mosh

START_JUCE_APPLICATION (mosh::MoshApplication)
