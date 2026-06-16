#include <juce_gui_extra/juce_gui_extra.h>
#include <tracktion_engine/tracktion_engine.h>
#include "app/MainWindow.h"
#include "app/SelfTest.h"
#include "app/AgentServer.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "remote/RemoteCompanionServer.h"
#include "brain/BrainProxy.h"
#include <iostream>

namespace mosh
{
namespace te = tracktion::engine;

namespace
{
    // Non-interactive live brain round-trip — the command-line smoke for the native
    // brain_chat proxy. Resolves the provider from the env and prints the reply (or a
    // clean error). Returns 0 on a successful round-trip, 1 otherwise.
    int runBrainSmoke()
    {
        const auto prompt = juce::SystemStats::getEnvironmentVariable (
            "MOSH_BRAIN_SMOKE_PROMPT", "Greet me as Moshi in one short, upbeat line.");
        // Optional provider override for the smoke (so all three can be demoed without
        // touching MOSHI_BRAIN_PROVIDER, which .env.local sets). Empty → default pick.
        const auto requested = juce::SystemStats::getEnvironmentVariable ("MOSH_BRAIN_SMOKE_PROVIDER", {});

        juce::Array<juce::var> messages;
        auto* sys = new juce::DynamicObject();
        sys->setProperty ("role", "system");
        sys->setProperty ("content",
            "You are Moshi, a friendly in-app music collaborator. Reply ONLY with a "
            "compact JSON object of the form {\"say\": \"<one short line>\"}. JSON only.");
        messages.add (juce::var (sys));
        auto* usr = new juce::DynamicObject();
        usr->setProperty ("role", "user");
        usr->setProperty ("content", prompt);
        messages.add (juce::var (usr));

        const auto chosen = BrainProxy::resolve (requested);
        std::cerr << "brain-smoke: provider="
                  << (chosen.isComplete() ? chosen.id.toStdString() : std::string ("<none configured>"))
                  << "  model=" << chosen.model.toStdString()
                  << "\n             prompt=\"" << prompt.toStdString() << "\"" << std::endl;

        const auto r  = BrainProxy::chat (juce::var (messages), requested);
        const bool ok = (bool) r.getProperty ("ok", false);
        if (ok)
            std::cerr << "  OK  [" << r.getProperty ("provider", {}).toString().toStdString() << "/"
                      << r.getProperty ("model", {}).toString().toStdString() << "  "
                      << (int) r.getProperty ("ms", 0) << "ms]\n"
                      << "  content: " << r.getProperty ("content", {}).toString().toStdString() << std::endl;
        else
            std::cerr << "  FAIL: " << r.getProperty ("error", {}).toString().toStdString() << std::endl;
        return ok ? 0 : 1;
    }
}

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
        //
        // SCAN GUARD (tier wall): a scan path must NEVER reach the generative
        // GenerativeJobManager / the SA3 service. This child returns here BEFORE
        // MoshOps (and thus jobManager) is ever constructed, so plugin scanning is
        // structurally isolated from generative job orchestration. If a deep-scan CLI
        // entry (e.g. "--scan-plugins-deep") is ever (re)introduced, it MUST likewise
        // early-return before constructing MoshOps, and force MOSH_ENABLE_SA3=0 for
        // that process, so a scan can never warm SA3. (The in-session rescan_plugins
        // command runs on the message thread and also never touches jobManager — see
        // MoshOps::cmdRescanPlugins / PluginHost::rescan.)
        if (te::PluginManager::startChildProcessPluginScan (commandLine))
            return;

        // Non-interactive live brain round-trip (no engine/audio needed). Proves the
        // native brain_chat path end-to-end against the real provider resolved from
        // the environment. Prompt overridable via MOSH_BRAIN_SMOKE_PROMPT.
        if (commandLine.contains ("--brain-smoke"))
        {
            setApplicationReturnValue (runBrainSmoke());
            quit();
            return;
        }

        const bool undoSelfTest = commandLine.contains ("--selftest-undo");
        const bool liveAudioSmoke = commandLine.contains ("--live-audio-smoke");
        const bool neuralAB = commandLine.contains ("--neural-ab");
        const bool agentServer = commandLine.contains ("--agent-server");
        const bool liveAudio = liveAudioSmoke || neuralAB;   // opens the real device, fresh cold session
        const bool headless = undoSelfTest || agentServer || commandLine.contains ("--selftest");
        const juce::String freshSessionName = undoSelfTest ? "session-selftest-undo"
                                            : (agentServer ? "session-agent-server"
                                            : (neuralAB ? "session-neural-ab"
                                            : (liveAudioSmoke ? "session-live-audio-smoke"
                                                              : "session-selftest")));
        // Headless: no audio device, and an isolated cold session so the harness is
        // idempotent (it saves/reloads itself) and never touches the GUI session.
        engine  = std::make_unique<MoshEngine> ((! headless) || liveAudio,
                                                /*freshSession=*/ headless || liveAudio,
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

        // Headless agent driver: external harness drives the real engine over stdin.
        if (agentServer)
        {
            const int rc = runAgentServer (*engine, *moshOps);
            setApplicationReturnValue (rc);
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

        if (neuralAB)
        {
            const int rc = runNeuralAB (*engine, *moshOps);
            setApplicationReturnValue (rc);
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
