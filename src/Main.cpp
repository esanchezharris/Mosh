#include <juce_gui_extra/juce_gui_extra.h>
#include <tracktion_engine/tracktion_engine.h>
#include "app/MainWindow.h"
#include "app/InstancePolicy.h"
#include "app/MacStateRestoration.h"
#include "app/MenuController.h"
#include "app/SelfTest.h"
#include "engine/AudioDeviceStartup.h"
#include "engine/MoshEngine.h"
#include "engine/SessionPaths.h"
#include "moshops/MoshOps.h"
#include "remote/RemoteCompanionServer.h"
#include "brain/BrainProxy.h"
#include "telemetry/CrashHandler.h"
#include "util/Env.h"
#include <csignal>
#include <exception>
#include <iostream>
#include <thread>

namespace mosh
{
namespace te = tracktion::engine;

namespace
{
   #if JUCE_MAC || JUCE_LINUX
    volatile std::sig_atomic_t gracefulTerminationRequested = 0;

    void requestGracefulTermination (int) noexcept
    {
        gracefulTerminationRequested = 1;
    }

    void installGracefulTerminationHandler()
    {
        gracefulTerminationRequested = 0;
        struct sigaction action {};
        action.sa_handler = &requestGracefulTermination;
        sigemptyset (&action.sa_mask);
        action.sa_flags = 0;
        ::sigaction (SIGTERM, &action, nullptr);
    }

    bool consumeGracefulTerminationRequest() noexcept
    {
        if (gracefulTerminationRequested == 0)
            return false;
        gracefulTerminationRequested = 0;
        return true;
    }
   #else
    void installGracefulTerminationHandler() {}
    bool consumeGracefulTerminationRequest() noexcept { return false; }
   #endif

    juce::String valueAfter (
        const juce::StringArray& arguments,
        const juce::String& option)
    {
        const auto index = arguments.indexOf (option);
        return index >= 0 && index + 1 < arguments.size()
            ? arguments[index + 1] : juce::String();
    }

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
    bool moreThanOneInstanceAllowed() override
    {
        return mosh::instancepolicy::allowsMultipleInstances (getCommandLineParameterArray());
    }

