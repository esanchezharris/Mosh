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
        Python service (service/server.py) if needed. Returns true if healthy.

        Two guards keep a broken interpreter from freezing the CALLER (often the message
        thread — list_colors/list_transform_targets/list_loras/render_layer/get_rhymes all
        call this synchronously via execute_command): (1) the warmup loop bails the instant
        the spawned child DIES (e.g. no working python3 / a broken venv on a guest Mac),
        rather than blindly polling for the full ~30s ceiling; (2) a failed attempt is cached
        for a short backoff window so re-opening the Gen inspector (which fires three of
        these back-to-back) doesn't re-trigger a doomed spawn+warmup on every call. Neither
        guard delays a slow-but-alive startup — only a confirmed-dead child or a very recent
        failure short-circuits early. */
    bool ensureServiceRunning();
    /** Probe GET /health. connectMs bounds the worst-case block on the CALLING thread when
        the service is reachable-but-wedged (a dead service refuses immediately); pass a short
        value on non-critical, message-thread paths (e.g. the corpus-stats readout). */
    bool isHealthy (int connectMs = 3000);

    /** The available SA3 colours + their ASTD ceilings (GET /colors), for the UI. */
    juce::var listColors();
    juce::var listLoras();

    /** Route B: the transform target list (instruments / models), GET /transform_targets. */
    juce::var listTransformTargets();

    /** Submit a render job to a named adapter ("fake" | "stable_audio3").
        Returns the jobId (empty on failure). Non-blocking. */
    juce::String submitJob (const juce::String& adapter,
                            const juce::File& inputWav, const juce::File& outputWav,
                            const juce::File& manifest, const juce::var& params);

    /** Poll a job's status: { ok, status, progress, outputWav, manifest }. */
    juce::var jobStatus (const juce::String& jobId, int connectMs = 3000);
    /** POST /cancel and verify the service actually acknowledged it (checks the response's
        `ok` field — httpPost() returns an empty/void var when the request never reached a
        live service at all, e.g. it was killed mid-render). Retries ONCE on a failed
        acknowledgement — a single dropped request during a busy render shouldn't read as a
        hard failure, but a genuinely dead service fails both attempts. Returns false when
        neither attempt was acknowledged, so the caller (MoshOps::cmdCancelRender) can surface
        an honest error instead of silently assuming the render actually stopped. */
    bool cancelJob (const juce::String& jobId);

    /** Render-ahead primitive (Lane A): overlap-add crossfade already-rendered window WAVs into
        ONE continuous file (POST /stitch_windows; 1ms equal-power default — owner-tuned). Reuses
        the measured-gapless service stitch. SYNCHRONOUS + fast (stdlib wave, local) — call on the
        RenderAheadScheduler's background stitch step. Byte-stable: appending a window never perturbs
        earlier seams, so repointing a clip's source to the grown file mid-play is glitch-free.
        Returns the output duration seconds (> 0) on success, or 0.0 on failure. */
    double stitchWindows (const juce::StringArray& windowPaths, const juce::File& outWav,
                          double targetSeconds, double xfadeMs = 1.0);

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

    /** Phase-2 mumble->skeleton spec (POST /skeleton_spec). A hummed/mumbled take → a WORDLESS,
        editable lyric LineSpec (syllable grid + stress; every slot a ___ gap). The server
        orchestrates Basic-Pitch onsets (+ optional FCPE F0 for sub-note nuclei) then bins
        in-process. SYNCHRONOUS — call on a BACKGROUND thread (mirrors transcribe()). Returns
        { ok, grid, source:"skeleton", editable, lines:[...] } or { ok:false,
        error:"no_melody_detected" }; {} on a dead service. */
    juce::var skeletonSpec (const juce::File& inputWav, double bpm, int tsNum, int tsDen,
                            const juce::String& grid);

    /** Sketch Phase 0 — beatbox → drum hits via librosa (POST /sketch). SYNCHRONOUS —
        call on a BACKGROUND thread (model-free, but a subprocess + onset analysis is
        ~0.5-2s). Deterministic given (inputWav, bpm, bars). Returns
        { ok, bpm, bars, hits:[{step,role,velocity}] }, or a var whose ok is false / {}
        on failure (service down, venv absent → 503). */
    juce::var sketchBeatbox (const juce::File& inputWav, double bpm, int bars);

    juce::var generateBeatRecipe (const juce::var& args);

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

    /** WP-11 best-of-n escalation (POST /escalate_candidates). Forwards the UI-built
        escalation request (messages/catalog/manifest/first) VERBATIM — the service
        draws n−1 more candidates from the cloud brain, scores + ranks + archives.
        SYNCHRONOUS + slow (route budget ≤45 s) — call on a BACKGROUND thread (the
        WebBridge relay launches one). ensureServiceRunning is correct here: the user
        opted in via the bestOfNServing setting. Returns the service JSON, or {} on
        failure (the caller degrades to the single-shot reply it already holds). */
    juce::var escalateCandidates (const juce::var& payload);

    /** WP-11 — corrective validator-retry pair → the DPO archive (POST /archive_pair).
        NON-SPAWNING + best-effort (isHealthy()-gated, mirrors styleCorpusAdd): a
        service-down state is a silent no-op (returns false). Fire from a background
        thread; never worth blocking a user turn for. */
    bool archivePair (const juce::var& row);

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

    /** The service build id captured from the last successful /health probe (part of the
        render cache fingerprint). Thread-safe: guarded by stateLock, because isHealthy()
        may reassign it from a background worker while the message thread reads it here. */
    juce::String serviceBuild() const;

