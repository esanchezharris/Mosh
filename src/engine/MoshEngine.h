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

    /** AUD-017 — was audio REQUESTED for this session? True for the GUI and the live
        audio harnesses, false for headless runs (and under MOSH_NO_AUDIO). hasAudio()
        can be false while this is true: that is the DEGRADED state — the device did
        not open within the bound — and it is the only state in which retryAudioDevice()
        touches hardware. Headless runs therefore stay hermetic by construction. */
    bool audioRequested() const { return audioWanted; }

    /** AUD-017 — re-attempt the bounded device open after a failed start (the user
        unplugged the offending interface, or restarted coreaudiod). Returns an empty
        string on success — audio is live, the playback context is allocated — and the
        failure reason otherwise. A no-op returning "" when audio is already up, and a
        hardware-free error when this session never wanted audio. */
    juce::String retryAudioDevice();

    /** AUD-017 follow-up — adopt a device that set_audio_device opened FROM the
        degraded state. applyAudioDeviceSetup goes through JUCE's
        AudioDeviceManager directly, so it can succeed while this engine still
        believes audio is dead; a successful pick from the Settings panel IS the
        recovery, and this flips the engine over (audioOpen, error cleared,
        playback context allocated) exactly like retryAudioDevice's success tail.
        A no-op when audio is already up; never called headless (the degraded
        state is unreachable there, by audioRequested()'s construction). */
    void adoptOpenedAudioDevice();

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
        Edit object; callers must re-read edit() afterwards. PRJ-FMT: returns a
        non-empty error if the on-disk file is a NEWER format than this build — in
        which case the CURRENT Edit is kept untouched and the caller surfaces the
        message; an empty return means success. */
    juce::String reloadFromFile();

    /** PRJ-FMT — the COLD-START project-format outcome. Empty ⇒ the launch Edit loaded
        fine. Non-empty ⇒ the session file on launch was made by a NEWER Mosh than this
        build: the load was REFUSED, the live Edit is a safe empty fallback backed by that
        newer file's path, and save() is a no-op until a different project is loaded — so
        we never clobber the newer file. Surfaced via snapshot.session.loadError. (A
        mid-session open/reload refusal does NOT latch this — the prior valid project stays
        loaded and saveable; that refusal rides the command result instead.) */
    juce::String projectLoadError() const { return loadError; }
    bool         hasProjectLoadError() const { return loadError.isNotEmpty(); }

    /** A2 — unclean-shutdown detection. The GUI writes a `session.running` sentinel after
        the window loads and deletes it last on a clean quit; if it is still present at the
        NEXT launch, the prior session crashed (e.g. an in-process plugin teardown). The
        latch is captured in the ctor BEFORE markSessionRunning() overwrites it. Headless
        harnesses use a wiped freshSession dir and never mark it, so they always read clean. */
    bool wasUncleanShutdown() const { return uncleanAtStartup; }
    void markSessionRunning();   // GUI: write the sentinel once the window is live
    void clearSessionRunning();  // GUI: delete the sentinel on clean shutdown (after the final save)

    /** FS-T2 — plugin-crash SAFE MODE.

        A third-party plugin that crashes while the project is being LOADED is unrecoverable
        by the normal path: every relaunch reopens the same project and re-crashes on the
        same plugin, so autosave + journal replay cannot help — the user never reaches a
        window. (This is the in-window mitigation for out-of-process hosting, which SPEC §2
        puts out of scope.)

        The lever is a breadcrumb that BRACKETS the load: before Tracktion instantiates
        anything we record which third-party plugins this project brings up; we delete the
        record the moment the load returns. A breadcrumb still on disk at the next launch
        therefore means the process died mid-load, and its contents name the candidates.
        `pluginCrashSuspects()` is that list, latched in the ctor before this run overwrites
        it — exactly like the `session.running` sentinel it complements.

        Note the deliberate limit: the breadcrumb brackets the WHOLE load, so a project with
        several plugins leaves several candidates and we cannot say which one crashed. Safe
        mode skips them ALL (that is the user-facing promise); blocklisting is reserved for a
        lone, unambiguous suspect (mosh::safemode::quarantineTarget). */
    juce::StringArray pluginCrashSuspects() const { return pluginSuspectsAtStartup; }
    bool wasPluginCrashSuspected() const { return ! pluginSuspectsAtStartup.isEmpty(); }
    void clearPluginCrashSuspects();   // the user chose Recover/Dismiss: stop offering safe mode

    /** True while the live Edit was loaded with third-party plugins scrubbed out.

        Such an Edit is READ-ONLY (see save()): it is deliberately not what the user
        authored, so persisting it would strip their whole plugin chain. Cleared by any
        successful normal load. */
    bool inSafeMode() const { return safeModeActive; }

    /** Reload the current project with every third-party plugin node scrubbed OUT of the
        state before Tracktion sees it ("load then remove" cannot work — loading is what
        crashes). Built-in inserts, tracks and clips are untouched. Returns a non-empty
        error on failure (current Edit kept); `pluginsSkipped` receives the count. */
    juce::String reloadInSafeMode (int* pluginsSkipped = nullptr);

    /** Project lifecycle (wave: settings). Each replaces the live Edit object, so
        callers must re-read edit() and refetch any cached track/clip pointers
        afterwards. They are machine/whole-Edit operations — NOT undoable. The
        transport is stopped + the playback context freed before the swap to avoid
        device/Edit-mismatch asserts (matches the export render-exclusivity dance).
        editPath + editFileRetriever are re-pointed to the new file. */
    void newProject (const juce::File& file);   // save current, then a fresh empty Edit at file
    juce::String openProject (const juce::File& file);  // save current, then load the Edit at file (PRJ-FMT: non-empty ⇒ refused, current kept)
    bool saveProjectAs (const juce::File& file); // saveAs to file + adopt it as the backing file

    /** gap 2 — reopen the last project on relaunch. rememberProject persists the
        current project path + a recent list to session/last-project.json on every
        new/open/save-as; startupEditFile() (called by the ctor) resolves the edit to
        open at launch (the remembered project, or defaultSessionEditFile() when none /
        the remembered file is missing); recentProjects() is the existing-file Recent
        list for the UI (newest-first). */
    void       rememberProject (const juce::File& file);
    juce::File startupEditFile() const;
    juce::var  recentProjects() const;

    /** PRJ-NAME — the unnamed default session file: "session.mosh".

        Falls back to a pre-existing "session.tracktionedit" when that legacy file is on
        disk and session.mosh is not. Without the fallback, renaming the extension would
        strand every existing session behind a silently-empty cold start — the user's
        work would still be on disk but the app would open blank, which reads as data
        loss. The fallback keeps opening it in place; it is never rewritten or migrated.
        A brand-new session gets session.mosh. */
    juce::File defaultSessionEditFile() const;

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
    juce::String openAudioDeviceBounded();                     // AUD-017 — the one, bounded, device open
    void wireEditResolvers();                                  // gap 3 — editFileRetriever + filePathResolver
    void consolidateAudioInto (const juce::File& projectDir);  // gap 3 — copy referenced audio project-local
    void stampFormatVersion();                                 // PRJ-FMT — write moshFormatVersion on save

    /** FS-T2 — the ONE load-from-file path, bracketed by the plugin crash breadcrumb.
        Behaviour-identical to te::loadEditFromFile(engine, file) when safeMode is false
        (it replicates that function's own two-step: load the state, then createEdit with a
        file retriever so save() still binds to `file`) — plus the breadcrumb write/clear.
        With safeMode true it scrubs third-party plugin nodes from the state first. */
    std::unique_ptr<te::Edit> loadEditBracketed (const juce::File& file, bool safeMode, int* scrubbed);
    juce::File pluginBreadcrumbFile() const;
    bool       audioOpen = false;
    bool       audioWanted = false;        // AUD-017 — audio was requested (see audioRequested())
    bool       dirty = false;              // unsaved-changes flag (gap 1)
    bool       uncleanAtStartup = false;   // A2 — the session.running sentinel existed at launch (prior crash)
    juce::StringArray pluginSuspectsAtStartup;   // FS-T2 — breadcrumb survived the last load ⇒ crash suspects
    bool       safeModeActive = false;           // FS-T2 — live Edit has third-party plugins scrubbed (READ-ONLY)
    juce::String loadError;                // PRJ-FMT — non-empty ⇒ a refused (newer-format) load is live
    bool       inputsConfigured = false;   // one-time wave-input enablement latch (audio-only)
    juce::String audioError;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshEngine)
};

} // namespace mosh