    void initialise (const juce::String& commandLine) override
    {
        // Crash/telemetry module (src/telemetry/, opt-in, privacy-respecting — see
        // docs/telemetry/PRIVACY.md). Installed as the very first statement so it
        // covers as much of the app's lifetime as possible. This is the ONE line
        // that module owns in Main.cpp.
        mosh::telemetry::installCrashHandler();

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

        const auto commandLineParameters =
            juce::JUCEApplicationBase::getCommandLineParameterArray();
        if (! commandLineParameters.isEmpty()
            && commandLineParameters[0] == "--audio-probe")
        {
            const auto request = audiostartup::parseProbeRequest (
                commandLineParameters);
            if (! request.valid)
            {
                setApplicationReturnValue (2);
                quit();
                return;
            }
            const auto error = audiostartup::runProbeChild (request);
            std::cout << audiostartup::probeResultLine (request.nonce, error).toStdString();
            setApplicationReturnValue (error.isEmpty() ? 0 : 1);
            quit();
            return;
        }

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
        const bool goldenSelfTest = commandLine.contains ("--golden-selftest");
        const bool liveAudioSmoke = commandLine.contains ("--live-audio-smoke");
        const bool audioRecoverySmoke = commandLine.contains ("--audio-recovery-smoke");
        const bool scanDeep = commandLine.contains ("--scan-plugins-deep");
        const bool runScript = commandLine.contains ("--run-script");   // headless batch command runner
        const bool voiceSmoke = commandLine.contains ("--voice-smoke"); // headless speech-to-text smoke
        const bool demoGui = commandLine.contains ("--demo3")
                          || commandLine.contains ("--demo5")
                          || commandLine.contains ("--demo6");
        const bool envNoAudio = juce::SystemStats::getEnvironmentVariable ("MOSH_NO_AUDIO", "0") == "1";
        const bool liveAudio = liveAudioSmoke;   // opens the real device, fresh cold session
        const bool headless = undoSelfTest || goldenSelfTest
                           || commandLine.contains ("--selftest") || audioRecoverySmoke;
        const bool noAudio = envNoAudio
                          || (headless && ! audioRecoverySmoke)
                          || scanDeep || runScript || voiceSmoke;

        // SCAN GUARD (tier wall): a deep scan must NEVER warm the generative service.
        // Force MOSH_ENABLE_SA3=0 for THIS process BEFORE MoshOps (and thus jobManager)
        // is constructed below, so a scan can never spawn/warm SA3. (MOSH_SCAN_AU opts
        // the AU sweep in — a deep scan is the full VST3 + AU catalog.)
        if (scanDeep)
        {
            mosh::setEnvVar ("MOSH_ENABLE_SA3", "0");
            mosh::setEnvVar ("MOSH_SCAN_AU", "1");
        }

        // The session BASE leaf for this launch. MoshEngine turns it into the actual dir
        // (applying MOSH_SELFTEST_SESSION and per-process auto-isolation) — one place owns
        // that policy, see src/engine/SessionPaths.h.
        //
        // An empty base means "the interactive GUI", i.e. the owner's real "session" dir.
        // This ternary previously fell through to "session-selftest" for EVERY launch, and
        // #246 then inverted MoshEngine's precedence so that name won over the GUI leaf —
        // which quietly moved the interactive app into the very dir `--selftest` wipes with
        // deleteRecursively(). harnessSessionBase() keeps the GUI out of harness dirs, and
        // deliberately still hands a bare MOSH_NO_AUDIO=1 launch a harness base (it wipes,
        // so it must not land on "session").
        mosh::sessionpaths::HarnessModes modes;
        modes.selfTest       = commandLine.contains ("--selftest");   // also true for --selftest-undo
        modes.undoSelfTest   = undoSelfTest;                          // ...so undo is matched FIRST
        modes.goldenSelfTest = goldenSelfTest;
        modes.liveAudioSmoke = liveAudioSmoke;
        modes.scanDeep       = scanDeep;
        modes.runScript      = runScript;
        modes.voiceSmoke     = voiceSmoke;
        modes.demoGui        = demoGui;
        modes.envNoAudio     = envNoAudio;
        const juce::String sessionBaseName = audioRecoverySmoke
            ? "session-audio-recovery-smoke"
            : mosh::sessionpaths::harnessSessionBase (modes);

        // Any non-interactive CLI launch (no one to dismiss a dialog) must suppress
        // AppKit's window-restoration "reopen after crash" modal BEFORE the engine ctor
        // pumps the run loop — otherwise a repeated-crash history makes NSPersistentUIRestorer
        // block the run forever (see MacStateRestoration.h). No-op off macOS.
        if (noAudio || liveAudio || demoGui || audioRecoverySmoke)
            disableAppKitStateRestoration();

        // Headless: no audio device, and an isolated cold session so the harness is
        // idempotent (it saves/reloads itself) and never touches the GUI session.
        // A3: MOSH_RUNSCRIPT_KEEP_SESSION=1 opts a run-script out of the cold-session wipe so a
        // crash-recovery test can stage state in run 1 and recover it in run 2 (same dir).
        // REQUIRES an explicit MOSH_SELFTEST_SESSION (an isolated leaf) so a non-wiping run can
        // never land on — and clobber — the owner's GUI "session" dir.
        const bool keepSession = runScript
            && juce::SystemStats::getEnvironmentVariable ("MOSH_RUNSCRIPT_KEEP_SESSION", {}).trim() == "1"
            && juce::SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {}).trim().isNotEmpty();
        try
        {
            engine = std::make_unique<MoshEngine> ((! noAudio) || liveAudio,
                                                   /*freshSession=*/ (noAudio || liveAudio || demoGui
                                                                     || audioRecoverySmoke) && ! keepSession,
                                                   sessionBaseName);
        }
        catch (const std::exception& error)
        {
            std::cerr << "Mosh startup failed: " << error.what() << std::endl;
            setApplicationReturnValue (1);
            quit();
            return;
        }
        moshOps = std::make_unique<MoshOps> (*engine);
        const auto repairSourceSha = valueAfter (
            commandLineParameters, "--mosh-repair-source-sha");
        const auto repairId = valueAfter (
            commandLineParameters, "--mosh-repair-id");
        const auto rolledBackRepairId = valueAfter (
            commandLineParameters, "--mosh-rolled-back-repair-id");
        const auto rolledBackRepairBuild = valueAfter (
            commandLineParameters, "--mosh-rolled-back-repair-build");
        if (repairSourceSha.isEmpty() != repairId.isEmpty())
        {
            std::cerr << "repair launch refused: incomplete repair identity" << std::endl;
            setApplicationReturnValue (1);
            quit();
            return;
        }
        if (rolledBackRepairId.isEmpty() != rolledBackRepairBuild.isEmpty()
            || (repairId.isNotEmpty() && rolledBackRepairId.isNotEmpty()))
        {
            std::cerr << "repair launch refused: incomplete recovery identity" << std::endl;
            setApplicationReturnValue (1);
            quit();
            return;
        }
        if (repairSourceSha.isNotEmpty() && repairSourceSha != MOSH_BUILD_SHA)
        {
            std::cerr << "repair launch refused: source SHA does not match this build" << std::endl;
            setApplicationReturnValue (1);
            quit();
            return;
        }
        if (repairSourceSha.isNotEmpty())
        {
            mosh::setEnvVar ("MOSH_ACTIVE_REPAIR_SOURCE_SHA", repairSourceSha.toRawUTF8());
            mosh::setEnvVar ("MOSH_ACTIVE_REPAIR_ID", repairId.toRawUTF8());
        }
        if (rolledBackRepairId.isNotEmpty())
        {
            mosh::setEnvVar ("MOSH_ROLLED_BACK_REPAIR_ID", rolledBackRepairId.toRawUTF8());
            mosh::setEnvVar ("MOSH_ROLLED_BACK_REPAIR_BUILD_PATH", rolledBackRepairBuild.toRawUTF8());
        }
        const auto ownerCheckpoint = valueAfter (
            commandLineParameters, "--mosh-owner-checkpoint");
        if (ownerCheckpoint.isNotEmpty())
        {
            auto* args = new juce::DynamicObject();
            args->setProperty ("file", ownerCheckpoint);
            auto* command = new juce::DynamicObject();
            command->setProperty ("command", "open_project");
            command->setProperty ("args", juce::var (args));
            const auto result = moshOps->execute (juce::var (command));
            if (! (bool) result.getProperty ("ok", false))
            {
                std::cerr << "repair launch refused: checkpoint could not be opened" << std::endl;
                setApplicationReturnValue (1);
                quit();
                return;
            }
        }
        remoteServer = std::make_unique<RemoteCompanionServer> (
            engine->sessionDir().getChildFile ("phone-takes"));
        remoteServer->setCommandHandler ([this] (const juce::var& cmd) { return moshOps->execute (cmd); });
        remoteServer->setSnapshotProvider ([this] { return moshOps->snapshot(); });
        ownerControlServer = std::make_unique<RemoteCompanionServer> (
            engine->sessionDir().getChildFile ("owner-control"));
        ownerControlServer->setCommandHandler ([this] (const juce::var& cmd) { return moshOps->execute (cmd); });
        ownerControlServer->setSnapshotProvider ([this] { return moshOps->snapshot(); });

