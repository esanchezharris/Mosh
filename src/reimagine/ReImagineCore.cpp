#include "ReImagineCore.h"

#include <algorithm>
#include <cmath>

namespace mosh::reimagine
{
namespace
{
juce::var rackToVar (const RackSettings& rack)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("prompt", rack.prompt);
    o->setProperty ("reimagine", rack.reimagine);
    o->setProperty ("seed", static_cast<juce::int64> (rack.seed));
    juce::Array<juce::var> colors;
    for (const auto& color : rack.colors)
    {
        auto* c = new juce::DynamicObject();
        c->setProperty ("id", color.id);
        c->setProperty ("amount", color.amount);
        colors.add (juce::var (c));
    }
    o->setProperty ("colors", colors);
    juce::Array<juce::var> loras;
    for (const auto& lora : rack.loras)
    {
        auto* l = new juce::DynamicObject();
        l->setProperty ("id", lora.id);
        l->setProperty ("scale", lora.scale);
        loras.add (juce::var (l));
    }
    o->setProperty ("loras", loras);
    return juce::var (o);
}

RackSettings rackFromVar (const juce::var& v)
{
    RackSettings result;
    if (auto* o = v.getDynamicObject())
    {
        result.prompt = o->getProperty ("prompt").toString();
        result.reimagine = static_cast<float> (o->getProperty ("reimagine"));
        result.seed = static_cast<juce::int64> (o->getProperty ("seed"));
        if (auto* colors = o->getProperty ("colors").getArray())
            for (const auto& item : *colors)
                if (auto* c = item.getDynamicObject())
                    result.colors.push_back ({ c->getProperty ("id").toString(),
                                               static_cast<float> (c->getProperty ("amount")) });
        if (auto* loras = o->getProperty ("loras").getArray())
            for (const auto& item : *loras)
                if (auto* l = item.getDynamicObject())
                    result.loras.push_back ({ l->getProperty ("id").toString(),
                                              static_cast<float> (l->getProperty ("scale")) });
    }
    return result;
}

juce::var takeToVar (const RenderTake& take)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("id", take.id);
    o->setProperty ("assetHash", take.assetHash);
    o->setProperty ("timestamp", take.timestampIso8601);
    o->setProperty ("seed", static_cast<juce::int64> (take.seed));
    o->setProperty ("parameters", rackToVar (take.parameters));
    o->setProperty ("manifest", take.manifest);
    return juce::var (o);
}

RenderTake takeFromVar (const juce::var& v)
{
    RenderTake take;
    if (auto* o = v.getDynamicObject())
    {
        take.id = o->getProperty ("id").toString();
        take.assetHash = o->getProperty ("assetHash").toString();
        take.timestampIso8601 = o->getProperty ("timestamp").toString();
        take.seed = static_cast<juce::int64> (o->getProperty ("seed"));
        take.parameters = rackFromVar (o->getProperty ("parameters"));
        take.manifest = o->getProperty ("manifest");
    }
    return take;
}
}

void TransferCapture::prepare (double sampleRate, int channels, double maximumSeconds)
{
    rate = sampleRate;
    preparedChannels = channels;
    maximumSamples = static_cast<int64_t> (std::max (0.0, sampleRate * maximumSeconds));
    tempos.clear();
    tempos.reserve (65536);
    cancel();
}

void TransferCapture::arm() noexcept
{
    samplesCaptured = 0;
    expectedNextSample = 0;
    firstPpq = lastPpq = 0.0;
    tempos.clear();
    captureState = CaptureState::armed;
}

void TransferCapture::cancel() noexcept
{
    samplesCaptured = 0;
    captureState = CaptureState::idle;
}

CaptureEvent TransferCapture::abort (CaptureEvent event) noexcept
{
    captureState = CaptureState::aborted;
    return event;
}

