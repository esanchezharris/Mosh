#include <juce_gui_basics/juce_gui_basics.h>
#include "MainWindow.h"
#include "DslExecutor.h"
#include "JsonlLog.h"
#include "MoshEngine.h"
#include "EngineSnapshot.h"
#include "EngineHandlers.h"
#include "PluginCommands.h"
#include "NeuralCommands.h"
#include "GenerativeEngine.h"
#include "AsyncRenderPool.h"
#include "HttpBridge.h"

#ifndef MOSH_SERVICE_DIR
 #define MOSH_SERVICE_DIR ""   // set by CMake; empty → resolve next to the exe
#endif

// ──────────────────────────────────────────────────────────────────────────────
// Mosh — application entry point. Bootstraps the Tracktion Engine (01), the MoshOps
// spine (02) wired to edit.getUndoManager() as the single undo implementation, the
// Tracktion-bound command handlers + a snapshot source that walks the Edit, and the
// WebView shell (03). The WebView/UI couple only to the command surface + feed.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class MoshApplication : public juce::JUCEApplication
    {
    public:
        const juce::String getApplicationName() override    { return "Mosh"; }
        const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
        bool moreThanOneInstanceAllowed() override          { return false; }

        void initialise (const juce::String&) override
        {
            engine = std::make_unique<MoshEngine>();

            // PC build: open a default audio OUTPUT so transport playback is audible
            // on Windows (WASAPI/DirectSound via JUCE). App-only (tests never open a
            // real device). Guarded; MOSH_NO_AUDIO=1 skips it.
            if (juce::SystemStats::getEnvironmentVariable ("MOSH_NO_AUDIO", {}).isEmpty())
            {
                auto& dm = engine->getEngine().getDeviceManager();
                if (dm.deviceManager.getCurrentAudioDevice() == nullptr)
                    dm.initialise (0, 2);   // 0 inputs, stereo out — playback-focused
            }

            // The JSONL semantic log lives next to the edit file.
            log = std::make_unique<JsonlLog>();
            log->setFile (engine->getEditFile().getParentDirectory().getChildFile ("mosh-session.jsonl"));

            // MoshOps over THE engine's UndoManager — one undo system (02).
            executor = std::make_unique<DslExecutor> (engine->getUndoManager(), log.get());
            snapshotSource = std::make_unique<EngineSnapshotSource> (*engine);
            executor->setSnapshotSource (snapshotSource.get());
            registerEngineHandlers (*executor, *engine);
            registerPluginCommands (*executor, *engine);
            registerNeuralCommands (*executor, *engine);

            // Tier-B generative (05) — out-of-process job service (TIER WALL: Tier B is
            // a job, never an in-process insert). The manager spawns service/server.py
            // (FakeAdapter by default) on the first render; renders land NON-DESTRUCTIVELY.
            {
                juce::File serviceDir { juce::String (MOSH_SERVICE_DIR) };
                if (! serviceDir.isDirectory())
                    serviceDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                                     .getParentDirectory().getChildFile ("service");
                jobs = std::make_unique<GenerativeJobManager> (serviceDir);
                // The async pool runs renders OFF the message thread so the real model
                // (seconds-to-minutes) never freezes the UI / wedges the HttpBridge.
                renderPool = std::make_unique<AsyncRenderPool> (*executor, *jobs, renderCache);
                registerGenerativeEngineCommands (*executor, *engine, *jobs, renderCache, renderPool.get());
            }

            // HTTP transport for the MoshOps seam — lets a PLAIN BROWSER drive the
            // real backend (the WebView2 backend is broken on Windows; see STATUS).
            // Serves the staged UI bundle + /api/* on MOSH_HTTP_PORT (default 8080).
            {
                const int httpPort = juce::SystemStats::getEnvironmentVariable ("MOSH_HTTP_PORT", "8080").getIntValue();
                auto uiStaged = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                                    .getParentDirectory().getChildFile ("ui");
                httpBridge = std::make_unique<HttpBridge> (*executor, uiStaged, httpPort);
            }

            mainWindow = std::make_unique<MainWindow> ("Mosh", *executor,
                [this] { return httpBridge != nullptr && httpBridge->isUiConnected(); });
        }

        void shutdown() override
        {
            mainWindow.reset();
            httpBridge.reset();        // stop accepting new commands
            renderPool.reset();        // JOIN the worker BEFORE its collaborators die
            executor.reset();          // drops command lambdas (which ref jobs/renderCache)
            jobs.reset();              // kill the generative service if we started it
            snapshotSource.reset();
            log.reset();
            engine.reset();
        }

        void systemRequestedQuit() override { quit(); }

    private:
        std::unique_ptr<MoshEngine> engine;
        std::unique_ptr<JsonlLog> log;
        std::unique_ptr<DslExecutor> executor;
        std::unique_ptr<EngineSnapshotSource> snapshotSource;
        RenderCache renderCache;                          // Tier-B reuse by full fingerprint
        std::unique_ptr<GenerativeJobManager> jobs;       // out-of-process render service
        std::unique_ptr<AsyncRenderPool> renderPool;      // off-thread render worker
        std::unique_ptr<HttpBridge> httpBridge;
        std::unique_ptr<MainWindow> mainWindow;
    };
}

START_JUCE_APPLICATION (mosh::MoshApplication)
