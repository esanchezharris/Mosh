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

    /** Phonology rhyme search (POST /get_rhymes) — Finish-My-Song rung 1. Fast +
        deterministic, no LLM. SYNCHRONOUS — call on a BACKGROUND thread (or accept a
        brief block on the message thread for an explicit on-demand lookup). Returns
        { ok, word, inDict, candidates:[{word,syllables,grade}] }, or a var whose ok is
        false / {} on failure (service down → {}). `strictness` ∈ perfect|slant|free;
        `syllables` 0 ⇒ no syllable filter. */
    juce::var getRhymes (const juce::String& word, const juce::String& strictness,
                         int maxN, int syllables);

    /** Lyric generation loop (POST /complete_lyrics | /fill_lyric_gap | /suggest_next_line)
        — Finish-My-Song L2. `mode` ∈ "complete"|"fill"|"next". SYNCHRONOUS — call on a
        BACKGROUND thread (mirrors transcribe()). `spec` is the lyric-sheet constraint
        spec; `regen` is an optional {lineIndex:counter} object. Returns
        { ok, lines:[{index, proposals:[{text,score,syllables,passes,grade,endWord,...}]}] },
        or {} on failure (service down). */
    juce::var generateLyrics (const juce::String& mode, const juce::var& spec,
                              int lineIndex, int afterIndex, const juce::var& regen);

    /** Prompt compiler (POST /compile_render) — generative-only v1. Turns a loose
        `instruction` into a VALIDATED render envelope. `intensity` < 0 ⇒ unset (let the
        compiler infer); `backend` ∈ ""(auto)|"fake"|"llm". SYNCHRONOUS — call on a
        BACKGROUND thread (mirrors transcribe()/generateLyrics). Returns
        { ok, backend, mode, reasoning, envelope|null, say|null }, or {} on failure. */
    juce::var compileRender (const juce::String& instruction, int intensity,
                             const juce::String& backend);

    juce::String serviceBuild() const { return svcBuild; }

private:
    juce::var httpGet (const juce::String& path);
    juce::var httpPost (const juce::String& path, const juce::var& body);

    // C2 — reap an orphaned/wedged service (a crashed Mosh leaves a multi-GB MLX process
    // squatting the port) via the PID handshake file before spawning a fresh one.
    void reapStaleService();
    // C3 — adopt the actual bound port the service wrote (it may differ from the requested
    // one if a non-Mosh process held it).
    void adoptPortFromHandshake();

    juce::String baseUrl;
    juce::ChildProcess serviceProcess;
    bool spawnedByUs = false;
    juce::String svcBuild;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GenerativeJobManager)
};

} // namespace mosh
