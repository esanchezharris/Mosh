#include "MoshFxPlugins.h"

namespace mosh
{
using namespace juce;

const char* MoshXFeedbackPlugin::xmlTypeName = "moshXFeedback";

namespace
{
    const Identifier idFbSensitivity ("moshXFeedbackSensitivity");
    const Identifier idFbMaxCuts ("moshXFeedbackMaxCuts");
    const Identifier idFbMaxDepth ("moshXFeedbackMaxDepth");
    const Identifier idFbRelease ("moshXFeedbackRelease");
    const Identifier idFbAutoSuppress ("moshXFeedbackAutoSuppress");
    const Identifier idFbMix ("moshXFeedbackMix");
    const Identifier idFbOutput ("moshXFeedbackOutput");
    const Identifier idFbTelemetry ("moshXFeedbackTelemetryId");

    struct XFeedbackTelemetrySlot
    {
        std::atomic<uint64_t> key { 0 };
        std::array<std::atomic<double>, 4> candidateHz {};
        std::array<std::atomic<float>, 4> candidateScore {};
        std::array<std::atomic<double>, 4> activeHz {};
        std::array<std::atomic<float>, 4> activeScore {};
        std::array<std::atomic<float>, 4> activeDepth {};
        std::atomic<int> numCandidates { 0 };
        std::atomic<int> numActive { 0 };
    };

    std::array<XFeedbackTelemetrySlot, 64>& telemetrySlots()
    {
        static std::array<XFeedbackTelemetrySlot, 64> slots;
        return slots;
    }

    uint64_t makeTelemetryKey (ValueTree& state)
    {
        if (! state.hasProperty (idFbTelemetry))
            state.setProperty (idFbTelemetry, Uuid().toString(), nullptr);

        auto hash = (uint64_t) state.getProperty (idFbTelemetry).toString().hashCode64();
        return hash != 0 ? hash : 1;
    }

    XFeedbackTelemetrySlot& telemetrySlotFor (uint64_t key)
    {
        auto& slots = telemetrySlots();
        return slots[(size_t) (key % (uint64_t) slots.size())];
    }

    moshfx::XFeedbackSettings xFeedbackSettings (float sensitivity, float maxCuts, float maxDepth,
                                                 float release, float autoSuppress, float mix, float output)
    {
        moshfx::XFeedbackSettings s;
        s.sensitivity = jlimit (0.0f, 1.0f, sensitivity);
        s.maxCuts = jlimit (1, 4, roundToInt (maxCuts));
        s.maxDepthDb = maxDepth;
        s.releaseMs = release;
        s.autoSuppress = autoSuppress >= 0.5f;
        s.mix = jlimit (0.0f, 1.0f, mix);
        s.outputDb = output;
        return s;
    }

    var candidateArray (const std::array<std::atomic<double>, 4>& hz,
                        const std::array<std::atomic<float>, 4>& score,
                        const std::array<std::atomic<float>, 4>* depth,
                        int count)
    {
        Array<var> arr;
        const auto n = jlimit (0, 4, count);
        for (int i = 0; i < n; ++i)
        {
            auto* o = new DynamicObject();
            o->setProperty ("frequencyHz", hz[(size_t) i].load());
            o->setProperty ("score", score[(size_t) i].load());
            if (depth != nullptr)
                o->setProperty ("depthDb", (*depth)[(size_t) i].load());
            arr.add (var (o));
        }
        return var (arr);
    }

    void publishTelemetry (uint64_t key,
                           const std::array<std::atomic<double>, 4>& candidateHz,
                           const std::array<std::atomic<float>, 4>& candidateScore,
                           const std::array<std::atomic<double>, 4>& activeHz,
                           const std::array<std::atomic<float>, 4>& activeScore,
                           const std::array<std::atomic<float>, 4>& activeDepth,
                           int numCandidates,
                           int numActive)
    {
        if (key == 0)
            return;

        auto& slot = telemetrySlotFor (key);
        for (int i = 0; i < 4; ++i)
        {
            slot.candidateHz[(size_t) i].store (candidateHz[(size_t) i].load());
            slot.candidateScore[(size_t) i].store (candidateScore[(size_t) i].load());
            slot.activeHz[(size_t) i].store (activeHz[(size_t) i].load());
            slot.activeScore[(size_t) i].store (activeScore[(size_t) i].load());
            slot.activeDepth[(size_t) i].store (activeDepth[(size_t) i].load());
        }
        slot.numCandidates.store (numCandidates);
        slot.numActive.store (numActive);
        slot.key.store (key, std::memory_order_release);
    }
}

MoshXFeedbackPlugin::MoshXFeedbackPlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    telemetryKey.store (makeTelemetryKey (state), std::memory_order_relaxed);

    auto* um = getUndoManager();
    sensitivityValue.referTo (state, idFbSensitivity, um, 0.65f);
    maxCutsValue.referTo (state, idFbMaxCuts, um, 2.0f);
    maxDepthValue.referTo (state, idFbMaxDepth, um, 18.0f);
    releaseValue.referTo (state, idFbRelease, um, 500.0f);
    autoSuppressValue.referTo (state, idFbAutoSuppress, um, 0.0f);
    mixValue.referTo (state, idFbMix, um, 1.0f);
    outputValue.referTo (state, idFbOutput, um, 0.0f);

