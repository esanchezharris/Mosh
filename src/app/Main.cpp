#include <juce_gui_basics/juce_gui_basics.h>
#include "MainWindow.h"
#include "DslExecutor.h"
#include "JsonlLog.h"
#include "MoshEngine.h"
#include "EngineSnapshot.h"
#include "EngineHandlers.h"
#include "PluginCommands.h"

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

            // The JSONL semantic log lives next to the edit file.
            log = std::make_unique<JsonlLog>();
            log->setFile (engine->getEditFile().getParentDirectory().getChildFile ("mosh-session.jsonl"));

            // MoshOps over THE engine's UndoManager — one undo system (02).
            executor = std::make_unique<DslExecutor> (engine->getUndoManager(), log.get());
            snapshotSource = std::make_unique<EngineSnapshotSource> (*engine);
            executor->setSnapshotSource (snapshotSource.get());
            registerEngineHandlers (*executor, *engine);
            registerPluginCommands (*executor, *engine);

            mainWindow = std::make_unique<MainWindow> ("Mosh", *executor);
        }

        void shutdown() override
        {
            mainWindow.reset();
            executor.reset();
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
        std::unique_ptr<MainWindow> mainWindow;
    };
}

START_JUCE_APPLICATION (mosh::MoshApplication)
