#pragma once
#include <tracktion_engine/tracktion_engine.h>

// ──────────────────────────────────────────────────────────────────────────────
// NeuralInsertPlugin — Tier-A real-time neural insert (04): a custom te::Plugin in
// the track's pluginList (reversible by nature; knobs are the plugin's own
// CachedValue state). Registered via getPluginManager().createBuiltInType<>().
//
// v0 here is a PASSTHROUGH shell that establishes the architecture, the ASTD-clamped
// param plumbing, and a TRUE getLatencySeconds() for PDC. The anira-backed model
// (NAM/Proteus ship; RAVE gated; DDSP) drops into initialise()/applyToBuffer() on
// macOS — the // VERIFY anira process/prepare + the PDC null test. Threading: model
// + bridge on the message thread; applyToBuffer is RT-safe (allocates nothing).
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    namespace te = tracktion;

    class NeuralInsertPlugin : public te::Plugin
    {
    public:
        static const char* getPluginName() { return "Neural Insert"; }
        static const char* xmlTypeName;

        NeuralInsertPlugin (te::PluginCreationInfo info) : te::Plugin (info)
        {
            auto um = getUndoManager();
            amountValue.referTo    (state, juce::Identifier ("amount"),  um, 0.0f);
            modelId.referTo        (state, juce::Identifier ("modelId"), um, juce::String());
            labMode.referTo        (state, juce::Identifier ("labMode"), um, false);
            latencySeconds.referTo (state, juce::Identifier ("latency"), um, 0.0f);

            // The model "amount" macro — a 0..1 raw param the ASTD command layer drives
            // (clamped below quality-collapse unless Lab mode unlocks the full range).
            amountParam = addParam ("amount", TRANS ("Amount"), { 0.0f, 1.0f });
            amountParam->attachToCurrentValue (amountValue);
        }

        ~NeuralInsertPlugin() override
        {
            notifyListenersOfDeletion();
            amountParam->detachFromCurrentValue();
        }

        juce::String getName() const override            { return getPluginName(); }
        juce::String getPluginType() override            { return xmlTypeName; }
        juce::String getSelectableDescription() override { return getName(); }

        void initialise (const te::PluginInitialisationInfo&) override {}   // anira warm-up → macOS
        void deinitialise() override {}

        void applyToBuffer (const te::PluginRenderContext& fc) override
        {
            // PASSTHROUGH (identity) until the anira model is wired in. RT-safe: no
            // allocations, no locks. The neural inference replaces this body on macOS.
            juce::ignoreUnused (fc);
        }

        // The TRUE delay the host uses for plugin-delay compensation (04). Passthrough
        // = 0; the neural model reports its real algorithmic latency here so the PDC
        // null test passes (no drift vs a dry copy).
        double getLatencySeconds() override { return (double) latencySeconds.get(); }

        void restorePluginStateFromValueTree (const juce::ValueTree& v) override
        {
            // copyPropertiesToCachedValues does ValueType(var), which only works for
            // numerics — restore the String/bool members explicitly.
            te::copyPropertiesToCachedValues (v, amountValue, latencySeconds);

            const juce::Identifier mId ("modelId"), lId ("labMode");
            if (v.hasProperty (mId)) modelId = v[mId].toString(); else modelId.resetToDefault();
            if (v.hasProperty (lId)) labMode = (bool) v[lId];      else labMode.resetToDefault();

            for (auto p : getAutomatableParameters())
                p->updateFromAttachedValue();
        }

        // ── accessors for the ASTD command layer + tests ─────────────────────
        float        getAmount() const            { return amountValue.get(); }
        void         setAmountRaw (float raw)      { amountValue = raw; }
        bool         isLabMode() const            { return labMode.get(); }
        void         setLabMode (bool b)          { labMode = b; }
        juce::String getModelId() const           { return modelId.get(); }
        void         setModelId (const juce::String& m) { modelId = m; }
        void         setLatencySeconds (float s)  { latencySeconds = s; }

        juce::CachedValue<float>        amountValue, latencySeconds;
        juce::CachedValue<juce::String> modelId;
        juce::CachedValue<bool>         labMode;
        te::AutomatableParameter::Ptr   amountParam;

        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NeuralInsertPlugin)
    };

    // C++17 inline static-member definition keeps this header-only.
    inline const char* NeuralInsertPlugin::xmlTypeName = "neural_insert";
}
