#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
/** The native Generative Job Manager (05 §4). Talks to the model service over a
    local job protocol — control via HTTP/JSON, audio via files+manifests. Owns
    service lifecycle (spawn/detect, health handshake, cancel) and never blocks
    the audio thread (renders are background jobs; the source take keeps playing).

    Tier B is a JOB, not an insert — the only out-of-process component. */
class GenerativeJobManager
{
public:
    GenerativeJobManager();
    ~GenerativeJobManager();

    /** Ensure the service is reachable: probe /health, spawning the bundled
        Python service (service/server.py) if needed. Returns true if healthy. */
    bool ensureServiceRunning();
    bool isHealthy();

    /** The available SA3 colours + their ASTD ceilings (GET /colors), for the UI. */
    juce::var listColors();

    /** Route B: the transform target list (instruments / models), GET /transform_targets. */
    juce::var listTransformTargets();

    /** Submit a render job to a named adapter ("fake" | "stable_audio3").
        Returns the jobId (empty on failure). Non-blocking. */
    juce::String submitJob (const juce::String& adapter,
                            const juce::File& inputWav, const juce::File& outputWav,
                            const juce::File& manifest, const juce::var& params);

    /** Poll a job's status: { ok, status, progress, outputWav, manifest }. */
    juce::var jobStatus (const juce::String& jobId);
    void cancelJob (const juce::String& jobId);

    /** Audio->MIDI transcription via Basic Pitch (POST /transcribe). SYNCHRONOUS —
        call on a BACKGROUND thread (model load + inference is ~1-3s). Returns
        { ok, notes:[{pitch,start,end,velocity}] } (times in SECONDS), or a var whose
        ok is false / {} on failure (service down, venv absent → 503). */
    juce::var transcribe (const juce::File& inputWav, const juce::String& mode);

    /** Sketch Phase 0 — beatbox → drum hits via librosa (POST /sketch). SYNCHRONOUS —
        call on a BACKGROUND thread (model-free, but a subprocess + onset analysis is
        ~0.5-2s). Deterministic given (inputWav, bpm, bars). Returns
        { ok, bpm, bars, hits:[{step,role,velocity}] }, or a var whose ok is false / {}
        on failure (service down, venv absent → 503). */
    juce::var sketchBeatbox (const juce::File& inputWav, double bpm, int bars);

    /** §1 drum-sample match (POST /teardown/match). SYNCHRONOUS — call off the message
        thread. Returns { ok, matches:[{path,distance,role_guess,kind}] }, or a var whose
        ok is false / {} on failure (service down, teardown venv absent → 503, index
        not built → 409). */
    juce::var findSimilarSamples (const juce::File& inputWav, const juce::String& role, int k);

    /** §4 tutorial→Recipe skeleton (POST /teardown/recipe). LONG-running (download + frames
        + transcript) — call off the message thread. Returns the cli summary var, or {} /
        ok:false on failure (service down, teardown venv absent → 503). */
    juce::var teardownAnalyze (const juce::String& videoId, double secStart, double secEnd);

    /** §9 Recipe→render (POST /teardown/execute). SYNCHRONOUS-ish (a render is seconds) —
        call off the message thread. Returns { ok, out_wav, yield_actual, ... }, or {} /
        ok:false on failure. */
    juce::var teardownRender (const juce::String& recipePath, const juce::String& outWav);

    /** §10 full conductor (POST /teardown/teardown): skeleton→extract→match→compile→render→score
        in one shot. LONG-running (download + demucs + render) — call off the message thread.
        Returns the cli summary var { ok, status, recipe, render{out_wav,...}, reward,
        yield_validation, ... }, or {} / ok:false on failure. */
    juce::var teardownOrchestrate (const juce::String& videoId, double secStart, double secEnd, bool render);

    juce::String serviceBuild() const { return svcBuild; }

private:
    juce::var httpGet (const juce::String& path);
    juce::var httpPost (const juce::String& path, const juce::var& body);

    juce::String baseUrl;
    juce::ChildProcess serviceProcess;
    bool spawnedByUs = false;
    juce::String svcBuild;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GenerativeJobManager)
};

} // namespace mosh