private:
    juce::var httpGet (const juce::String& path, int connectMs = 3000);
    juce::var httpPost (const juce::String& path, const juce::var& body);

    // C2 — reap an orphaned/wedged service (a crashed Mosh leaves a multi-GB MLX process
    // squatting the port) via the PID handshake file before spawning a fresh one.
    void reapStaleService();
    // C3 — adopt the actual bound port the service wrote (it may differ from the requested
    // one if a non-Mosh process held it).
    void adoptPortFromHandshake();

    // Concurrency: MoshOps drives this manager from many detached worker threads (render
    // poll / transcribe / sketch / lyric-gen / analyze / skeleton / corpus) AND the message
    // thread (serviceBuild() during fingerprinting). Two locks keep that safe WITHOUT
    // serializing the blocking HTTP calls themselves:
    //   * stateLock — brief copies/assignments of baseUrl + svcBuild. juce::String
    //     assignment is not atomic vs a concurrent copy (torn COW refcount / use-after-free),
    //     so every read AND write of these two goes through the lock. Held only long enough
    //     to copy a String, never across a network call.
    //   * spawnLock — serializes ensureServiceRunning() so two cold-start workers can't both
    //     spawn the single Python service (orphaning one). Held across warmup.
    // Lock order: spawnLock (outer) may take stateLock (leaf); never the reverse.
    juce::String currentBaseUrl() const;       // thread-safe copy of baseUrl

    mutable juce::CriticalSection stateLock;   // guards baseUrl + svcBuild
    juce::CriticalSection spawnLock;           // serializes ensureServiceRunning spawn

    juce::String baseUrl;                       // guarded by stateLock
    juce::ChildProcess serviceProcess;          // guarded by spawnLock
    bool spawnedByUs = false;                   // guarded by spawnLock
    juce::String svcBuild;                      // guarded by stateLock

    // Failure-backoff clock (guarded by spawnLock): the millisecond-counter timestamp of the
    // most recent failed ensureServiceRunning() attempt, or 0 if the last attempt succeeded /
    // none has run yet. See ensureServiceRunning()'s doc comment.
    juce::uint32 lastFailedSpawnMs = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GenerativeJobManager)
};

} // namespace mosh