        if (audioRecoverySmoke)
        {
            auto probeTransportSurvivesArgv = [] (const juce::XmlElement* setup)
            {
                const auto result = audiostartup::runProbeProcess (
                    audiostartup::probeChildArguments (
                        juce::File::getSpecialLocation (juce::File::currentExecutableFile),
                        juce::Uuid().toString(),
                        setup,
                        2,
                        2,
                        60000),
                    audiostartup::kMinTimeoutMs);
                return result.status == audiostartup::ProbeProcessStatus::timedOut;
            };

            juce::XmlElement outputOnlySetup ("DEVICESETUP");
            outputOnlySetup.setAttribute ("audioOutputDeviceName",
                                          "MacBook Pro Speakers");
            juce::XmlElement inputOnlySetup ("DEVICESETUP");
            inputOnlySetup.setAttribute ("audioInputDeviceName", "BlackHole 2ch");
            const bool defaultArgvRoundTrip = probeTransportSurvivesArgv (nullptr);
            const bool outputOnlyArgvRoundTrip =
                probeTransportSurvivesArgv (&outputOnlySetup);
            const bool inputOnlyArgvRoundTrip =
                probeTransportSurvivesArgv (&inputOnlySetup);

            auto execute = [this] (const juce::String& name)
            {
                auto* command = new juce::DynamicObject();
                command->setProperty ("command", name);
                return moshOps->execute (juce::var (command));
            };

            const auto firstListStarted = juce::Time::getMillisecondCounterHiRes();
            const auto firstList = execute ("list_audio_devices");
            const auto firstListElapsedMs =
                juce::Time::getMillisecondCounterHiRes() - firstListStarted;
            const auto firstData = firstList.getProperty ("data", juce::var());
            const auto firstTypes = firstData.getProperty ("types", juce::var());

            const auto retryStarted = juce::Time::getMillisecondCounterHiRes();
            const auto retry = execute ("retry_audio_device");
            const auto retryElapsedMs =
                juce::Time::getMillisecondCounterHiRes() - retryStarted;

            const auto secondListStarted = juce::Time::getMillisecondCounterHiRes();
            const auto secondList = execute ("list_audio_devices");
            const auto secondListElapsedMs =
                juce::Time::getMillisecondCounterHiRes() - secondListStarted;
            const auto secondData = secondList.getProperty ("data", juce::var());
            const auto secondTypes = secondData.getProperty ("types", juce::var());
            const auto retryError = retry.getProperty ("error", juce::var()).toString();
            const auto timeoutDeviceError = engine->audioDeviceError();

            const auto invalidSetupFile =
                engine->sessionDir().getChildFile ("audio-device.xml");
            const bool invalidSetupWritten =
                invalidSetupFile.replaceWithText ("<NOTDEVICE/>");
            const auto invalidRetryStarted =
                juce::Time::getMillisecondCounterHiRes();
            const auto invalidRetry = execute ("retry_audio_device");
            const auto invalidRetryElapsedMs =
                juce::Time::getMillisecondCounterHiRes() - invalidRetryStarted;
            const auto invalidRetryError =
                invalidRetry.getProperty ("error", juce::var()).toString();

            const bool pass = (bool) firstList.getProperty ("ok", false)
                           && defaultArgvRoundTrip
                           && outputOnlyArgvRoundTrip
                           && inputOnlyArgvRoundTrip
                           && ! (bool) firstData.getProperty ("audioEnabled", true)
                           && firstTypes.isArray() && firstTypes.getArray()->isEmpty()
                           && firstListElapsedMs < 1000.0
                           && ! (bool) retry.getProperty ("ok", true)
                           && retryError.contains ("did not open within")
                           && retryElapsedMs < 2000.0
                           && (bool) secondList.getProperty ("ok", false)
                           && ! (bool) secondData.getProperty ("audioEnabled", true)
                           && secondTypes.isArray() && secondTypes.getArray()->isEmpty()
                           && secondListElapsedMs < 1000.0
                           && timeoutDeviceError.contains ("did not open within")
                           && invalidSetupWritten
                           && ! (bool) invalidRetry.getProperty ("ok", true)
                           && invalidRetryElapsedMs < audiostartup::kMinTimeoutMs
                           && invalidRetryError.contains ("invalid or too large")
                           && engine->audioDeviceError().contains ("invalid or too large")
                           && ! engine->hasAudio();

            auto* evidence = new juce::DynamicObject();
            evidence->setProperty ("pass", pass);
            evidence->setProperty ("defaultArgvRoundTrip", defaultArgvRoundTrip);
            evidence->setProperty ("outputOnlyArgvRoundTrip", outputOnlyArgvRoundTrip);
            evidence->setProperty ("inputOnlyArgvRoundTrip", inputOnlyArgvRoundTrip);
            evidence->setProperty ("audioEnabled",
                                   secondData.getProperty ("audioEnabled", true));
            evidence->setProperty ("deviceTypeCount",
                                   secondTypes.isArray() ? secondTypes.getArray()->size() : -1);
            evidence->setProperty ("firstListElapsedMs", firstListElapsedMs);
            evidence->setProperty ("retryOk", retry.getProperty ("ok", true));
            evidence->setProperty ("retryElapsedMs", retryElapsedMs);
            evidence->setProperty ("retryError", retryError);
            evidence->setProperty ("secondListElapsedMs", secondListElapsedMs);
            evidence->setProperty ("invalidSetupRetryOk",
                                   invalidRetry.getProperty ("ok", true));
            evidence->setProperty ("invalidSetupRetryElapsedMs",
                                   invalidRetryElapsedMs);
            evidence->setProperty ("invalidSetupRetryError", invalidRetryError);
            evidence->setProperty ("audioDeviceError", engine->audioDeviceError());
            std::cout << juce::JSON::toString (juce::var (evidence), false).toStdString()
                      << std::endl;
            setApplicationReturnValue (pass ? 0 : 1);
            quit();
            return;
        }