CaptureEvent TransferCapture::beginOrContinue (const std::optional<HostPosition>& pos,
                                                int blockSamples, int channels) noexcept
{
    if (captureState != CaptureState::armed && captureState != CaptureState::capturing)
        return CaptureEvent::none;
    if (! pos || ! std::isfinite (pos->ppqPosition) || ! std::isfinite (pos->bpm) || pos->bpm <= 0.0)
        return abort (CaptureEvent::abortedMissingTiming);
    if (! pos->isPlaying)
        return CaptureEvent::none;
    if (channels != preparedChannels)
        return abort (CaptureEvent::abortedLayoutChange);
    if (captureState == CaptureState::capturing && pos->isLooping && pos->ppqPosition < lastPpq)
        return abort (CaptureEvent::abortedLoopWrap);
    if (captureState == CaptureState::capturing && pos->samplePosition != expectedNextSample)
        return abort (CaptureEvent::abortedDiscontinuity);

    const bool starting = captureState == CaptureState::armed;
    if (starting)
    {
        captureState = CaptureState::capturing;
        firstPpq = pos->ppqPosition;
    }
    if (tempos.empty() || std::abs (tempos.back().bpm - pos->bpm) > 0.01)
    {
        if (tempos.size() == tempos.capacity())
            return abort (CaptureEvent::abortedTempoMapCapacity);
        tempos.push_back ({ pos->ppqPosition, pos->bpm });
    }
    const auto remaining = std::max<int64_t> (0, maximumSamples - samplesCaptured);
    const auto capturedThisBlock = static_cast<int> (std::min<int64_t> (blockSamples, remaining));
    lastPpq = pos->ppqPosition + static_cast<double> (capturedThisBlock) * pos->bpm / (60.0 * rate);
    expectedNextSample = pos->samplePosition + blockSamples;
    samplesCaptured += capturedThisBlock;
    if (samplesCaptured >= maximumSamples)
    {
        captureState = CaptureState::complete;
        return CaptureEvent::reachedCaptureCap;
    }
    return starting ? CaptureEvent::started : CaptureEvent::continued;
}

CaptureEvent TransferCapture::stop() noexcept
{
    if (captureState == CaptureState::capturing)
    {
        captureState = CaptureState::complete;
        return CaptureEvent::completed;
    }
    if (captureState == CaptureState::armed)
        captureState = CaptureState::idle;
    return CaptureEvent::none;
}

bool RegionCollection::overlaps (const TransferRegion& a, const TransferRegion& b) noexcept
{
    return a.ppqStart < b.ppqEnd && b.ppqStart < a.ppqEnd;
}

RegionOffer RegionCollection::offer (TransferRegion region)
{
    if (region.id.isEmpty() || ! std::isfinite (region.ppqStart) || ! std::isfinite (region.ppqEnd)
        || region.ppqEnd <= region.ppqStart)
        return RegionOffer::invalid;
    if (std::any_of (items.begin(), items.end(), [&] (const auto& existing) { return overlaps (existing, region); }))
    {
        pending = std::move (region);
        return RegionOffer::needsOverlapDecision;
    }
    items.push_back (std::move (region));
    std::sort (items.begin(), items.end(), [] (const auto& a, const auto& b) { return a.ppqStart < b.ppqStart; });
    return RegionOffer::accepted;
}

void RegionCollection::replaceOverlaps()
{
    if (! pending)
        return;
    std::erase_if (items, [&] (const auto& existing) { return overlaps (existing, *pending); });
    auto replacement = std::move (*pending);
    pending.reset();
    items.push_back (std::move (replacement));
    std::sort (items.begin(), items.end(), [] (const auto& a, const auto& b) { return a.ppqStart < b.ppqStart; });
}

RenderAction RenderCoordinator::commitRequest (RenderRequest request)
{
    if (! active)
    {
        active = std::move (request);
        return RenderAction::startNow;
    }
    pending = std::move (request);
    return RenderAction::queuedLatest;
}

RenderCompletion RenderCoordinator::finish (uint64_t revision, bool succeeded) noexcept
{
    if (! active || active->revision != revision)
        return {};
    const bool superseded = pending.has_value();
    RenderCompletion result { succeeded && ! superseded, pending };
    active = pending;
    pending.reset();
    return result;
}

void RenderCoordinator::cancel() noexcept
{
    active.reset();
    pending.reset();
}

bool tempoMatches (const TempoMap& map, double ppq, double hostBpm, double tolerance) noexcept
{
    if (map.empty() || ! std::isfinite (hostBpm))
        return false;
    const auto found = std::upper_bound (map.begin(), map.end(), ppq,
                                         [] (double value, const TempoPoint& point)
                                         {
                                             return value < point.ppq;
                                         });
    const auto& expected = found == map.begin() ? map.front() : *std::prev (found);
    return std::abs (expected.bpm - hostBpm) <= tolerance;
}

