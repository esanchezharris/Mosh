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
    const Identifier idModelPath ("neuralModelPath");   // GAP 1 — persisted RTNeural file path

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
    modelPath.referTo    (state, idModelPath, um, String());

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

    // GAP 1 — if a model path persisted (e.g. after a session reload) but isn't loaded
    // yet, load it now on the message thread. This is the deterministic re-load hook:
    // restorePluginStateFromValueTree may run before the CachedValues settle, but
    // initialise() runs once the plugin is prepared with its state in place. No-op when
    // already loaded or when no path is set; graceful when the file is missing.
   #if MOSH_HAVE_RTNEURAL
    if (! rtnReady.load (std::memory_order_acquire))
    {
        const auto p = modelPath.get();
        if (p.isNotEmpty())
            loadModelFromFile (juce::File (p));
    }
   #endif
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

float NeuralInsertPlugin::inferSample (float x, float driveRaw) const
{
    // RT-safe dispatch. When a real RTNeural model is loaded and ready, run it; else
    // fall back to the self-contained inline MLP. The acquire-load pairs with the
    // release-store in loadModelFromFile so we only ever read a fully-built model.
   #if MOSH_HAVE_RTNEURAL
    if (rtnReady.load (std::memory_order_acquire) && rtnModel != nullptr)
    {
        // Drive-condition the input the same way the inline path does, so the ASTD
        // drive knob still shapes the sound, then run the loaded waveshaper. forward()
        // is RT-safe (preallocated internal buffers) and reads model weights only.
        const float in = driveRaw * x;
        float y = rtnModel->forward (&in);
        // Residual ("skip") captures (GuitarML/NeuralPi) learn only the delta the amp
        // adds, so the full output is net(in) + in. Full-output models (AIDA-X) don't.
        if (modelSkip.load (std::memory_order_relaxed))
            y += in;
        return std::tanh (y);   // bound the output (clean silence-in → silence-out for in=0)
    }
   #endif
    return runModel (x, driveRaw);
}

bool NeuralInsertPlugin::loadModelFromFile (const juce::File& jsonFile, int forceSkip)
{
   #if MOSH_HAVE_RTNEURAL
    // MESSAGE THREAD ONLY — all file I/O, JSON parse, allocation and warm-up happen
    // here, never on the audio thread.
    if (! jsonFile.existsAsFile())
        return false;

    // Skip/residual: the command can force it; otherwise the model self-describes via a
    // top-level "mosh_skip" bool (ignored by RTNeural's json_parser). Parsed here on the
    // message thread; published below before the rtnReady release-store.
    bool skip = false;
    if (forceSkip >= 0)
        skip = (forceSkip != 0);
    else if (auto parsed = juce::JSON::parse (jsonFile.loadFileAsString()); auto* o = parsed.getDynamicObject())
        skip = (bool) o->getProperty ("mosh_skip");

    std::unique_ptr<RTNeural::Model<float>> built;
    try
    {
        std::ifstream stream (jsonFile.getFullPathName().toStdString());
        if (! stream.is_open())
            return false;
        built = RTNeural::json_parser::parseJson<float> (stream, /*debug*/ false);
    }
    catch (...) { built = nullptr; }

    // The fixture is a single-sample (in_size==1) waveshaper. Reject anything else so a
    // malformed/mismatched file degrades gracefully (keeps the inline fallback) rather
    // than reading out of bounds on the audio thread.
    if (built == nullptr || built->getInSize() != 1)
        return false;

    // Warm up + zero the state on the message thread so the first audio block doesn't
    // stall and we don't leak transient state into the first samples.
    built->reset();
    for (int i = 0; i < 64; ++i) { const float z = 0.0f; (void) built->forward (&z); }
    built->reset();

    // Publish: keep the OLD model alive (rtnModelOld) until the next swap so the audio
    // thread never frees on the RT path; move the new one in; release-store readiness.
    rtnModelOld = std::move (rtnModel);
    rtnModel    = std::move (built);
    modelSkip.store (skip, std::memory_order_relaxed);   // published by the release-store below
    rtnReady.store (true, std::memory_order_release);

    modelPath = jsonFile.getFullPathName();
    return true;
   #else
    juce::ignoreUnused (jsonFile, forceSkip);
    return false;   // graceful no-op when the RTNeural backend isn't built
   #endif
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
            // inferSample dispatches to the loaded RTNeural model when ready, else the
            // inline MLP (both RT-safe / zero-alloc).
            const float y = enabled ? (x + mix * (inferSample (x, drive) - x)) : x;

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
    te::copyPropertiesToCachedValues (v, driveValue, mixValue, latencyValue, labMode);

    if (v.hasProperty (idModel))
        modelId = v.getProperty (idModel).toString();

    // GAP 1 — restore the persisted RTNeural model path and re-load the file (message
    // thread; restore runs there). Read from the value tree when present, else fall back
    // to the CachedValue (referTo() already re-read it from `state` at construction). A
    // missing/invalid file degrades gracefully to the inline MLP (loadModelFromFile
    // returns false; readiness stays false → inline fallback).
    if (v.hasProperty (idModelPath))
        modelPath = v.getProperty (idModelPath).toString();
    {
        const auto p = modelPath.get();
        if (p.isNotEmpty())
            loadModelFromFile (juce::File (p));
    }

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

    // Also reset the loaded RTNeural model's internal state (a no-op for stateless
    // dense waveshapers, load-bearing for recurrent captures). Safe on the message
    // thread; the audio thread tolerates a concurrent reset of a stateless model.
   #if MOSH_HAVE_RTNEURAL
    if (rtnModel != nullptr)
        rtnModel->reset();
   #endif
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
    // GAP 1 — the loaded real-model identity. modelName is the human/model id (falls
    // back to the inline model id); modelPath is the loaded RTNeural file ("" when the
    // inline MLP is active). modelLoaded reflects the live readiness flag.
    o->setProperty ("modelName", modelId.get());
    o->setProperty ("modelPath", modelPath.get());
    o->setProperty ("modelLoaded", rtnReady.load (std::memory_order_acquire));
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