        // Design-lab feed (opt-in): MOSH_LAB_FEED=1 autostarts the companion server
        // with a stable token (MOSH_LAB_TOKEN, default "mosh-lab") and a 24h TTL so
        // the playground at localhost:5180 can poll transport/levels. Never in
        // headless/selftest runs.
        if (! headless
            && juce::SystemStats::getEnvironmentVariable ("MOSH_LAB_FEED", "0") == "1")
        {
            const auto labToken = juce::SystemStats::getEnvironmentVariable ("MOSH_LAB_TOKEN", "mosh-lab");
            // Log the outcome either way: a silently-discarded bind failure here is
            // indistinguishable from "MOSH_LAB_FEED never reached the process" (e.g. an
            // `open` launch drops env vars), which has already cost a live-verification
            // session a misdiagnosis (PR #267).
            const auto labResult = remoteServer->startLabFeed (labToken);
            if (labResult.getProperty ("ok", false))
                std::cerr << "MOSH_LAB_FEED: companion server listening on port "
                          << (int) labResult.getProperty ("data", {}).getProperty ("port", 0) << std::endl;
            else
                std::cerr << "MOSH_LAB_FEED: companion server FAILED to start: "
                          << labResult.getProperty ("error", {}).toString().toStdString() << std::endl;
        }

