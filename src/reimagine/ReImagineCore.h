#pragma once

#include <juce_core/juce_core.h>

#include <cstdint>
#include <optional>
#include <vector>

namespace mosh::reimagine
{
constexpr int kPluginStateSchemaVersion = 1;
constexpr int kServiceProtocolVersion = 1;

struct HostPosition
{
    bool isPlaying = false;
    bool isLooping = false;
    int64_t samplePosition = 0;
    double ppqPosition = 0.0;
    double bpm = 120.0;
    double timeSignatureNumerator = 4.0;
};

struct TempoPoint
{
    double ppq = 0.0;
    double bpm = 120.0;
};
using TempoMap = std::vector<TempoPoint>;

enum class CaptureState { idle, armed, capturing, complete, aborted };
enum class CaptureEvent
{
    none,
    started,
    continued,
    completed,
    abortedMissingTiming,
    abortedDiscontinuity,
    abortedLoopWrap,
    abortedLayoutChange,
    abortedTempoMapCapacity,
    reachedCaptureCap
};

class TransferCapture
{
public:
    void prepare (double sampleRate, int channels, double maximumSeconds = 240.0);
    void arm() noexcept;
    void cancel() noexcept;
    CaptureEvent beginOrContinue (const std::optional<HostPosition>&, int blockSamples, int channels) noexcept;
    CaptureEvent beginOrContinue (const HostPosition& p, int blockSamples, int channels) noexcept
    {
        return beginOrContinue (std::optional<HostPosition> (p), blockSamples, channels);
    }
    CaptureEvent stop() noexcept;
    CaptureState state() const noexcept { return captureState; }
    int64_t capturedSamples() const noexcept { return samplesCaptured; }
    double startPpq() const noexcept { return firstPpq; }
    double endPpq() const noexcept { return lastPpq; }
    const TempoMap& tempoMap() const noexcept { return tempos; }

private:
    CaptureEvent abort (CaptureEvent) noexcept;
    double rate = 0.0;
    int preparedChannels = 0;
    int64_t maximumSamples = 0;
    int64_t samplesCaptured = 0;
    int64_t expectedNextSample = 0;
    double firstPpq = 0.0;
    double lastPpq = 0.0;
    CaptureState captureState = CaptureState::idle;
    TempoMap tempos;
};

struct ColorSetting
{
    juce::String id;
    float amount = 0.0f;
};

struct LoraSetting
{
    juce::String id;
    float scale = 1.0f;
};

struct RackSettings
{
    juce::String prompt;
    float reimagine = 0.4f;
    std::vector<ColorSetting> colors;
    std::vector<LoraSetting> loras;
    int64_t seed = 0;
};

struct RenderTake
{
    juce::String id;
    juce::String assetHash;
    juce::String timestampIso8601;
    int64_t seed = 0;
    RackSettings parameters;
    juce::var manifest;
};

enum class RegionStatus { ready, rendering, staleTempo, missingAsset, failed };

struct TransferRegion
{
    juce::String id;
    double ppqStart = 0.0;
    double ppqEnd = 0.0;
    TempoMap tempoMap;
    juce::String sourceHash;
    RegionStatus status = RegionStatus::ready;
    juce::String selectedTakeId;
    std::vector<RenderTake> takes;
};

enum class RegionOffer { accepted, needsOverlapDecision, invalid };

class RegionCollection
{
public:
    RegionOffer offer (TransferRegion);
    const std::vector<TransferRegion>& regions() const noexcept { return items; }
    const std::optional<TransferRegion>& pendingOverlap() const noexcept { return pending; }
    void replaceOverlaps();
    void discardPending() noexcept { pending.reset(); }

private:
    static bool overlaps (const TransferRegion&, const TransferRegion&) noexcept;
    std::vector<TransferRegion> items;
    std::optional<TransferRegion> pending;
};

enum class RenderAction { startNow, queuedLatest };
struct RenderRequest
{
    uint64_t revision = 0;
    juce::String regionId;
    RackSettings rack;
    bool labEnabled = false;
};

struct RenderCompletion
{
    bool publish = false;
    std::optional<RenderRequest> startRequest;
};

class RenderCoordinator
{
public:
    RenderAction commitRequest (RenderRequest);
    RenderCompletion finish (uint64_t, bool succeeded) noexcept;
    void cancel() noexcept;
    const std::optional<RenderRequest>& activeRequest() const noexcept { return active; }
    const std::optional<RenderRequest>& pendingRequest() const noexcept { return pending; }

private:
    std::optional<RenderRequest> active;
    std::optional<RenderRequest> pending;
};

struct CrossfadeGains
{
    float dry = 1.0f;
    float wet = 0.0f;
};

struct PluginStateV1
{
    int schemaVersion = kPluginStateSchemaVersion;
    juce::String selectedRegionId;
    RackSettings rack;
    bool labEnabled = false;
    float mix = 1.0f;
    std::vector<TransferRegion> regions;
};

bool tempoMatches (const TempoMap&, double ppq, double hostBpm, double tolerance = 0.01) noexcept;
bool shouldRenderSelected (const HostPosition&, bool offline) noexcept;
CrossfadeGains substitutionGainsForPosition (double ppq, double start, double end, double fadePpq,
                                             float mix, bool compareDry) noexcept;
juce::String serializeState (const PluginStateV1&);
std::optional<PluginStateV1> deserializeState (const juce::String&);
}
