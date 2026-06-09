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
    /** @param openAudioDevice  open the real CoreAudio device for playback.
        Headless runs (--selftest) and screenshots during a wedged audio HAL pass
        false (also forced off by the MOSH_NO_AUDIO env var) — the command surface
        and direct DSP need no device, and device init can block on CoreAudio.
        @param freshSession  use an isolated session dir and always start from a
        cold empty Edit. The --selftest harness passes true so it is idempotent
        (it saves/reloads internally) and never collides with the GUI session. */
    explicit MoshEngine (bool openAudioDevice = true, bool freshSession = false);
    ~MoshEngine();

    te::Engine& engine() { return *enginePtr; }
    te::Edit&   edit()   { return *editPtr; }            // always fetch fresh (survives reload)
    bool        hasAudio() const { return audioOpen; }
    juce::String audioDeviceError() const { return audioError; }

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

    /** Project lifecycle (wave: settings). Each replaces the live Edit object, so
        callers must re-read edit() and refetch any cached track/clip pointers
        afterwards. They are machine/whole-Edit operations — NOT undoable. The
        transport is stopped + the playback context freed before the swap to avoid
        device/Edit-mismatch asserts (matches the export render-exclusivity dance).
        editPath + editFileRetriever are re-pointed to the new file. */
    void newProject (const juce::File& file);   // save current, then a fresh empty Edit at file
    void openProject (const juce::File& file);  // save current, then load the Edit at file
    bool saveProjectAs (const juce::File& file); // saveAs to file + adopt it as the backing file

    /** Re-point editPath + editFileRetriever to file (after a saveAs that changed
        the Edit's backing file). Does NOT replace the Edit object. */
    void adoptEditFile (const juce::File& file);

private:
    std::unique_ptr<te::Engine> enginePtr;
    std::unique_ptr<te::Edit>   editPtr;
    juce::File session;
    juce::File editPath;
    void applyRequestedAudioOutputDevice();
    bool       audioOpen = false;
    bool       inputsConfigured = false;   // one-time wave-input enablement latch (audio-only)
    juce::String audioError;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshEngine)
};

} // namespace mosh
