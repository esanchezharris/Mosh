#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/moshfx/MoshFxDsp.h"
#include <array>
#include <atomic>
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

class MoshAutoTunePlugin : public te::Plugin, public MoshFxDescribable
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
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;
    juce::var describeMoshFx() const override;

private:
    juce::CachedValue<float> rootValue, scaleValue, retuneValue, amountValue, rangeValue, mixValue, outputValue;
    te::AutomatableParameter::Ptr rootParam, scaleParam, retuneParam, amountParam, rangeParam, mixParam, outputParam;
    double processSampleRate = 48000.0;
    std::vector<float> scratchIn;
    std::array<double, 8> synthPhase {};
    std::array<double, 8> smoothedCorrectionCents {};
    std::atomic<double> lastInputHz { 0.0 };
    std::atomic<double> lastTargetHz { 0.0 };
    std::atomic<double> lastCorrectionCents { 0.0 };
    std::atomic<float> lastConfidence { 0.0f };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshAutoTunePlugin)
};

class MoshOTTPlugin : public te::Plugin, public MoshFxDescribable
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

private:
    juce::CachedValue<float> amountValue, timeValue, lowGainValue, midGainValue, highGainValue, mixValue, outputValue;
    te::AutomatableParameter::Ptr amountParam, timeParam, lowGainParam, midGainParam, highGainParam, mixParam, outputParam;
    std::array<moshfx::OTTCore, 8> cores;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshOTTPlugin)
};

class MoshXFeedbackPlugin : public te::Plugin, public MoshFxDescribable
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

private:
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
    std::uint64_t telemetryKey = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshXFeedbackPlugin)
};

}
