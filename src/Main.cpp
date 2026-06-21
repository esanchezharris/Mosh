#include <juce_gui_extra/juce_gui_extra.h>
#include <tracktion_engine/tracktion_engine.h>
#include "app/MainWindow.h"
#include "app/MenuController.h"
#include "app/SelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "remote/RemoteCompanionServer.h"
#include "brain/BrainProxy.h"
#include <iostream>
#include <thread>

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
        const bool scanDeep = commandLine.contains ("--scan-plugins-deep");
        const bool runScript = commandLine.contains ("--run-script");   // headless batch command runner
        const bool voiceSmoke = commandLine.contains ("--voice-smoke"); // headless speech-to-text smoke
        const bool liveAudio = liveAudioSmoke || neuralAB;   // opens the real device, fresh cold session
        const bool headless = undoSelfTest || commandLine.contains ("--selftest");
        const bool noAudio = headless || scanDeep || runScript || voiceSmoke;  // device-free harnesses + scan/script/voice utilities

        // SCAN GUARD (tier wall): a deep scan must NEVER warm the generative service.
        // Force MOSH_ENABLE_SA3=0 for THIS process BEFORE MoshOps (and thus jobManager)
        // is constructed below, so a scan can never spawn/warm SA3. (MOSH_SCAN_AU opts
        // the AU sweep in — a deep scan is the full VST3 + AU catalog.)
        if (scanDeep)
        {
            setenv ("MOSH_ENABLE_SA3", "0", 1);
            setenv ("MOSH_SCAN_AU", "1", 1);
        }

        juce::String freshSessionName = undoSelfTest ? "session-selftest-undo"
                                            : (neuralAB ? "session-neural-ab"
                                            : (liveAudioSmoke ? "session-live-audio-smoke"
                                            : (scanDeep ? "session-scan"
                                            : (runScript ? "session-run-script"
                                            : (voiceSmoke ? "session-voice-smoke"
                                                              : "session-selftest")))));
        // Concurrent harness runs (e.g. parallel git worktrees each looping
        // --selftest) otherwise share the global session-selftest dir + freshSession
        // wipes it at startup, so one run clobbers another mid-test. MOSH_SELFTEST_SESSION
        // overrides the leaf so each run gets a private session dir (pair with a
        // distinct MOSH_SERVICE_PORT for full isolation). Only honored for headless
        // harnesses, which already use a freshSession.
        if (headless || runScript || voiceSmoke)
            if (const auto s = juce::SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {});
                s.trim().isNotEmpty())
                freshSessionName = s.trim();

        // Headless: no audio device, and an isolated cold session so the harness is
        // idempotent (it saves/reloads itself) and never touches the GUI session.
        engine  = std::make_unique<MoshEngine> ((! noAudio) || liveAudio,
                                                /*freshSession=*/ noAudio || liveAudio,
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

        // Headless deep plugin catalog sweep (terminal utility) — runs the hardened
        // out-of-process VST3 + AU scan with the hang-watchdog, prints the catalog +
        // quarantine list, and exits. Never builds the UI.
        //
        // The scan runs on a BACKGROUND thread and we RETURN (don't quit) so the JUCE
        // message loop keeps pumping — te's out-of-process child scanner is driven via
        // the message thread, so blocking it here would force in-process scanning and a
        // hostile plugin (NSWindow-on-load) would crash us off the main thread. On
        // completion the worker hops back to the message thread to print + quit.
        if (scanDeep)
        {
            std::thread ([this]
            {
                const int rc = runDeepPluginScan (*moshOps);
                juce::MessageManager::callAsync ([this, rc]
                {
                    setApplicationReturnValue (rc);
                    quit();
                });
            }).detach();
            return;
        }

        // Headless batch command runner (`Mosh --run-script`): execute a JSONL command
        // script against this isolated session, then exit. Composed with export_audio,
        // this drives the offline render-to-WAV verification harness. noAudio above, so
        // export_audio renders the chain offline (no device needed).
        if (runScript)
        {
            const int rc = runCommandScript (*engine, *moshOps);
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

        // Headless speech-to-text smoke (`Mosh --voice-smoke`): synthesize a phrase
        // with `say`, transcribe it via SFSpeechRecognizer, assert the text. Needs only
        // a one-time Speech grant (FILE mode); MOSH_VOICE_SMOKE_MIC=1 drives the live
        // mic path (pair with a BlackHole input for a reliable digital loopback).
        if (voiceSmoke)
        {
            const int rc = runVoiceSmoke (*engine, *moshOps);
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

        // Native macOS menu bar (File + Edit). It only forwards intents to the WebView
        // over the bridge event channel — the UI's runAction dispatcher turns each into
        // the matching MoshOps command (one definition of every command). The Recent
        // submenu reads the live session snapshot. (GUI only — never in headless runs.)
        auto* bridgePtr = &bridge;
        menuController = std::make_unique<MenuController> (
            [bridgePtr] (const juce::var& action) { bridgePtr->emitEvent (juce::Identifier ("mosh_menu"), action); },
            [this]() -> juce::var
            {
                return moshOps != nullptr
                     ? moshOps->snapshot().getProperty ("session", juce::var()).getProperty ("recentProjects", juce::var())
                     : juce::var();
            });

        moshOps->setEventSink ([&bridge, this] (const juce::var& e)
                               {
                                   bridge.emitEvent (juce::Identifier ("mosh_event"), e);
                                   if (remoteServer != nullptr)
                                       remoteServer->pushEvent (e);
                                   // Keep the File ▸ Open Recent submenu fresh after any
                                   // structural change (open/save-as/new updates the list).
                                   if (menuController != nullptr
                                       && e.getProperty ("type", {}).toString() == "snapshot_invalidated")
                                       menuController->refresh();
                               });
        mainWindow->shell().load();

        // gap 1 — periodic auto-save once the GUI is live: every 30s, persist iff the
        // Edit is dirty, so a window-close or crash never loses more than ~30s of work.
        // Save-on-quit (shutdown) is the belt-and-suspenders. GUI-only — headless
        // harnesses return/quit before reaching here, so the timer is never armed.
        autoSave.onTick = [this] { if (engine != nullptr) engine->saveIfDirty(); };
        autoSave.startTimer (30000);

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
        autoSave.stopTimer();
        // gap 1 — save-on-quit: persist any unsaved work before teardown (GUI only;
        // headless harnesses have no mainWindow and manage their own isolated session).
        if (engine != nullptr && mainWindow != nullptr)
            engine->saveIfDirty();
        menuController.reset();   // tears down the macOS main menu before the window
        mainWindow.reset();
        remoteServer.reset();
        moshOps.reset();
        engine.reset();
    }

    void systemRequestedQuit() override { quit(); }

private:
    // GUI-only periodic auto-save (gap 1). Lambda-driven juce::Timer; armed after the
    // window loads, stopped + flushed in shutdown().
    struct AutoSaveTimer : juce::Timer
    {
        std::function<void()> onTick;
        void timerCallback() override { if (onTick) onTick(); }
    };

    std::unique_ptr<MoshEngine> engine;
    std::unique_ptr<MoshOps>    moshOps;
    std::unique_ptr<RemoteCompanionServer> remoteServer;
    std::unique_ptr<MainWindow> mainWindow;
    std::unique_ptr<MenuController> menuController;
    AutoSaveTimer autoSave;
};

} // namespace mosh

START_JUCE_APPLICATION (mosh::MoshApplication)
