#pragma once

#include "ReImagineCore.h"

#include <juce_core/juce_core.h>

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
    std::vector<ConditioningEntry> conditioning;
    int attemptsBefore = 0;
    int maxAttempts = kDefaultMaxAttemptsPerIntention;
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

// ── Versions (lineage on RenderTake) ──────────────────────────────────────────────
// Takes created by this loop carry lineage in their manifest under "m1" so the
// existing state schema stays additive and older builds keep loading the takes.
struct TakeLineage
{
    juce::String intentionId;
    juce::String parentTakeId;
    juce::String role;                        // "candidate" | "revision"
    bool kept = false;
    bool testFixture = false;
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