        // Headless command-surface harness (06 §4): `Mosh --selftest`.
        if (undoSelfTest)
        {
            const int fails = runUndoSelfTest (*engine, *moshOps);
            setApplicationReturnValue (fails);
            quit();
            return;
        }

        if (goldenSelfTest)
        {
            const int fails = runGoldenSelfTest (*engine, *moshOps);
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

        // Headless speech-to-text smoke (`Mosh --voice-smoke`): synthesize a phrase
        // with `say`, transcribe it via SFSpeechRecognizer, assert the text. Needs only
        // a one-time Speech grant (FILE mode); MOSH_VOICE_SMOKE_MIC=1 drives the live
        // mic path (pair with a BlackHole input for a reliable digital loopback).
        if (voiceSmoke)
        {
            // `--mic` selects loopback mode via the command line too, so an `open
            // --args --voice-smoke --mic` launch (which drops env vars but carries the
            // granted Mosh.app TCC identity) still reaches MIC mode.
            if (commandLine.contains ("--mic"))
                mosh::setEnvVar ("MOSH_VOICE_SMOKE_MIC", "1");
            const int rc = runVoiceSmoke (*engine, *moshOps);
            setApplicationReturnValue (rc);
            quit();
            return;
        }

        // The signed repair helper requests process handoff with SIGTERM. Convert
        // that asynchronous signal into an ordinary message-thread quit so JUCE's
        // shutdown path saves the project and clears the session-running sentinel.
        installGracefulTerminationHandler();
        mainWindow = std::make_unique<MainWindow> (getApplicationName());

        // Wire the swappable seam to the MoshOps spine (the ONLY backend coupling).
        auto& bridge = mainWindow->shell().bridge();
        bridge.setCommandHandler  ([this] (const juce::var& cmd) { return moshOps->execute (cmd); });
        bridge.setSnapshotProvider([this] { return moshOps->snapshot(); });
        bridge.setRemoteStartHandler ([this] (const juce::var& args) { return remoteServer->startPairing (args); });
        bridge.setRemoteStopHandler  ([this] (const juce::var&) { return remoteServer->stopServer(); });
        bridge.setRemoteStatusProvider ([this] { return remoteServer->status(); });
        bridge.setOwnerControlServer (ownerControlServer.get());
        // WP-11 best-of-n relays (brain traffic is UI-domain — same layering as
        // brain_chat, NOT MoshOps commands; the bridge runs these off-thread).
        bridge.setEscalateHandler ([this] (const juce::var& p) { return moshOps->escalateCandidates (p); });
        bridge.setArchivePairHandler ([this] (const juce::var& r)
        {
            auto* o = new juce::DynamicObject();
            o->setProperty ("ok", true);
            o->setProperty ("archived", moshOps->archiveDpoPair (r));
            return juce::var (o);
        });

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

        // A2 — write the liveness sentinel now the GUI is up. If we crash before shutdown()
        // deletes it, the next launch detects the unclean exit (uncleanAtStartup) and the UI
        // surfaces a recovery notice. Must come AFTER the engine ctor latched the prior value.
        if (engine != nullptr)
            engine->markSessionRunning();

        // gap 1 — periodic auto-save once the GUI is live: every 30s, persist iff the
        // Edit is dirty, so a window-close or crash never loses more than ~30s of work.
        // Save-on-quit (shutdown) is the belt-and-suspenders. GUI-only — headless
        // harnesses return/quit before reaching here, so the timer is never armed.
        autoSave.onTick = [this] { if (engine != nullptr) engine->saveIfDirty(); };
        autoSave.startTimer (30000);
        terminationWatch.onTick = []
        {
            if (consumeGracefulTerminationRequest())
                quit();
        };
        terminationWatch.startTimer (50);

        // Scripted Stage 3 demo: build a hosted-plugin session + open a native
        // editor, then leave the GUI running for visual verification.
        if (commandLine.contains ("--demo3"))
            juce::MessageManager::callAsync ([this] { runPluginDemo (*moshOps); });
        if (commandLine.contains ("--demo5"))
            juce::MessageManager::callAsync ([this] { runGenerativeDemo (*moshOps); });
        if (commandLine.contains ("--demo6"))
            juce::MessageManager::callAsync ([this] { runConsolidationDemo (*moshOps); });
    }

    void shutdown() override
    {
        terminationWatch.stopTimer();
        autoSave.stopTimer();
        // gap 1 — save-on-quit: persist any unsaved work before teardown (GUI only;
        // headless harnesses have no mainWindow and manage their own isolated session).
        if (engine != nullptr && mainWindow != nullptr)
        {
            engine->saveIfDirty();
            engine->clearSessionRunning();   // A2 — clean exit: drop the sentinel LAST (after the save)
        }
        menuController.reset();   // tears down the macOS main menu before the window
        mainWindow.reset();
        ownerControlServer.reset();
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
    std::unique_ptr<RemoteCompanionServer> ownerControlServer;
    std::unique_ptr<MainWindow> mainWindow;
    std::unique_ptr<MenuController> menuController;
    AutoSaveTimer autoSave;
    AutoSaveTimer terminationWatch;
};

} // namespace mosh

START_JUCE_APPLICATION (mosh::MoshApplication)
