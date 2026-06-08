#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh
{
namespace te = tracktion::engine;

/** Owns the single te::Engine and the current te::Edit for the app lifetime
    (01 §1). Provides lifecycle + access only — it does NOT expose mutation to
    the UI. Every state change goes through a MoshOps command handler that calls
    these engine APIs inside an undo transaction (the one-mutation-path rule).

    The Edit's own UndoManager (edit.getUndoManager()) is the undo implementation
    under MoshOps — there is no second undo system. */
class MoshEngine
{
public:
    MoshEngine();
    ~MoshEngine();

    te::Engine& engine() { return *enginePtr; }
    te::Edit&   edit()   { return *editPtr; }            // always fetch fresh (survives reload)

    juce::File sessionDir() const { return session; }
    juce::File editFile()   const { return editPath; }

    /** Attach the Edit to the audio device so the transport can play (01 §5). */
    void ensurePlaybackContext();

    /** Generate a deterministic stereo test-tone WAV in the session audio dir
        (so the Stage 1 gate — "import_clip + audio loops" — needs no file picker
        or bundled asset). Returns the written file. */
    juce::File generateTestTone (double seconds, double freqHz, const juce::String& name);

    /** Save the Edit to its .tracktionedit file via EditFileOperations (01 §6). */
    bool save();

    /** Reload the Edit from its file (proves save/reload restore). Replaces the
        Edit object; callers must re-read edit() afterwards. */
    void reloadFromFile();

private:
    std::unique_ptr<te::Engine> enginePtr;
    std::unique_ptr<te::Edit>   editPtr;
    juce::File session;
    juce::File editPath;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshEngine)
};

} // namespace mosh
