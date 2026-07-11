#pragma once

// Route C.2 — real-time RAVE timbre-transfer insert (Tier-A). GATED: the whole plugin
// only exists when built with anira+LibTorch (-DMOSH_ENABLE_ANIRA=ON). The default
// build never sees it (no dead command/registration surface). All torch lives behind
// RaveEngine (RaveEngine.cpp), so this TU stays torch-free.
#if MOSH_HAVE_ANIRA

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/transform/RaveEngine.h"
#include <atomic>

namespace mosh
{
namespace te = tracktion::engine;

/** A custom te::Plugin that runs a RAVE model in real time via anira. anira owns the
    background inference thread + RT-safe ring buffers, so applyToBuffer never blocks.
    The model's block latency is reported exactly via getLatencySeconds() so Tracktion's
    PDC compensates with no drift; the dry path is delay-aligned to the wet so dry/wet
    mixes phase-correctly. */
class RaveInsertPlugin : public te::Plugin
{
public:
    static const char* xmlTypeName;        // "moshRaveInsert"
    static const char* getPluginName()     { return "Mosh RAVE"; }

    explicit RaveInsertPlugin (te::PluginCreationInfo);
    ~RaveInsertPlugin() override;

    juce::String getName() const override               { return getPluginName(); }
    juce::String getPluginType() override               { return xmlTypeName; }
    juce::String getSelectableDescription() override    { return getName(); }

    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext&) override;   // RT thread
    int  getNumOutputChannelsGivenInputs (int n) override { return n; }
    double getLatencySeconds() override;                            // PDC
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;

    // ── MoshOps-facing (message thread) ──
    void setMixUi (float ui0to100);                 // 0–100 dry/wet
    bool loadModelFromFile (const juce::File& tsFile);
    void resetModel();
    juce::var describe() const;
    // AL-022 — diagnostic for the most recent loadModelFromFile() failure (or
    // prepare() re-init failure); empty on success/no-op. Additive passthrough
    // to RaveEngine::lastError(), also mirrored into describe()'s "lastError".
    juce::String lastLoadError() const { return juce::String (engine.lastError()); }

private:
    juce::CachedValue<float>        mixValue;
    juce::CachedValue<juce::String> modelPath, modelName;
    te::AutomatableParameter::Ptr   mixParam;

    RaveEngine engine;
    double sr = 44100.0;
    int    blockSize = 512;
    std::atomic<bool> modelLoaded { false };
    bool   engineNonRealtime = false;   // mirrors anira's scheduling mode; flip on render↔live transition

    // Preallocated: dry-delay ring (align dry to anira's latency) + mono scratch buffers.
    juce::AudioBuffer<float> dryRing, monoBuf, dryAligned;
    int dryWritePos = 0;
    // reset_rave (message thread) requests the dry-delay ring be cleared; the actual clear
    // happens on the RT thread in applyToBuffer so we never race dryRing/dryWritePos.
    std::atomic<bool> pendingDryReset { false };
    static constexpr int kMaxDelay = 1 << 16;       // 65536 — RAVE latency is a few k
    static constexpr int kMaxChannels = 2;
    static constexpr int kMaxBlock = 8192;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (RaveInsertPlugin)
};

} // namespace mosh

#endif // MOSH_HAVE_ANIRA
