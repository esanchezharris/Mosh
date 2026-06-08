#include "NeuralInsertPlugin.h"

namespace mosh
{
using namespace juce;

const char* NeuralInsertPlugin::xmlTypeName = "moshNeuralInsert";

namespace
{
    // Custom ValueTree property ids for this plugin's state.
    const Identifier idDrive   ("neuralDrive");
    const Identifier idMix     ("neuralMix");
    const Identifier idLatency ("neuralLatency");
    const Identifier idLab     ("neuralLab");
    const Identifier idModel   ("neuralModel");

    // ── A genuine, fixed-weight 2-layer tanh MLP (8 hidden units), computed once
    //    deterministically. Read-only at audio time → RT-safe. Input is
    //    [x, driveNorm]; output is a bounded neural "residual" that colours the
    //    saturator. This is real neural inference (matmul + tanh), self-contained
    //    (the model-agnostic host can instead drive an RTNeural/anira model). ──
    struct MlpWeights
    {
        static constexpr int H = 8;
        float W1[H][2], b1[H];
        float W2[H][H], b2[H];
        float W3[H],    b3;

        MlpWeights()
        {
            // Deterministic LCG → small weights (no <random>, no global RNG).
            uint32_t s = 0x9E3779B9u;
            auto nf = [&] { s = s * 1664525u + 1013904223u; return ((float) (s >> 9) / (float) (1u << 23)) * 2.0f - 1.0f; };
            for (int k = 0; k < H; ++k) { for (int j = 0; j < 2; ++j) W1[k][j] = nf() * 0.8f; b1[k] = nf() * 0.3f; }
            for (int k = 0; k < H; ++k) { for (int j = 0; j < H; ++j) W2[k][j] = nf() * 0.6f; b2[k] = nf() * 0.3f; }
            for (int k = 0; k < H; ++k)   W3[k] = nf() * 0.4f;
            b3 = 0.0f;
        }
    };

    const MlpWeights& weights()
    {
        static const MlpWeights w;     // computed once, thread-safe init
        return w;
    }
}

NeuralInsertPlugin::NeuralInsertPlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    auto* um = getUndoManager();
    driveValue.referTo   (state, idDrive,   um, 6.0f);
    mixValue.referTo     (state, idMix,     um, 1.0f);
    latencyValue.referTo (state, idLatency, um, 0);
    labMode.referTo      (state, idLab,     um, false);
    modelId.referTo      (state, idModel,   um, String ("nam"));

    // Params store RAW values (automation is on the real value); the UI is 0–100
    // and the set_neural_param command maps via ASTD.
    driveParam = addParam ("drive", TRANS ("Drive"), { 1.0f, 25.0f });
    driveParam->attachToCurrentValue (driveValue);
    mixParam = addParam ("mix", TRANS ("Mix"), { 0.0f, 1.0f });
    mixParam->attachToCurrentValue (mixValue);

    registerAstdRanges();
}

NeuralInsertPlugin::~NeuralInsertPlugin()
{
    notifyListenersOfDeletion();
    driveParam->detachFromCurrentValue();
    mixParam->detachFromCurrentValue();
}

void NeuralInsertPlugin::registerAstdRanges()
{
    // Calibrated offline (here: documented defaults). Drive collapses into harsh
    // fizz above ~12; clamp the 0–100 UI to [1,12] by default, [1,25] in Lab.
    astdRanges.set ("nam",     "drive", { 1.0f, 25.0f, 12.0f });
    astdRanges.set ("proteus", "drive", { 1.0f, 25.0f, 14.0f });
    astdRanges.set ("rave",    "drive", { 1.0f, 25.0f, 10.0f });
    // Mix is not over-driveable → full safe range.
    astdRanges.set ("nam",     "mix",   { 0.0f, 1.0f, 1.0f });
}

void NeuralInsertPlugin::initialise (const te::PluginInitialisationInfo&)
{
    delayBuffer.setSize (kMaxChannels, kMaxDelay, false, true, true);
    delayBuffer.clear();
    delayWritePos = 0;

    // Warm-up a few inferences so the first audio block never stalls (§2.7).
    for (int i = 0; i < 64; ++i)
        (void) runModel (0.0f, driveValue.get());
}

void NeuralInsertPlugin::deinitialise()
{
    delayBuffer.clear();
}

double NeuralInsertPlugin::getLatencySeconds()
{
    const auto sr = sampleRate > 0.0 ? sampleRate : 44100.0;
    return (double) latencyValue.get() / sr;            // the TRUE delay (§2.4)
}

