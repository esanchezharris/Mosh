#pragma once

#include "ReImagineCore.h"

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdint>
#include <optional>
#include <vector>

// M1 contextual generation loop (docs/reimagine-plugin/M1-CONTEXTUAL-LOOP.md).
//
// Engine-free: juce_core only, so every rule here is unit-tested without a host,
// a model or an audio device. The plug-in supplies measured facts (frames, rate,
// host tempo) and the user supplies musical context; nothing is inferred silently.
namespace mosh::reimagine
{
// Where a context value came from. Manual (user) values override host/inferred ones;
// `unknown` stays unknown — it is never replaced by a silent default.
enum class Provenance { unknown, host, user, inferred };
juce::String provenanceName (Provenance) noexcept;
Provenance provenanceFromName (const juce::String&) noexcept;

// One timed chord. `bar` is 1-based and musical (bar 1 == region start), fractional
// bars allowed ("3.5" == half way through bar 3). Chords are user-entered; there is no
// automatic transcription in M1.
struct ChordEvent
{
    double bar = 1.0;
    juce::String symbol;
};

// The small editable context view for one region. Stored with the region and frozen
// into a SessionSnapshot when an intention is compiled.
struct SessionContext
{
    std::optional<double> bpm;
    Provenance bpmFrom = Provenance::unknown;
    std::optional<int> meterNumerator;
    std::optional<int> meterDenominator;
    Provenance meterFrom = Provenance::unknown;
    juce::String key;                         // e.g. "F minor"; empty == unknown
    Provenance keyFrom = Provenance::unknown;
    std::vector<ChordEvent> chords;           // empty == unknown
    Provenance chordsFrom = Provenance::unknown;
    juce::String sectionLabel;
    juce::StringArray protectedChoices;       // e.g. "chord-change timing"
    // The region's tempo map was assumed (an import before the host reported timing),
    // so it is not host evidence: bpm stays unknown unless the user sets it.
    bool tempoAssumed = false;
};

struct ChordParseResult
{
    std::vector<ChordEvent> chords;
    juce::StringArray errors;
};

// Parses "1:Fm7 3:Db 5:Ab 7:Eb" (separators: whitespace, ',', '|'). Bars must be >= 1,
// strictly increasing, and (when regionBars > 0) start inside the region.
ChordParseResult parseChordList (const juce::String& text, double regionBars = 0.0);
juce::String formatChordList (const std::vector<ChordEvent>&);
// Compact, deterministic prompt form of a timed chord list: "chords by bar: 1 Fm7, 3 Db".
// Empty for an empty list.
juce::String formatChordTimingForPrompt (const std::vector<ChordEvent>&);

// Host facts the plug-in measured for the region. Fields it could not measure stay empty.
struct RegionFacts
{
    juce::String regionId;
    juce::String sourceHash;
    double sampleRate = 0.0;                  // of the staged source asset
    int channels = 0;
    int64_t frames = 0;
    double ppqStart = 0.0;
    double ppqEnd = 0.0;
    TempoMap tempoMap;                        // empty == host timing unknown
    std::optional<int> hostMeterNumerator;
};

// Host-reported tempo/meter fill only fields the user has not set. Returns the merged
// context; a constant tempo map yields bpm with Provenance::host.
SessionContext mergeHostFacts (SessionContext, const RegionFacts&);

// True when the region's tempo map holds one tempo (within tolerance). M1 supports only
// constant-tempo regions for synchronized generation.
bool isConstantTempo (const TempoMap&, double tolerance = 0.01) noexcept;

// Immutable record of exactly what one intention was compiled against.
struct SessionSnapshot
{
    juce::String id;
    juce::String instanceId;
    juce::String regionId;
    juce::String sourceHash;                  // the region's original source (protected)
    juce::String inputHash;                   // the audio actually sent (source or parent take)
    juce::String inputRole;                   // "source" | "parent-take"
    double sampleRate = 0.0;
    int channels = 0;
    int64_t frames = 0;                       // of the input audio
    int64_t regionOffsetSamples = 0;          // offset of the input within the region
    double ppqStart = 0.0;
    double ppqEnd = 0.0;
    bool constantTempo = false;
    SessionContext context;
    juce::String createdIso8601;
};

// What the controller produces from the user's typed intention. Template-driven in M1:
// there is no permitted local language model in this repo, so natural-language
// interpretation is NOT done — the request text is carried into the prompt verbatim.
struct IntentionInput
{
    juce::String request;                     // "Turn these eight bars into a hazy sampled-keyboard loop..."
    juce::String revision;                    // "Roughen the texture, preserve chord timing" (revisions only)
    float strength = 0.4f;                    // SA3 nl; generation strength, NOT dry/wet
    int candidateCount = 2;
    int64_t baseSeed = 0;
    std::vector<ColorSetting> colors;
    std::vector<LoraSetting> loras;
    // Ask the opt-in cloud planner to write the prompt (text and context only, no audio).
    // Off by default; when the planner is unavailable the template is used and says why.
    bool useCloudPlanner = false;
};

// How one stored context field reached (or did not reach) the generator.
struct ConditioningEntry
{
    juce::String field;                       // "source-audio", "chords", "key", "tempo", ...
    bool stored = false;
    juce::String sentAs;                      // "audio" | "text-prompt" | "duration" | "not-sent"
    bool enforced = false;                    // true only when the backend demonstrably applies it
    juce::String note;
};

constexpr int kDefaultMaxAttemptsPerIntention = 8;
constexpr int kMaxCandidatesPerBatch = 4;
constexpr float kMinStrength = 0.01f;         // service/direct_render.py contract
constexpr float kMaxStrength = 0.5f;
constexpr double kMinSeconds = 2.0;           // service/sa3/engine.py MIN_SECONDS
constexpr double kMaxSeconds = 240.0;         // service/sa3/engine.py MAX_CONTIGUOUS
constexpr int kMaxPromptChars = 600;

struct CompiledRequest
{
    juce::String intentionId;
    juce::String snapshotId;
    juce::String parentTakeId;                // empty for an initial batch
    juce::String task = "transform";
    juce::String backend = "stable_audio3";
    juce::String modelVariant = "sa3-medium";
    juce::String templateVersion;
    juce::String prompt;
    float strength = 0.4f;
    double durationSeconds = 0.0;
    std::vector<int64_t> seeds;
    std::vector<ColorSetting> colors;
    std::vector<LoraSetting> loras;
    juce::StringArray protectedChoices;
    // Timed chord list exactly as the user entered it (bar 1 == region start), with its
    // provenance. Sent to the service as structured data AND rendered into the prompt;
    // neither the service nor SA3 enforces it.
    std::vector<ChordEvent> chordTiming;
    Provenance chordTimingFrom = Provenance::unknown;
    std::vector<ConditioningEntry> conditioning;
    int attemptsBefore = 0;
    int maxAttempts = kDefaultMaxAttemptsPerIntention;
    // Who wrote the prompt: "template" (kTransformTemplateVersion) or "cloud-planner"
    // (service/reimagine_planner.py). `controllerRecord` holds the planner's provenance
    // (provider, model, tokens, cost) or why it was not used.
    juce::String controller = "template";
    juce::var controllerRecord;
    juce::String interpretation;              // the planner's one-line reading of the request
    juce::StringArray unsupported;            // what the planner said the backend cannot enforce
};

struct CompileResult
{
    std::optional<CompiledRequest> request;
    juce::StringArray errors;
    juce::StringArray warnings;
};

extern const char* const kTransformTemplateVersion;

CompileResult compileIntention (const IntentionInput&, const SessionSnapshot&,
                                const juce::String& intentionId, const juce::String& parentTakeId,
                                int attemptsSoFar, int maxAttempts = kDefaultMaxAttemptsPerIntention);

// Rejects a request a model or a hand-edited state could have produced but the backend
// cannot honour. Called again immediately before submission.
juce::StringArray validateRequest (const CompiledRequest&);

// The direct-render body for service/server.py /submit (service/direct_render.py
// contract: explicit decision policy, frozen source hash, no provider fallback).
juce::var directServiceParams (const CompiledRequest&, size_t candidateIndex,
                               const juce::String& inputSha256, const juce::String& requestId);

// ── Cloud planner (opt-in; service/reimagine_planner.py, POST /reimagine/plan) ───────
// One Claude call per Generate/Revise turns the typed request plus the TEXT context into
// a prompt, a strength and a candidate count. It never receives audio, paths or hashes,
// and it cannot hear whether a take follows the chords.
struct PlannerPlan
{
    juce::String prompt;
    float strength = 0.4f;
    int candidateCount = 1;
    juce::String interpretation;
    juce::StringArray unsupported;
    juce::var controller;                     // provider/model/tokens/cost as returned
};

// The /reimagine/plan body. `maxCandidates` caps the plan (the user's chosen count).
juce::var plannerRequestBody (const IntentionInput&, const SessionSnapshot&, int maxCandidates);

// Parses the helper's reply. On refusal or a malformed reply returns nothing and sets
// `reason` (machine-readable, e.g. "disabled", "budget") and `message`.
std::optional<PlannerPlan> parsePlannerReply (const juce::var& reply, juce::String& reason, juce::String& message);

// Applies a plan to the template-compiled request for the same intention: prompt,
// strength, candidate count (never above the compiled count, so the attempt budget the
// template reserved still holds), controller provenance and honest conditioning rows.
// Returns errors when the plan does not fit; the caller then keeps the template request.
CompileResult applyPlannerPlan (const CompiledRequest& templated, const PlannerPlan&);

// Marks a template request with why the planner was not used (shown in the report).
void notePlannerUnavailable (CompiledRequest&, const juce::String& reason, const juce::String& message);

// ── Controls touched (comparison instrumentation, docs/reimagine-plugin/M1-GARY-COMPARISON.md) ──
// The settings a request was made with. Diffing two of these counts the controls the user
// changed between requests (each control once).
struct ControlState
{
    juce::String prompt;
    float strength = 0.4f;
    int64_t seed = 0;
    int candidateCount = 2;
    juce::String colors;                      // canonical "id=amount;..." strings
    juce::String loras;
    juce::String revision;
    bool fromSelectedAudio = true;
    bool cloudPlanner = false;
    juce::String contextKey, contextChords, contextSection, contextProtected;
};

ControlState controlStateFor (const IntentionInput&, const SessionContext&, bool fromSelectedAudio);
juce::StringArray changedControls (const ControlState& before, const ControlState& after);

juce::var compiledRequestToVar (const CompiledRequest&);
juce::var snapshotToVar (const SessionSnapshot&);
juce::var contextToVar (const SessionContext&);
SessionContext contextFromVar (const juce::var&);

// ── Intentions and budget ─────────────────────────────────────────────────────────
struct IntentionRecord
{
    juce::String id;
    juce::String regionId;
    juce::String request;
    juce::StringArray revisions;
    juce::var snapshot;                       // frozen SessionSnapshot (as written)
    int attempts = 0;                         // every model submission, failures included
    int failures = 0;
    int maxAttempts = kDefaultMaxAttemptsPerIntention;
    juce::String createdIso8601;
};

int remainingAttempts (const IntentionRecord&) noexcept;
juce::var intentionToVar (const IntentionRecord&);
IntentionRecord intentionFromVar (const juce::var&);

// ── Technical checks (NOT taste) ──────────────────────────────────────────────────
struct AudioStats
{
    int64_t frames = 0;
    double sampleRate = 0.0;
    int channels = 0;
    int64_t nonFiniteSamples = 0;
    float peak = 0.0f;
    float rms = 0.0f;
};

// Measures planar float channels. Non-finite samples are counted and excluded from
// peak/rms.
AudioStats measureAudio (const float* const* channels, int numChannels, int64_t frames,
                         double sampleRate) noexcept;

struct TechnicalReport
{
    bool usable = false;
    juce::StringArray failures;               // file is unusable
    juce::StringArray warnings;               // usable, but visible to the user
    double durationDeltaSeconds = 0.0;
};

TechnicalReport checkCandidate (const AudioStats& candidate, double expectedSeconds, int expectedChannels);
juce::var technicalReportToVar (const TechnicalReport&);

// ── Tempo conformance (technical, NOT taste) ──────────────────────────────────────
// Does the generated audio's beat period match the session BPM? Dependency-free method:
//   1. first-difference (high-frequency emphasis) of every channel, 5 ms hops, log energy
//      over a 20 ms window floored at -60 dB below the loudest window;
//   2. onset envelope = rise in that log energy, gated at ~0.4 dB so ripple does not count;
//   3. normalized autocorrelation of the mean-removed envelope, searched only within
//      +-15% of the session beat period P (and of 2P, for half-time material), centroid-
//      interpolated;
//   4. refined on multiples of the beat (2, 4, 8 ... beats) so hop quantization shrinks.
// Drift is (estimated beat period - session beat period) x beats per bar, in ms; positive
// means the take runs slower than the session. Only the period is measured: phase
// (where the downbeat lands) and swing are not checked. A missing or assumed tempo,
// too little audio, or no clear periodic pulse yields `undetermined`, never a guess.
enum class TempoVerdict { undetermined, conforms, drifts };
juce::String tempoVerdictName (TempoVerdict) noexcept;

constexpr double kTempoConformsMsPerBar = 5.0;  // |drift| at or below this conforms
constexpr double kTempoMinPulseStrength = 0.3;  // normalized autocorrelation at the beat lag

struct TempoConformanceReport
{
    TempoVerdict verdict = TempoVerdict::undetermined;
    std::optional<double> sessionBpm;
    Provenance bpmFrom = Provenance::unknown;
    std::optional<double> estimatedBpm;
    double driftMsPerBar = 0.0;
    double beatsPerBar = 0.0;
    bool meterAssumed = false;                // meter unknown: 4 beats per bar assumed
    double pulseStrength = 0.0;               // 0..1, normalized autocorrelation
    juce::String reason;                      // why undetermined, or the method's caveat
};

TempoConformanceReport checkTempoConformance (const float* const* channels, int numChannels, int64_t frames,
                                              double sampleRate, const SessionContext& context);
juce::String describeTempoConformance (const TempoConformanceReport&);
juce::var tempoConformanceToVar (const TempoConformanceReport&);
// One report line from a stored m1.tempoConformance (void == predates the check).
juce::String describeStoredTempoConformance (const juce::var&);

// ── Conform (explicit, optional; timing only) ─────────────────────────────────────
// Time-stretches a selected version so its measured beat period equals the session's.
// The result is a NEW version (the original is never overwritten). It changes timing
// only: downbeat phase is not aligned and nothing about it was checked by ear.
// stretchRatio = output length / input length = measured BPM / session BPM, so a take
// measured at 121 BPM in a 120 BPM session is lengthened by 121/120.
constexpr double kMaxConformStretch = 0.08;     // refuse |stretchRatio - 1| above this

struct ConformPlan
{
    bool allowed = false;
    double stretchRatio = 1.0;
    double fromBpm = 0.0;                       // measured
    double toBpm = 0.0;                         // session
    double driftMsPerBar = 0.0;                 // before conforming
    juce::String refusal;                       // why not, when !allowed
};

// Empty when the context can carry a conform; otherwise the reason it cannot
// (tempo map assumed, BPM missing or of unknown provenance).
juce::String conformContextRefusal (const SessionContext&);
// Refuses an undetermined or already-conforming measurement, one taken against a
// different BPM than the session's current one, and a ratio outside +-kMaxConformStretch.
ConformPlan planConform (const TempoConformanceReport& measured, const SessionContext&);
juce::var conformPlanToVar (const ConformPlan&);

// ── Versions (lineage on RenderTake) ──────────────────────────────────────────────
// Takes created by this loop carry lineage in their manifest under "m1" so the
// existing state schema stays additive and older builds keep loading the takes.
struct TakeLineage
{
    juce::String intentionId;
    juce::String parentTakeId;
    juce::String role;                        // "candidate" | "revision" | "conform"
    bool kept = false;
    bool testFixture = false;
    // Conform only (written only when set, so other takes' manifests are unchanged).
    juce::String conformedFrom;               // take id that was stretched
    std::optional<double> stretchRatio;
};

TakeLineage lineageOf (const RenderTake&);
void setLineage (RenderTake&, const TakeLineage&);
// One-line human label for a take list ("v3 rev of v1 - kept").
juce::String takeLabel (const TransferRegion&, size_t takeIndex);

// Stable export file name: "<section-or-Mosh>_bar<N>_<bpm>bpm_<take8>.wav".
juce::String exportFileName (const TransferRegion&, const RenderTake&, const SessionContext&,
                             std::optional<int> meterNumerator);
juce::var exportSidecar (const TransferRegion&, const RenderTake&, const SessionContext&,
                         double fileSampleRate, int64_t fileFrames, std::optional<int> meterNumerator);

// ── Free audition ─────────────────────────────────────────────────────────────────
// A local, free-running preview of the selected version for hosts that give no
// transport or timing. It never follows the host timeline and it never plays while
// host-synced replace playback is active: if the host starts playing, the preview
// stops itself, so the region is never audible twice. Lock-free: start/stop on the
// message or worker thread, advance on the audio thread.
enum class AuditionStop { none, user, finished, hostTookOver, selectionChanged, nothingLoaded };
juce::String auditionStopName (AuditionStop) noexcept;

class FreeAudition
{
public:
    enum class StartResult { started, noVersion, hostSyncedActive };
    struct Block
    {
        int64_t start = 0;                    // sample in the version's audio
        int count = 0;                        // 0 == output nothing from the preview
    };

