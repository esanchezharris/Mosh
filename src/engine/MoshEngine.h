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
        (it saves/reloads internally) and never collides with the GUI session.
        @param freshSessionName  optional isolated-session folder for distinct
        headless harnesses that must not overwrite each other's evidence. */
    explicit MoshEngine (bool openAudioDevice = true, bool freshSession = false,
                         const juce::String& freshSessionName = {});
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

    /** Unsaved-changes flag (data-safety, gap 1). Every MoshOps mutation marks the
        Edit dirty; save()/saveIfDirty() clear it; new/open/reload/saveAs leave it
        clean (the Edit was just persisted to / loaded from disk). Drives the GUI
        periodic auto-save timer + save-on-quit so closing the window never loses work. */
    void markDirty();
    bool isDirty() const;
    bool saveIfDirty();          // save() iff dirty; returns true iff a save happened

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

    /** gap 2 — reopen the last project on relaunch. rememberProject persists the
        current project path + a recent list to session/last-project.json on every
        new/open/save-as; startupEditFile() (called by the ctor) resolves the edit to
        open at launch (the remembered project, or session.tracktionedit when none /
        the remembered file is missing); recentProjects() is the existing-file Recent
        list for the UI (newest-first). */
    void       rememberProject (const juce::File& file);
    juce::File startupEditFile() const;
    juce::var  recentProjects() const;

    /** Re-point editPath + editFileRetriever to file (after a saveAs that changed
        the Edit's backing file). Does NOT replace the Edit object. */
    void adoptEditFile (const juce::File& file);

    /** PRF-001 — multicore audio processing preference + readout. Tracktion's
        parallel playback/render graph derives its worker-thread count from exactly
        one knob: EngineBehaviour::getNumberOfCPUsToUseForAudio() (applied as
        setNumThreads(N-1)). MoshEngineBehaviour overrides it to honour a runtime
        preference, so this is a GENUINE, load-bearing control — not a dead toggle.

        availableCores()        — logical cores the engine sees (>= 1).
        audioThreadPref()       — the raw stored preference (0 == auto/all cores).
        effectiveAudioThreads() — the resolved value the engine actually uses now
                                  (== availableCores() when auto).
        setAudioThreadPref(n)   — store the preference (0 = auto, else clamped to
                                  [1..availableCores()]) and re-apply LIVE to any
                                  open playback context via DeviceManager::updateNumCPUs()
                                  (no playback restart; offline renders pick it up on
                                  their next construction). Headless: stores only. */
    int  availableCores()        const;
    int  audioThreadPref()       const;
    int  effectiveAudioThreads() const;
    void setAudioThreadPref (int n);

private:
    std::unique_ptr<te::Engine> enginePtr;
    std::unique_ptr<te::Edit>   editPtr;
    // Borrowed (non-owning) pointer to the MoshEngineBehaviour the Engine owns —
    // typed as the base here because the concrete type is anonymous-namespace-local
    // to MoshEngine.cpp. Lets the PRF-001 accessors mutate its audioThreads atomic.
    te::EngineBehaviour*        behaviourPtr = nullptr;
    juce::File session;
    juce::File editPath;
    void applyRequestedAudioOutputDevice();
    void wireEditResolvers();                                  // gap 3 — editFileRetriever + filePathResolver
    void consolidateAudioInto (const juce::File& projectDir);  // gap 3 — copy referenced audio project-local
    bool       audioOpen = false;
    bool       dirty = false;              // unsaved-changes flag (gap 1)
    bool       inputsConfigured = false;   // one-time wave-input enablement latch (audio-only)
    juce::String audioError;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshEngine)
};

} // namespace mosh
