#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/neural/Astd.h"

namespace mosh
{
namespace te = tracktion::engine;

/** Tier-A real-time neural insert (04 PART 2). A model-agnostic custom
    te::Plugin (template: DistortionEffectDemo) that runs a small neural model
    RT-safe inside applyToBuffer. v0 ships a self-contained, preallocated MLP
    waveshaper (a genuine 2-layer tanh network) as the "nam"/"proteus"-class
    inline model; the host is model-agnostic so an RTNeural capture (gated) or an
    anira-pooled RAVE/DDSP model (gated) can slot in without changing the seam.

    Invariants enforced here:
    • RT-safe applyToBuffer — no allocations, no locks (all buffers preallocated).
    • TRUE latency via getLatencySeconds() (an internal delay line of the exact
      reported length) so Tracktion's PDC compensates with no drift.
    • ASTD: over-driveable knobs are 0–100 UI clamped below quality-collapse;
      Lab mode unlocks the raw range (shared mosh::astd impl, both tiers).
    • Operational safety: dry/wet blend + model reset (04 §2.7) baked into the host. */
class NeuralInsertPlugin : public te::Plugin
{
public:
    static const char* xmlTypeName;        // "moshNeuralInsert"
    static const char* getPluginName()     { return "Mosh Neural"; }

    explicit NeuralInsertPlugin (te::PluginCreationInfo);
    ~NeuralInsertPlugin() override;

    juce::String getName() const override               { return getPluginName(); }
    juce::String getPluginType() override               { return xmlTypeName; }
    juce::String getSelectableDescription() override    { return getName(); }

    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext&) override;   // RT thread
    int  getNumOutputChannelsGivenInputs (int n) override { return n; }
    double getLatencySeconds() override;                            // PDC (§2.4)
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;

    // ── MoshOps-facing control (all on the message thread) ──
    /** Set an over-driveable param from a 0–100 UI value (ASTD-mapped). */
    void  setNeuralParamUi (const juce::String& paramId, float ui0to100);
    float getNeuralParamUi (const juce::String& paramId) const;
    void  setLabMode (bool on);
    bool  isLabMode() const { return labMode.get(); }
    void  selectModel (const juce::String& modelId);
    void  resetModel();                                  // operational reset (§2.7)
    void  setLatencySamples (int samples);               // model latency / PDC test

    /** A JSON description for the snapshot. */
    juce::var describe() const;

private:
    void registerAstdRanges();
    float runModel (float x, float driveRaw) const;      // RT-safe, no alloc

    // Params (raw values are what automation stores; UI is 0–100 via ASTD).
    juce::CachedValue<float>       driveValue, mixValue;
    juce::CachedValue<int>         latencyValue;
    juce::CachedValue<bool>        labMode;
    juce::CachedValue<juce::String> modelId;
    te::AutomatableParameter::Ptr  driveParam, mixParam;

    astd::Registry astdRanges;

    // Preallocated latency delay line (per channel ring buffer).
    juce::AudioBuffer<float> delayBuffer;                 // [maxChannels][maxDelay]
    int delayWritePos = 0;
    static constexpr int kMaxDelay = 1 << 15;             // 32768 samples
    static constexpr int kMaxChannels = 2;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NeuralInsertPlugin)
};

} // namespace mosh
