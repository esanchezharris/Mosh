#include "MoshFxPlugins.h"

namespace mosh
{
using namespace juce;

const char* MoshOTTPlugin::xmlTypeName = "moshOTT";

namespace
{
    const Identifier idOttAmount ("moshOttAmount");
    const Identifier idOttTime ("moshOttTime");
    const Identifier idOttLow ("moshOttLow");
    const Identifier idOttMid ("moshOttMid");
    const Identifier idOttHigh ("moshOttHigh");
    const Identifier idOttMix ("moshOttMix");
    const Identifier idOttOutput ("moshOttOutput");

    moshfx::OTTSettings ottSettings (float amount, float time, float low, float mid, float high,
                                     float mix, float output)
    {
        moshfx::OTTSettings s;
        s.amount = jlimit (0.0f, 1.0f, amount);
        s.timeMs = time;
        s.lowGainDb = low;
        s.midGainDb = mid;
        s.highGainDb = high;
        s.mix = jlimit (0.0f, 1.0f, mix);
        s.outputDb = output;
        return s;
    }
}

MoshOTTPlugin::MoshOTTPlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    auto* um = getUndoManager();
    amountValue.referTo (state, idOttAmount, um, 0.12f);
    timeValue.referTo (state, idOttTime, um, 120.0f);
    lowGainValue.referTo (state, idOttLow, um, 0.0f);
    midGainValue.referTo (state, idOttMid, um, 0.0f);
    highGainValue.referTo (state, idOttHigh, um, 0.0f);
    mixValue.referTo (state, idOttMix, um, 1.0f);
    outputValue.referTo (state, idOttOutput, um, -1.0f);

    amountParam = addParam ("amount", TRANS ("Amount"), { 0.0f, 1.0f });
    timeParam = addParam ("time", TRANS ("Time"), { 5.0f, 500.0f });
    lowGainParam = addParam ("low", TRANS ("Low Gain"), { -12.0f, 12.0f });
    midGainParam = addParam ("mid", TRANS ("Mid Gain"), { -12.0f, 12.0f });
    highGainParam = addParam ("high", TRANS ("High Gain"), { -12.0f, 12.0f });
    mixParam = addParam ("mix", TRANS ("Mix"), { 0.0f, 1.0f });
    outputParam = addParam ("output", TRANS ("Output"), { -18.0f, 6.0f });

    amountParam->attachToCurrentValue (amountValue);
    timeParam->attachToCurrentValue (timeValue);
    lowGainParam->attachToCurrentValue (lowGainValue);
    midGainParam->attachToCurrentValue (midGainValue);
    highGainParam->attachToCurrentValue (highGainValue);
    mixParam->attachToCurrentValue (mixValue);
    outputParam->attachToCurrentValue (outputValue);
}

MoshOTTPlugin::~MoshOTTPlugin()
{
    notifyListenersOfDeletion();
    amountParam->detachFromCurrentValue();
    timeParam->detachFromCurrentValue();
    lowGainParam->detachFromCurrentValue();
    midGainParam->detachFromCurrentValue();
    highGainParam->detachFromCurrentValue();
    mixParam->detachFromCurrentValue();
    outputParam->detachFromCurrentValue();
}

void MoshOTTPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    const auto sr = info.sampleRate > 0.0 ? info.sampleRate : 48000.0;
    for (auto& c : cores)
        c.prepare (sr);
}

void MoshOTTPlugin::deinitialise()
{
    for (auto& c : cores)
        c.reset();
}

void MoshOTTPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    auto* buf = fc.destBuffer;
    if (buf == nullptr || ! isEnabled())
        return;

    const auto settings = ottSettings (amountValue.get(), timeValue.get(), lowGainValue.get(),
                                       midGainValue.get(), highGainValue.get(), mixValue.get(),
                                       outputValue.get());
    const int channels = jmin (buf->getNumChannels(), (int) cores.size());
    for (int ch = 0; ch < channels; ++ch)
        cores[(size_t) ch].processBlock (buf->getWritePointer (ch, fc.bufferStartSample), fc.bufferNumSamples, settings);
}

void MoshOTTPlugin::restorePluginStateFromValueTree (const ValueTree& v)
{
    te::copyPropertiesToCachedValues (v, amountValue, timeValue, lowGainValue, midGainValue, highGainValue, mixValue, outputValue);
    for (auto p : getAutomatableParameters())
        p->updateFromAttachedValue();
}

var MoshOTTPlugin::describeMoshFx() const
{
    auto* o = new DynamicObject();
    o->setProperty ("kind", "ott");
    o->setProperty ("amount", amountValue.get());
    o->setProperty ("timeMs", timeValue.get());
    return var (o);
}
}
