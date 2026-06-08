#pragma once
#include <tracktion_engine/tracktion_engine.h>

// ──────────────────────────────────────────────────────────────────────────────
// MoshEngine — owns the single Tracktion Engine + the current Edit for the app
// lifetime (01 §1, §2.1). The Engine auto-initialises the audio device; the Edit's
// UndoManager (a juce::UndoManager&, confirmed v3.2.0) is THE undo implementation
// under MoshOps — no second undo system.
//
// Signatures verified against tracktion_engine v3.2.0 (see docs/TRACKTION_API_NOTES.md):
//   createEmptyEdit / loadEditFromFile (free fns), EditFileOperations::save,
//   edit.getTransport(), edit.getUndoManager() -> juce::UndoManager&.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    // Alias the umbrella namespace (NOT tracktion::engine): engine symbols are in
    // the inline `engine` namespace and the strong time types live in tracktion::core
    // — both are reachable as tracktion::* (matches the engine's own examples).
    namespace te = tracktion;

    class MoshEngine
    {
    public:
        MoshEngine();
        ~MoshEngine();

        te::Engine&           getEngine()       { return *engine; }
        te::Edit&             getEdit()         { return *edit; }
        juce::UndoManager&    getUndoManager()  { return edit->getUndoManager(); }
        te::TransportControl& getTransport()    { return edit->getTransport(); }
        juce::File            getEditFile() const { return editFile; }

        // Lifecycle. newEdit() replaces the current edit with a fresh empty one.
        void newEdit (juce::File file = {});
        bool load   (const juce::File&);
        bool save();                         // EditFileOperations(edit).save(false,true,false)
        bool saveAs (const juce::File&);

    private:
        static juce::File defaultEditFile();

        std::unique_ptr<te::Engine> engine;
        std::unique_ptr<te::Edit>   edit;
        juce::File                  editFile;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshEngine)
    };
}