    sensitivityParam = addParam ("sensitivity", TRANS ("Sensitivity"), { 0.0f, 1.0f });
    maxCutsParam = addParam ("max cuts", TRANS ("Max Cuts"), { 1.0f, 4.0f });
    maxDepthParam = addParam ("max depth", TRANS ("Max Depth"), { 3.0f, 36.0f });
    releaseParam = addParam ("release", TRANS ("Release"), { 50.0f, 3000.0f });
    autoSuppressParam = addParam ("auto suppress", TRANS ("Auto Suppress"), { 0.0f, 1.0f });
    mixParam = addParam ("mix", TRANS ("Mix"), { 0.0f, 1.0f });
    outputParam = addParam ("output", TRANS ("Output"), { -18.0f, 6.0f });

    sensitivityParam->attachToCurrentValue (sensitivityValue);
    maxCutsParam->attachToCurrentValue (maxCutsValue);
    maxDepthParam->attachToCurrentValue (maxDepthValue);
    releaseParam->attachToCurrentValue (releaseValue);
    autoSuppressParam->attachToCurrentValue (autoSuppressValue);
    mixParam->attachToCurrentValue (mixValue);
    outputParam->attachToCurrentValue (outputValue);
}

MoshXFeedbackPlugin::~MoshXFeedbackPlugin()
{
    notifyListenersOfDeletion();
    sensitivityParam->detachFromCurrentValue();
    maxCutsParam->detachFromCurrentValue();
    maxDepthParam->detachFromCurrentValue();
    releaseParam->detachFromCurrentValue();
    autoSuppressParam->detachFromCurrentValue();
    mixParam->detachFromCurrentValue();
    outputParam->detachFromCurrentValue();
}

void MoshXFeedbackPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    const auto sr = info.sampleRate > 0.0 ? info.sampleRate : 48000.0;
    for (auto& c : cores)
        c.prepare (sr);
}

void MoshXFeedbackPlugin::deinitialise()
{
    for (auto& c : cores)
        c.reset();
}

void MoshXFeedbackPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    auto* buf = fc.destBuffer;
    if (buf == nullptr || ! isEnabled())
        return;

    const auto settings = xFeedbackSettings (sensitivityValue.get(), maxCutsValue.get(),
                                             maxDepthValue.get(), releaseValue.get(),
                                             autoSuppressValue.get(), mixValue.get(),
                                             outputValue.get());
    const int channels = jmin (buf->getNumChannels(), (int) cores.size());
    for (int ch = 0; ch < channels; ++ch)
    {
        const auto state = cores[(size_t) ch].processBlock (buf->getWritePointer (ch, fc.bufferStartSample),
                                                            fc.bufferNumSamples, settings);
        if (ch != 0)
            continue;

        const auto nc = jmin (4, state.numCandidates);
        const auto na = jmin (4, state.numActive);
        for (int i = 0; i < 4; ++i)
        {
            candidateHz[(size_t) i].store (i < nc ? state.candidates[(size_t) i].frequencyHz : 0.0);
            candidateScore[(size_t) i].store (i < nc ? state.candidates[(size_t) i].score : 0.0f);
            activeHz[(size_t) i].store (i < na ? state.activeCuts[(size_t) i].frequencyHz : 0.0);
            activeScore[(size_t) i].store (i < na ? state.activeCuts[(size_t) i].score : 0.0f);
            activeDepth[(size_t) i].store (i < na ? state.activeCuts[(size_t) i].depthDb : 0.0f);
        }
        numCandidates.store (nc);
        numActive.store (na);
        publishTelemetry (telemetryKey.load (std::memory_order_relaxed), candidateHz, candidateScore,
                          activeHz, activeScore, activeDepth, nc, na);
    }
}

void MoshXFeedbackPlugin::restorePluginStateFromValueTree (const ValueTree& v)
{
    if (v.hasProperty (idFbTelemetry))
        state.setProperty (idFbTelemetry, v.getProperty (idFbTelemetry), nullptr);
    te::copyPropertiesToCachedValues (v, sensitivityValue, maxCutsValue, maxDepthValue, releaseValue,
                                      autoSuppressValue, mixValue, outputValue);
    telemetryKey.store (makeTelemetryKey (state), std::memory_order_relaxed);
    for (auto p : getAutomatableParameters())
        p->updateFromAttachedValue();
}

var MoshXFeedbackPlugin::describeMoshFx() const
{
    const auto key = telemetryKey.load (std::memory_order_relaxed);
    const auto* slot = key != 0 ? &telemetrySlotFor (key) : nullptr;
    const auto useShared = slot != nullptr && slot->key.load (std::memory_order_acquire) == key;

    auto* o = new DynamicObject();
    o->setProperty ("kind", "feedback");
    o->setProperty ("candidates", useShared
                                      ? candidateArray (slot->candidateHz, slot->candidateScore, nullptr, slot->numCandidates.load())
                                      : candidateArray (candidateHz, candidateScore, nullptr, numCandidates.load()));
    o->setProperty ("activeCuts", useShared
                                      ? candidateArray (slot->activeHz, slot->activeScore, &slot->activeDepth, slot->numActive.load())
                                      : candidateArray (activeHz, activeScore, &activeDepth, numActive.load()));
    return var (o);
}
}
