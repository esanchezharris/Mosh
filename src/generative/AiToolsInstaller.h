#pragma once

#include <juce_core/juce_core.h>
#include <atomic>
#include <functional>
#include <thread>

namespace mosh
{
/** "Add AI tools" (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.3).

    Installs the small pack on a Mac that may have no developer tools, in three steps:
      python     — the bundled uv downloads a managed CPython 3.11 into ~/Library/Mosh/python
      sketch     — service/sketch/setup-sketch.sh --python <managed> --env-dir <envDir>
      transcribe — service/transcribe/setup-transcribe.sh, the same way
    Nothing runs a bare python3, and nothing is written inside the app bundle.

    This is machine state, like the microphone permission: bridge calls, not MoshOps
    commands, and never undoable.

    Each step runs in its own process group, so cancel stops uv and everything it
    started. A step that fails or is cancelled removes the folder it created, so a
    venv that passes its setup script's import check stays the only proof a tool
    installed. installed.json in the env dir lists exactly the folders this installer
    created; remove() deletes those and nothing else, so an owner's pre-existing venvs
    survive. */
class AiToolsInstaller
{
public:
    struct Paths
    {
        juce::File uv;           // the bundled uv binary; empty when this build has none
        juce::File serviceDir;   // holds sketch/setup-sketch.sh and transcribe/setup-transcribe.sh
        juce::File home;
        juce::File pythonDir;    // ~/Library/Mosh/python
        juce::File venvsDir;     // ~/Library/Mosh/venvs (MOSH_VENVS_DIR)
        juce::File envDir;       // ~/Library/Application Support/Mosh/ai-tools (run.sh sources it)
        juce::File cacheDir;     // uv's download cache, deleted when an install ends
        juce::File logFile;      // every step's stdout and stderr
        /** Refuse to start below this much free space on the home volume: the install
            peaks at ~1.3 GB (850 MB kept + uv's 436 MB cache, deleted at the end). */
        juce::int64 minFreeBytes = (juce::int64) 1536 * 1024 * 1024;

        static Paths forThisApp();
    };

    explicit AiToolsInstaller (Paths paths);
    ~AiToolsInstaller();   // cancels a running job and waits for it

    /** { available, state, step, steps[{id,status}], error, detail, sizeEstimateMb }.
        state: idle | installing | done | failed | cancelling | cancelled | removing | removed */
    juce::var status() const;

    /** Each starts work on a background thread and answers with the fresh status.
        install() while a job runs is a no-op; cancel() with nothing running is too. */
    juce::var install();
    juce::var cancel();
    juce::var remove();

    /** Called from the worker thread on every state change. */
    void setStatusCallback (std::function<void (juce::var)> cb);

    /** Blocks until the current job ends (tests). */
    void waitForIdle();

    /** Measured 2026-11-03 into an empty home with uv 0.13.1: Python 76 MB, beatbox
        308 MB, transcription 466 MB, after the cache is deleted. The copy states it
        before the click. */
    static constexpr int kSizeEstimateMb = 850;

private:
    enum class Step { python, sketch, transcribe };
    struct StepRun { int exitCode = -1; bool cancelled = false; };

    juce::String unavailableReason() const;
    void runInstall();
    void runRemove();
    bool runStep (Step step, const juce::File& python);
    StepRun spawn (const juce::StringArray& argv, const juce::StringPairArray& env);
    juce::StringPairArray baseEnv() const;
    juce::File findManagedInterpreter() const;
    void recordCreated (const juce::File& dir, const juce::File& python);
    juce::var readManifest() const;
    void setState (const juce::String& state, const juce::String& step = {},
                   const juce::String& error = {}, const juce::String& detail = {});
    void setStepStatus (Step step, const juce::String& status);
    juce::String logTail (int lines) const;
    void startJob (std::function<void()> job);

    const Paths paths;
    mutable juce::CriticalSection lock;
    juce::String state { "idle" }, currentStep, error, detail;
    juce::StringPairArray stepStatus;
    std::function<void (juce::var)> statusCallback;

    std::thread worker;
    std::atomic<bool> busy { false };
    std::atomic<bool> cancelRequested { false };
    std::atomic<int> runningPgid { 0 };
};
}
