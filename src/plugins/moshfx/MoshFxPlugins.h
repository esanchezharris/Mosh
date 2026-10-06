#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/moshfx/MoshFxDsp.h"
#include "plugins/moshfx/retune/RetuneCore.h"
#include "plugins/moshfx/retune/LivePitch.h"
#include "plugins/moshfx/LiveMeter.h"
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <vector>

namespace mosh
{
namespace te = tracktion::engine;

class MoshFxDescribable
{
public:
    virtual ~MoshFxDescribable() = default;
    virtual juce::var describeMoshFx() const = 0;
};

// A plugin that feeds the 30 Hz "plugin_meters" rail (MoshOps::pluginMeters,
// docs/02_MOSHOPS_CONTRACT.md). The audio thread publishes into a LiveMeterLatch once
// per processed block; takeLiveMeters() turns what accumulated since the previous take
// into the per-type fields of one rail entry.
//
// Message thread, ONE caller (MoshOps::pluginMeters): each call consumes the reading.
// Returns a void var when no block was processed since the previous call, so a
// bypassed or idle plugin never reports stale numbers. Mosh AutoTune is deliberately
// NOT one of these: its pitch latch is single-reader and belongs to the "tuner" rail.
class MoshLiveMetered
{
public:
    virtual ~MoshLiveMetered() = default;
    virtual juce::var takeLiveMeters() = 0;

    /** A linear magnitude in dBFS, clamped to [-100, +100] (-100 for silence and NaN,
        +100 for anything at or above 10^5, inf included), so the rail is always finite. */
    static float meterDb (float linear) noexcept
    {
        if (! (linear > 1.0e-5f))
            return -100.0f;
        if (! (linear < 1.0e5f))
            return 100.0f;
        return juce::jlimit (-100.0f, 100.0f, 20.0f * std::log10 (linear));
    }

    /** A dB value for the rail: NaN becomes `fallback`, the rest is clamped to [lo, hi]. */
    static float finiteDb (float db, float lo, float hi, float fallback = 0.0f) noexcept
    {
        return std::isnan (db) ? fallback : juce::jlimit (lo, hi, db);
    }
};

// Vocal pitch correction (docs/AUTOTUNE-SCOPE-2026-10-01.md). The engine is
// moshfx::retune::RetuneCore: a pitch tracker, a scale-snapping correction with
// retune speed and glide, and a resample-and-splice shifter that keeps the voice's
// own timbre. The mid of a stereo track is retuned; the side is delayed to match
// and left uncorrected, so a mono vocal on a stereo track stays exactly mono.
//
// It reports its latency (about 1.8 ms plus the Look-ahead) so playback and
// recorded takes stay aligned. Tracktion reads a plugin's latency once per graph
// build and does not keep a bypassed built-in plugin delayed, so a change of
// bypass or Look-ahead rebuilds the graph, and a bypassed AutoTune reports zero.
class MoshAutoTunePlugin : public te::Plugin, public MoshFxDescribable, private juce::Timer
{
public:
    static const char* xmlTypeName;
    static const char* getPluginName() { return "Mosh AutoTune"; }

    explicit MoshAutoTunePlugin (te::PluginCreationInfo);
    ~MoshAutoTunePlugin() override;

    juce::String getName() const override { return getPluginName(); }
    juce::String getPluginType() override { return xmlTypeName; }
    juce::String getSelectableDescription() override { return getName(); }

    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext&) override;
    int getNumOutputChannelsGivenInputs (int n) override { return n; }
    double getLatencySeconds() override;
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;
    juce::var describeMoshFx() const override;

    /** The pitch being sung and the note it is being pulled to, for the live display.
        Message thread, one caller (the 30 Hz telemetry tick): `live` is false unless
        the audio thread processed this plugin since the previous call. */
    moshfx::retune::LivePitchReading takeLivePitch() noexcept { return livePitch.take(); }

protected:
    void valueTreePropertyChanged (juce::ValueTree&, const juce::Identifier&) override;

private:
    void timerCallback() override;

    moshfx::retune::LivePitchLatch livePitch;
    juce::CachedValue<float> rootValue, scaleValue, retuneValue, amountValue, rangeValue, mixValue, outputValue,
                             glideValue, lookaheadValue;
    te::AutomatableParameter::Ptr rootParam, scaleParam, retuneParam, amountParam, rangeParam, mixParam, outputParam,
                                  glideParam, lookaheadParam;
    moshfx::retune::RetuneCore core;
    moshfx::retune::SampleDelay sideDelay;
    double sampleRate = 0.0;
    std::atomic<bool> pendingReset { false }; // set on re-enable; served on the audio thread
    std::atomic<double> lastInputHz { 0.0 };
    std::atomic<double> lastTargetHz { 0.0 };
    std::atomic<double> lastCorrectionCents { 0.0 };
    std::atomic<float> lastConfidence { 0.0f };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshAutoTunePlugin)
};

