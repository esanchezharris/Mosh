#include "RaveInsertPlugin.h"

#if MOSH_HAVE_ANIRA

namespace mosh
{
using namespace juce;

const char* RaveInsertPlugin::xmlTypeName = "moshRaveInsert";

namespace
{
    const Identifier idMix  ("raveMix");
    const Identifier idPath ("ravePath");
    const Identifier idName ("raveName");
}

RaveInsertPlugin::RaveInsertPlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    auto* um = getUndoManager();
    mixValue.referTo  (state, idMix,  um, 1.0f);
    modelPath.referTo (state, idPath, um, String());
    modelName.referTo (state, idName, um, String());

    mixParam = addParam ("mix", TRANS ("Mix"), { 0.0f, 1.0f });
    mixParam->attachToCurrentValue (mixValue);
}

RaveInsertPlugin::~RaveInsertPlugin()
{
    notifyListenersOfDeletion();
    mixParam->detachFromCurrentValue();
}

void RaveInsertPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    sr        = info.sampleRate      > 0   ? info.sampleRate      : 44100.0;
    blockSize = info.blockSizeSamples > 0  ? info.blockSizeSamples : 512;

    dryRing.setSize    (1, kMaxDelay, false, true, true); dryRing.clear();
    monoBuf.setSize    (1, kMaxBlock, false, true, true); monoBuf.clear();
    dryAligned.setSize (1, kMaxBlock, false, true, true); dryAligned.clear();
    dryWritePos = 0;

    engine.prepare (sr, blockSize);

    // Re-load a persisted model on the message thread (initialise runs there once the
    // plugin is prepared with its state in place). No-op when no path / file missing.
    const auto p = modelPath.get();
    if (p.isNotEmpty() && engine.loadModel (p.toStdString()))
        modelLoaded.store (true);
}

void RaveInsertPlugin::deinitialise()
{
    dryRing.clear();
}

double RaveInsertPlugin::getLatencySeconds()
{
    const auto s = sr > 0 ? sr : 44100.0;
    return (modelLoaded.load() && engine.ready()) ? (double) engine.latencySamples() / s : 0.0;
}

void RaveInsertPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    auto* buf = fc.destBuffer;
    if (buf == nullptr) return;

    const int numCh = jmin (buf->getNumChannels(), kMaxChannels);
    const int n = jmin (fc.bufferNumSamples, kMaxBlock);
    const int start = fc.bufferStartSample;
    const bool enabled = isEnabled();

    // No model ready → clean passthrough (getLatencySeconds reports 0, so PDC is a no-op).
    if (! (modelLoaded.load() && engine.ready()))
        return;

    const int L = jlimit (0, kMaxDelay - 1, engine.latencySamples());
    float* ring = dryRing.getWritePointer (0);
    float* m    = monoBuf.getWritePointer (0);
    float* dA   = dryAligned.getWritePointer (0);

    // Down-mix to mono, capture the dry delayed by exactly L (to align with anira's
    // latency-delayed wet), and feed the dry mono to the model in `m`.
    int wp = dryWritePos;
    for (int i = 0; i < n; ++i)
    {
        float dry = 0.0f;
        for (int ch = 0; ch < numCh; ++ch) dry += buf->getSample (ch, start + i);
        dry /= (numCh > 0 ? (float) numCh : 1.0f);

        int rp = wp - L; if (rp < 0) rp += kMaxDelay;
        dA[i] = (L > 0) ? ring[rp] : dry;
        ring[wp] = dry; if (++wp >= kMaxDelay) wp = 0;
        m[i] = dry;
    }
    dryWritePos = wp;

    // Wet path: in-place transform (RT-safe; latency-delayed by L). On bypass we skip
    // inference and emit the L-delayed dry, so latency stays constant (no PDC jump).
    if (enabled)
        engine.process (m, n);

    const float mix = jlimit (0.0f, 1.0f, mixValue.get());
    for (int i = 0; i < n; ++i)
    {
        const float out = enabled ? ((1.0f - mix) * dA[i] + mix * m[i]) : dA[i];
        for (int ch = 0; ch < numCh; ++ch)
            buf->setSample (ch, start + i, out);
    }
}

void RaveInsertPlugin::restorePluginStateFromValueTree (const juce::ValueTree& v)
{
    te::copyPropertiesToCachedValues (v, mixValue, modelPath, modelName);
    for (auto p : getAutomatableParameters())
        p->updateFromAttachedValue();
    // The model file is re-loaded in initialise() (message thread, after prepare).
}

void RaveInsertPlugin::setMixUi (float ui0to100)
{
    mixParam->setParameter (jlimit (0.0f, 1.0f, ui0to100 / 100.0f), sendNotification);
}

bool RaveInsertPlugin::loadModelFromFile (const juce::File& tsFile)
{
    if (! tsFile.existsAsFile())
        return false;
    const bool ok = engine.loadModel (tsFile.getFullPathName().toStdString());
    if (ok)
    {
        modelPath = tsFile.getFullPathName();
        modelName = tsFile.getFileNameWithoutExtension();
        modelLoaded.store (true);
        changed();                      // graph latency changed → Tracktion re-PDC
    }
    return ok;
}

void RaveInsertPlugin::resetModel()
{
    engine.reset();
    dryRing.clear();
    dryWritePos = 0;
}

juce::var RaveInsertPlugin::describe() const
{
    auto* o = new DynamicObject();
    o->setProperty ("model", modelName.get().isNotEmpty() ? modelName.get() : String ("rave"));
    o->setProperty ("modelName", modelName.get());
    o->setProperty ("modelPath", modelPath.get());
    o->setProperty ("modelLoaded", modelLoaded.load());
    o->setProperty ("mix", jlimit (0.0f, 1.0f, mixValue.get()) * 100.0f);
    o->setProperty ("latencySamples", engine.latencySamples());
    o->setProperty ("latencySeconds", (double) engine.latencySamples() / (sr > 0 ? sr : 44100.0));
    return juce::var (o);
}

} // namespace mosh

#endif // MOSH_HAVE_ANIRA
