#pragma once
#include <juce_data_structures/juce_data_structures.h>
#include "MoshCommand.h"
#include "MoshResult.h"
#include "MoshEvent.h"
#include "JsonlLog.h"
#include "SnapshotSource.h"
#include <functional>
#include <map>
#include <vector>

// ──────────────────────────────────────────────────────────────────────────────
// DslExecutor — MoshOps, the single mutation API (02 §1). One entry point:
//   MoshResult execute(const MoshCommand&)
// Each call: validate → begin a Tracktion undo transaction → mutate via the
// engine APIs → emit typed event(s) → append a JSONL line → return the envelope.
//
// The undo *implementation* is a juce::UndoManager — in the app this is exactly
// Tracktion's edit.getUndoManager() (one undo system, no shadow model). Handlers
// and the snapshot source are injected interfaces, so the entire command surface
// is testable with fakes (the "command-surface harness", 06 §4) — no Tracktion,
// no UI, no audio required.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class DslExecutor
    {
    public:
        // Context handed to each command handler.
        class Context
        {
        public:
            Context (DslExecutor& ex, juce::UndoManager& um) : executor (ex), undo (um) {}

            juce::UndoManager& undoManager() { return undo; }

            // Emit a typed event (forwarded to all listeners + the bridge). Handlers
            // emit only AFTER a successful mutation.
            void emit (const MoshEvent& e) { executor.emit (e); }

        private:
            DslExecutor& executor;
            juce::UndoManager& undo;
        };

        using Handler = std::function<MoshResult (const MoshCommand&, Context&)>;

        DslExecutor (juce::UndoManager& undoManagerToUse, JsonlLog* logToUse = nullptr)
            : undo (undoManagerToUse), log (logToUse)
        {
            registerBuiltins();
        }

        // Register a command. `transactional=false` skips the transaction wrapping
        // (used by built-in undo/redo, which operate the stack rather than mutate).
        void registerCommand (juce::String name, Handler handler, bool transactional = true);
        bool hasCommand (const juce::String& name) const { return handlers.count (name) > 0; }
        juce::StringArray commandNames() const;

        // The single entry point.
        MoshResult execute (const MoshCommand& cmd);
        MoshResult execute (const juce::String& name, juce::var args = juce::var())
        {
            return execute (MoshCommand (name, std::move (args)));
        }

        // Read side.
        void setSnapshotSource (SnapshotSource* s) { snapshotSource = s; }
        juce::var getSnapshot();

        // Event subscription (the bridge registers one listener; tests register
        // their own). Telemetry taps may call emit() directly (decimated upstream).
        void addListener (MoshEventListener* l);
        void removeListener (MoshEventListener* l);
        void emit (const MoshEvent& e);

        JsonlLog* getLog() { return log; }
        void setLog (JsonlLog* l) { log = l; }

    private:
        struct Entry { Handler handler; bool transactional; };

        void registerBuiltins();

        juce::UndoManager& undo;
        JsonlLog* log = nullptr;
        SnapshotSource* snapshotSource = nullptr;
        std::map<juce::String, Entry> handlers;
        std::vector<MoshEventListener*> listeners;
    };
}
