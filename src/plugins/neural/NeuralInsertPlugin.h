#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/neural/Astd.h"
#include <atomic>
#include <memory>

#if MOSH_HAVE_RTNEURAL
 #include <RTNeural/RTNeural.h>
#endif

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

    /** GAP 1 — load a real RTNeural model from a JSON file (message thread ONLY: all
        file I/O, parsing, allocation and warm-up happen here). On success the new
        model is built fully, then an atomic readiness flag is flipped so the audio
        thread starts using it on its next acquire-load; the previous model stays
        alive until the next load / resetModel (no audio-thread alloc or lock). When
        MOSH_HAVE_RTNEURAL is not defined this is a graceful no-op returning false.
        forceSkip: -1 = read the model's own "mosh_skip" field (residual models add the
        dry input back: output = net(x) + x — e.g. GuitarML/NeuralPi captures); 0/1 = force. */
    bool  loadModelFromFile (const juce::File& jsonFile, int forceSkip = -1);

    /** A JSON description for the snapshot. */
    juce::var describe() const;

private:
    void registerAstdRanges();
    float runModel (float x, float driveRaw) const;      // RT-safe, no alloc (inline MLP)
    // RT-safe per-sample dispatch: the loaded RTNeural model when ready (acquire load
    // of rtnReady on the audio thread), else the inline runModel fallback.
    float inferSample (float x, float driveRaw) const;   // RT-safe, no alloc

    // Params (raw values are what automation stores; UI is 0–100 via ASTD).
    juce::CachedValue<float>       driveValue, mixValue;
    juce::CachedValue<int>         latencyValue;
    juce::CachedValue<bool>        labMode;
    juce::CachedValue<juce::String> modelId;
    juce::CachedValue<juce::String> modelPath;            // GAP 1 — persisted model file path
    te::AutomatableParameter::Ptr  driveParam, mixParam;

    astd::Registry astdRanges;

    // GAP 1 — the real Tier-A model holder (only compiled with the RTNeural backend).
    // Built on the message thread; the audio thread reads it ONLY when rtnReady is
    // true (acquire/release handshake). The retired model is kept alive in
    // rtnModelOld until the next swap so the audio thread never frees on the RT path.
    std::atomic<bool> rtnReady { false };
    // Residual ("skip") models output only the delta the amp adds; the full signal is
    // net(x) + x. Set on the message thread before the rtnReady release-store, read
    // relaxed on the audio thread (the rtnReady acquire already orders it).
    std::atomic<bool> modelSkip { false };
   #if MOSH_HAVE_RTNEURAL
    std::unique_ptr<RTNeural::Model<float>> rtnModel;     // live (audio-thread reads when ready)
    std::unique_ptr<RTNeural::Model<float>> rtnModelOld;  // retired, kept alive past the swap
   #endif

    // Preallocated latency delay line (per channel ring buffer).
    juce::AudioBuffer<float> delayBuffer;                 // [maxChannels][maxDelay]
    int delayWritePos = 0;
    static constexpr int kMaxDelay = 1 << 15;             // 32768 samples
    static constexpr int kMaxChannels = 2;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NeuralInsertPlugin)
};

} // namespace mosh
