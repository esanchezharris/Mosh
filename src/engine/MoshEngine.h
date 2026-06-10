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
    juce::String audioDeviceWarning() const { return audioWarning; }

    // ── audio output device control (Stage 14) ──
    // Rung 1's GUI silence: the machine's default output was BlackHole (a
    // virtual loopback sink) and Mosh inherited it silently. The product must
    // show its device, allow switching, and never default to a pure sink.
    juce::StringArray listAudioOutputDevices();
    juce::String currentAudioOutputDevice();
    /** Switch + persist as the machine-local preference. Returns "" on success. */
    juce::String setAudioOutputDevice (const juce::String& name);
    static bool looksLikeVirtualSink (const juce::String& deviceName);

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

    /** Reset to a cold EMPTY Edit (collab rebase: replay-from-genesis starts
        here). Replaces the Edit object; callers must re-read edit(). */
    void resetEmpty();

private:
    std::unique_ptr<te::Engine> enginePtr;
    std::unique_ptr<te::Edit>   editPtr;
    juce::File session;
    juce::File editPath;
    void applyRequestedAudioOutputDevice();
    void applyPreferredOrSaneOutputDevice();  // env > persisted pref > sink policy
    juce::String switchOutputDevice (const juce::String& name);   // "" on success
    juce::File devicePrefFile() const;        // machine-local, never in the session
    bool       audioOpen = false;
    juce::String audioError;
    juce::String audioWarning;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshEngine)
};

} // namespace mosh