CrossfadeGains substitutionGainsForPosition (double ppq, double start, double end, double fadePpq,
                                             float mix, bool compareDry) noexcept
{
    if (compareDry || ppq < start || ppq >= end)
        return {};
    const auto safeFade = std::max (fadePpq, 1.0e-9);
    const auto in = std::clamp ((ppq - start) / safeFade, 0.0, 1.0);
    const auto out = std::clamp ((end - ppq) / safeFade, 0.0, 1.0);
    const auto boundary = std::min (in, out);
    const auto effectiveMix = std::clamp (mix, 0.0f, 1.0f) * static_cast<float> (boundary);
    const auto angle = juce::MathConstants<float>::halfPi * effectiveMix;
    return { std::cos (angle), std::sin (angle) };
}

juce::String serializeState (const PluginStateV1& state)
{
    auto* root = new juce::DynamicObject();
    root->setProperty ("schemaVersion", state.schemaVersion);
    root->setProperty ("selectedRegion", state.selectedRegionId);
    root->setProperty ("rack", rackToVar (state.rack));
    root->setProperty ("lab", state.labEnabled);
    root->setProperty ("mix", state.mix);
    juce::Array<juce::var> regions;
    for (const auto& region : state.regions)
    {
        auto* r = new juce::DynamicObject();
        r->setProperty ("id", region.id);
        r->setProperty ("ppqStart", region.ppqStart);
        r->setProperty ("ppqEnd", region.ppqEnd);
        r->setProperty ("sourceHash", region.sourceHash);
        r->setProperty ("status", static_cast<int> (region.status));
        r->setProperty ("selectedTake", region.selectedTakeId);
        juce::Array<juce::var> tempos;
        for (const auto& tempo : region.tempoMap)
        {
            auto* t = new juce::DynamicObject();
            t->setProperty ("ppq", tempo.ppq);
            t->setProperty ("bpm", tempo.bpm);
            tempos.add (juce::var (t));
        }
        r->setProperty ("tempoMap", tempos);
        juce::Array<juce::var> takes;
        for (const auto& take : region.takes)
            takes.add (takeToVar (take));
        r->setProperty ("takes", takes);
        regions.add (juce::var (r));
    }
    root->setProperty ("regions", regions);
    return juce::JSON::toString (juce::var (root), true);
}

std::optional<PluginStateV1> deserializeState (const juce::String& json)
{
    const auto parsed = juce::JSON::parse (json);
    auto* root = parsed.getDynamicObject();
    if (root == nullptr)
        return std::nullopt;
    const auto schema = static_cast<int> (root->getProperty ("schemaVersion"));
    if (schema < 1 || schema > kPluginStateSchemaVersion)
        return std::nullopt;
    PluginStateV1 result;
    result.schemaVersion = schema;
    result.selectedRegionId = root->getProperty ("selectedRegion").toString();
    result.rack = rackFromVar (root->getProperty ("rack"));
    result.labEnabled = static_cast<bool> (root->getProperty ("lab"));
    result.mix = root->hasProperty ("mix") ? static_cast<float> (root->getProperty ("mix")) : 1.0f;
    if (auto* regions = root->getProperty ("regions").getArray())
        for (const auto& item : *regions)
            if (auto* r = item.getDynamicObject())
            {
                TransferRegion region;
                region.id = r->getProperty ("id").toString();
                region.ppqStart = static_cast<double> (r->getProperty ("ppqStart"));
                region.ppqEnd = static_cast<double> (r->getProperty ("ppqEnd"));
                region.sourceHash = r->getProperty ("sourceHash").toString();
                region.status = static_cast<RegionStatus> (static_cast<int> (r->getProperty ("status")));
                region.selectedTakeId = r->getProperty ("selectedTake").toString();
                if (auto* tempos = r->getProperty ("tempoMap").getArray())
                    for (const auto& tempoItem : *tempos)
                        if (auto* t = tempoItem.getDynamicObject())
                            region.tempoMap.push_back ({ static_cast<double> (t->getProperty ("ppq")),
                                                         static_cast<double> (t->getProperty ("bpm")) });
                if (auto* takes = r->getProperty ("takes").getArray())
                    for (const auto& take : *takes)
                        region.takes.push_back (takeFromVar (take));
                result.regions.push_back (std::move (region));
            }
    return result;
}
}