    StartResult start (bool hasSelectedVersion, bool hostSyncedPlaybackActive) noexcept;
    void stop (AuditionStop why = AuditionStop::user) noexcept;
    // Audio thread. Never plays while host-synced playback is active.
    Block advance (int blockSamples, int64_t lengthSamples, bool hostSyncedPlaybackActive) noexcept;
    bool playing() const noexcept { return active.load (std::memory_order_acquire) != 0; }
    int64_t position() const noexcept { return cursor.load (std::memory_order_acquire); }
    AuditionStop lastStop() const noexcept { return static_cast<AuditionStop> (stopReason.load (std::memory_order_acquire)); }

private:
    std::atomic<int> active { 0 };
    std::atomic<int64_t> cursor { 0 };
    std::atomic<int> stopReason { static_cast<int> (AuditionStop::none) };
};

// ── Experience log ────────────────────────────────────────────────────────────────
// Append-only JSONL. Explicit choices (keep, prefer) are tagged "explicit"; export,
// audition and selection are "implicit" — ambiguous signals, never preference labels.
class ExperienceLog
{
public:
    ExperienceLog();                          // ~/Library/Mosh/ReImagine/experience.jsonl
    explicit ExperienceLog (juce::File file);
    bool append (const juce::String& event, const juce::String& signal,
                 const juce::String& instanceId, const juce::var& payload) const;
    const juce::File& file() const noexcept { return logFile; }

private:
    juce::File logFile;
};
}