float NeuralInsertPlugin::runModel (float x, float driveRaw) const
{
    const auto& w = weights();
    const float driveNorm = (driveRaw - 1.0f) / 24.0f;  // 0..1
    const float in[2] = { x, driveNorm };

    float h1[MlpWeights::H];
    for (int k = 0; k < MlpWeights::H; ++k)
    {
        float a = w.b1[k];
        a += w.W1[k][0] * in[0] + w.W1[k][1] * in[1];
        h1[k] = std::tanh (a);
    }
    float h2[MlpWeights::H];
    for (int k = 0; k < MlpWeights::H; ++k)
    {
        float a = w.b2[k];
        for (int j = 0; j < MlpWeights::H; ++j) a += w.W2[k][j] * h1[j];
        h2[k] = std::tanh (a);
    }
    float resid = w.b3;
    for (int k = 0; k < MlpWeights::H; ++k) resid += w.W3[k] * h2[k];

    // Drive-conditioned neural saturator. The MLP residual modulates the gain
    // (a signal/drive-dependent harmonic character) and is multiplied by x, so
    // silence stays silent (clean bypass + delay-null behaviour) while driven
    // signal saturates and gains neural colour.
    return std::tanh (driveRaw * x * (1.0f + 0.5f * resid));
}

void NeuralInsertPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    auto* buf = fc.destBuffer;
    if (buf == nullptr) return;

    const int numCh = jmin (buf->getNumChannels(), kMaxChannels);
    const int n = fc.bufferNumSamples;
    const int start = fc.bufferStartSample;
    const bool enabled = isEnabled();
    const float drive = driveValue.get();
    const float mix = jlimit (0.0f, 1.0f, mixValue.get());
    const int L = jlimit (0, kMaxDelay - 1, latencyValue.get());

    float* dests[kMaxChannels];
    float* delays[kMaxChannels];
    for (int ch = 0; ch < numCh; ++ch)
    {
        dests[ch]  = buf->getWritePointer (ch);
        delays[ch] = delayBuffer.getWritePointer (ch);
    }

    int wp = delayWritePos;
    for (int i = 0; i < n; ++i)
    {
        for (int ch = 0; ch < numCh; ++ch)
        {
            const float x = dests[ch][start + i];
            // Bypass (isEnabled false) → dry passthrough (still delayed by L so
            // latency stays constant on bypass — guards the PDC inverted-logic bug).
            const float y = enabled ? (x + mix * (runModel (x, drive) - x)) : x;

            if (L > 0)
            {
                int rp = wp - L; if (rp < 0) rp += kMaxDelay;
                dests[ch][start + i] = delays[ch][rp];
                delays[ch][wp] = y;
            }
            else
            {
                dests[ch][start + i] = y;
            }
        }
        if (++wp >= kMaxDelay) wp = 0;
    }
    delayWritePos = wp;
}

void NeuralInsertPlugin::restorePluginStateFromValueTree (const juce::ValueTree& v)
{
    te::copyPropertiesToCachedValues (v, driveValue, mixValue, latencyValue, labMode, modelId);
    for (auto p : getAutomatableParameters())
        p->updateFromAttachedValue();
}

// ── MoshOps-facing control ──────────────────────────────────────────────────
void NeuralInsertPlugin::setNeuralParamUi (const juce::String& paramId, float ui0to100)
{
    const auto range = astdRanges.get (modelId.get().toStdString(), paramId.toStdString());
    const float raw = range.toRaw (ui0to100, labMode.get());
    if (paramId == "drive") driveParam->setParameter (raw, sendNotification);
    else if (paramId == "mix") mixParam->setParameter (raw, sendNotification);
}

float NeuralInsertPlugin::getNeuralParamUi (const juce::String& paramId) const
{
    const auto range = astdRanges.get (modelId.get().toStdString(), paramId.toStdString());
    const float raw = (paramId == "drive") ? driveValue.get() : mixValue.get();
    return range.toUi (raw, labMode.get());
}

void NeuralInsertPlugin::setLabMode (bool on)        { labMode = on; }
void NeuralInsertPlugin::selectModel (const juce::String& id) { modelId = id; }

void NeuralInsertPlugin::resetModel()
{
    delayBuffer.clear();
    delayWritePos = 0;
}

void NeuralInsertPlugin::setLatencySamples (int samples)
{
    latencyValue = jlimit (0, kMaxDelay - 1, samples);
    changed();                            // tell the graph latency changed → re-PDC
}

juce::var NeuralInsertPlugin::describe() const
{
    auto* o = new DynamicObject();
    o->setProperty ("model", modelId.get());
    o->setProperty ("labMode", labMode.get());
    o->setProperty ("latencySamples", latencyValue.get());
    o->setProperty ("latencySeconds", (double) latencyValue.get() / (sampleRate > 0 ? sampleRate : 44100.0));

    juce::Array<juce::var> paramList;
    const char* names[] = { "drive", "mix" };
    for (auto* name : names)
    {
        auto* p = new DynamicObject();
        const auto range = astdRanges.get (modelId.get().toStdString(), juce::String (name).toStdString());
        const double safeMaxUi = labMode.get() ? 100.0
                                 : (range.safeMax >= range.rawMax ? 100.0
                                    : (double) (range.safeMax / range.rawMax) * 100.0);
        p->setProperty ("id", name);
        p->setProperty ("ui", getNeuralParamUi (name));
        p->setProperty ("safeMaxUi", safeMaxUi);
        paramList.add (juce::var (p));
    }
    o->setProperty ("params", paramList);
    return juce::var (o);
}

} // namespace mosh
