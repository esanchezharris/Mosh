#include <juce_gui_basics/juce_gui_basics.h>
#include "MainWindow.h"
#include "DslExecutor.h"
#include "JsonlLog.h"

// ──────────────────────────────────────────────────────────────────────────────
// Mosh — application entry point. Bootstraps the MoshOps spine and the WebView
// shell. Stage 0: the executor is backed by a standalone juce::UndoManager + an
// empty snapshot (the placeholder UI renders "backend: juce" and a cold snapshot).
//
// Stage 1 replaces this with the Tracktion Engine bootstrap (01): one Engine for
// the app lifetime, an Edit, edit.getUndoManager() as the undo implementation, and
// Tracktion-bound command handlers + a snapshot source that walks the Edit. The
// WebView/UI do not change — they couple only to the command surface + feed.
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
            // The MoshOps spine. (Stage 1: swap `undo` for edit.getUndoManager()
            // and register the Tracktion-bound handlers + snapshot source.)
            log = std::make_unique<JsonlLog>();
            executor = std::make_unique<DslExecutor> (undo, log.get());

            mainWindow = std::make_unique<MainWindow> ("Mosh", *executor);
        }

        void shutdown() override
        {
            mainWindow.reset();
            executor.reset();
            log.reset();
        }

        void systemRequestedQuit() override { quit(); }

    private:
        juce::UndoManager undo;                        // Stage 1 → edit.getUndoManager()
        std::unique_ptr<JsonlLog> log;
        std::unique_ptr<DslExecutor> executor;
        std::unique_ptr<MainWindow> mainWindow;
    };
}

START_JUCE_APPLICATION (mosh::MoshApplication)