class MoshOTTPlugin : public te::Plugin, public MoshFxDescribable, public MoshLiveMetered
{
public:
    static const char* xmlTypeName;
    static const char* getPluginName() { return "Mosh OTT"; }

    explicit MoshOTTPlugin (te::PluginCreationInfo);
    ~MoshOTTPlugin() override;

    juce::String getName() const override { return getPluginName(); }
    juce::String getPluginType() override { return xmlTypeName; }
    juce::String getSelectableDescription() override { return getName(); }

    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext&) override;
    int getNumOutputChannelsGivenInputs (int n) override { return n; }
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;
    juce::var describeMoshFx() const override;
    /** `{ bands: [{levelDb, gainDb}] x3 (low, mid, high), clipped }` — see MoshLiveMetered. */
    juce::var takeLiveMeters() override;

private:
    juce::CachedValue<float> amountValue, timeValue, lowGainValue, midGainValue, highGainValue, mixValue, outputValue;
    te::AutomatableParameter::Ptr amountParam, timeParam, lowGainParam, midGainParam, highGainParam, mixParam, outputParam;
    std::array<moshfx::OTTCore, 8> cores;
    // maxima: band envelope peaks (low, mid, high; linear), clipped (0/1).
    // latest: band gain change in dB (low, mid, high), dynamics ran (0/1).
    moshfx::LiveMeterLatch<4, 4> meter;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshOTTPlugin)
};

// R3.3 — a plain per-sample tanh soft clipper: no oversampling, no lookahead, zero
// latency. Two AutomatableParameters (drive in dB, ceiling in dBFS); see
// MoshSoftClipPlugin.cpp's applyToBuffer for the exact formula and the honest
// aliasing caveat that comes with skipping oversampling.
class MoshSoftClipPlugin : public te::Plugin, public MoshFxDescribable, public MoshLiveMetered
{
public:
    static const char* xmlTypeName;
    static const char* getPluginName() { return "Mosh Soft Clipper"; }

    explicit MoshSoftClipPlugin (te::PluginCreationInfo);
    ~MoshSoftClipPlugin() override;

    juce::String getName() const override { return getPluginName(); }
    juce::String getPluginType() override { return xmlTypeName; }
    juce::String getSelectableDescription() override { return getName(); }

    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext&) override;
    int getNumOutputChannelsGivenInputs (int n) override { return n; }
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;
    juce::var describeMoshFx() const override;
    /** `{ grDb, inDb, outDb }` — see MoshLiveMetered and applyToBuffer. */
    juce::var takeLiveMeters() override;

private:
    juce::CachedValue<float> driveValue, ceilingValue;
    te::AutomatableParameter::Ptr driveParam, ceilingParam;
    // maxima: input peak (linear), output peak (linear), gain reduction (dB, >= 0).
    moshfx::LiveMeterLatch<3, 0> meter;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshSoftClipPlugin)
};

class MoshXFeedbackPlugin : public te::Plugin, public MoshFxDescribable, public MoshLiveMetered
{
public:
    static const char* xmlTypeName;
    static const char* getPluginName() { return "Mosh X-FDBK"; }

    explicit MoshXFeedbackPlugin (te::PluginCreationInfo);
    ~MoshXFeedbackPlugin() override;

    juce::String getName() const override { return getPluginName(); }
    juce::String getPluginType() override { return xmlTypeName; }
    juce::String getSelectableDescription() override { return getName(); }

    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext&) override;
    int getNumOutputChannelsGivenInputs (int n) override { return n; }
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;
    juce::var describeMoshFx() const override;
    /** `{ candidates: [{hz, score}], cuts: [{hz, score, depthDb}] }`, the last block's
        (channel 0, as describeMoshFx) — see MoshLiveMetered. */
    juce::var takeLiveMeters() override;

    // Layout of the meter latch's "latest" slots.
    static constexpr std::size_t kMeterNumCandidates = 0, kMeterCandidates = 1,   // + 2*i: hz, score
                                 kMeterNumCuts = 9, kMeterCuts = 10,               // + 3*i: hz, score, depthDb
                                 kMeterSlots = 22;

private:
    moshfx::LiveMeterLatch<0, kMeterSlots> meter;
    juce::CachedValue<float> sensitivityValue, maxCutsValue, maxDepthValue, releaseValue, autoSuppressValue, mixValue, outputValue;
    te::AutomatableParameter::Ptr sensitivityParam, maxCutsParam, maxDepthParam, releaseParam, autoSuppressParam, mixParam, outputParam;
    std::array<moshfx::XFeedbackCore, 8> cores;
    std::array<std::atomic<double>, 4> candidateHz {};
    std::array<std::atomic<float>, 4> candidateScore {};
    std::array<std::atomic<double>, 4> activeHz {};
    std::array<std::atomic<float>, 4> activeScore {};
    std::array<std::atomic<float>, 4> activeDepth {};
    std::atomic<int> numCandidates { 0 };
    std::atomic<int> numActive { 0 };
    std::atomic<std::uint64_t> telemetryKey { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshXFeedbackPlugin)
};

}
