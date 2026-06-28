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

    /** Word-level speech transcription via Whisper (POST /transcribe_words) — the lyric
        "mumble take" word path. SYNCHRONOUS — call on a BACKGROUND thread. Returns
        { ok, words:[{word,start,end,confidence}] } (times in SECONDS). When Whisper isn't
        installed the service degrades to { ok:true, words:[] } (the rhythm sheet still
        builds; never invented words). {} on a dead service. */
    juce::var transcribeWords (const juce::File& inputWav);

    /** Mumble-take spec builder (POST /mumble_spec) — Finish-My-Song Phase 3. Note onsets +
        confidence-gated words → a lyric constraint spec (syllables/bar + stress + word
        anchors/gaps). Fast + deterministic (in-process note/word math, no model). SYNCHRONOUS.
        Returns { ok, grid, lines:[{index,role,seedText,syllableTarget,syllableTol,stress,
        rhymeGroup}] } or { ok:false, error:"no_melody_detected" }; {} on a dead service. */
    juce::var mumbleSpec (const juce::var& notes, const juce::var& words, double bpm,
                          int tsNum, int tsDen, double confThreshold);

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

    /** Precise per-line lyric ANALYSIS (POST /analyze_lyrics) — Finish-My-Song L1. Fast,
        deterministic, no LLM (the dictionary phonology path for the flow visualizer).
        SYNCHRONOUS — call on a BACKGROUND thread (mirrors transcribe()). `spec` is the
        lyric-sheet constraint spec. Returns
        { ok, lines:[{index, analysis:{syllables,target,stress,rhymeGrade,rhymeOk,words,...}}] },
        or {} on failure (service down). */
    juce::var analyzeLyrics (const juce::var& spec);

    /** §7 style-RAG flywheel — push finalized lyric line(s) into the PERSISTED cross-song
        voice corpus (POST /style_corpus action:add). **NON-SPAWNING + best-effort**: probes
        isHealthy() first and silently no-ops (returns -1) when the service is DOWN — it NEVER
        calls ensureServiceRunning(), so it can be fired from `accept_lyric_proposal` without
        spawning the service (keeps --selftest hermetic) and without blocking accept. Returns
        the corpus line count after the add, or -1 if unreachable / failed. Swallows failures;
        safe on a detached background thread. */
    int styleCorpusAdd (const juce::StringArray& lines, const juce::String& source);

    /** §7 — corpus size for a UI readout (POST /style_corpus action:stats). NON-SPAWNING
        (isHealthy()-gated); returns -1 when the service is down. Counts only — never the
        content (the backend-only safety wall). */
    int styleCorpusStats();

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
