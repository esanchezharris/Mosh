#include "MoshFxPlugins.h"
#include <cmath>

namespace mosh
{
using namespace juce;

const char* MoshSoftClipPlugin::xmlTypeName = "softclip";

namespace
{
    const Identifier idSoftClipDrive ("moshSoftClipDrive");
    const Identifier idSoftClipCeiling ("moshSoftClipCeiling");
}

MoshSoftClipPlugin::MoshSoftClipPlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    auto* um = getUndoManager();
    driveValue.referTo (state, idSoftClipDrive, um, 6.0f);
    ceilingValue.referTo (state, idSoftClipCeiling, um, -0.5f);

    driveParam = addParam ("drive", TRANS ("Drive"), { 0.0f, 24.0f });
    ceilingParam = addParam ("ceiling", TRANS ("Ceiling"), { -12.0f, 0.0f });

    driveParam->attachToCurrentValue (driveValue);
    ceilingParam->attachToCurrentValue (ceilingValue);
}

MoshSoftClipPlugin::~MoshSoftClipPlugin()
{
    notifyListenersOfDeletion();
    driveParam->detachFromCurrentValue();
    ceilingParam->detachFromCurrentValue();
}

void MoshSoftClipPlugin::initialise (const te::PluginInitialisationInfo&)
{
    // Stateless per-sample math — nothing to prepare (see applyToBuffer).
}

void MoshSoftClipPlugin::deinitialise()
{
}

void MoshSoftClipPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    auto* buf = fc.destBuffer;
    if (buf == nullptr || ! isEnabled())
        return;

    // Plain per-sample tanh soft clip, honestly: NO oversampling and NO lookahead.
    // Driving this hard will alias like any un-oversampled waveshaper — that's a
    // known, accepted tradeoff for this v1 built-in, not an oversight. Latency is
    // exactly zero.
    //
    //   y = ceiling * tanh(x * driveGain / ceiling)
    //
    // with driveGain/ceiling converted from their dB/dBFS parameters to linear gain.
    const float driveGain = Decibels::decibelsToGain (driveValue.get());
    const float ceilingLin = jmax (1.0e-6f, Decibels::decibelsToGain (ceilingValue.get()));

    for (int ch = 0; ch < buf->getNumChannels(); ++ch)
    {
        auto* data = buf->getWritePointer (ch, fc.bufferStartSample);
        for (int i = 0; i < fc.bufferNumSamples; ++i)
            data[i] = ceilingLin * std::tanh (data[i] * driveGain / ceilingLin);
    }
}

void MoshSoftClipPlugin::restorePluginStateFromValueTree (const ValueTree& v)
{
    te::copyPropertiesToCachedValues (v, driveValue, ceilingValue);
    for (auto p : getAutomatableParameters())
        p->updateFromAttachedValue();
}

var MoshSoftClipPlugin::describeMoshFx() const
{
    auto* o = new DynamicObject();
    o->setProperty ("kind", "softclip");
    o->setProperty ("driveDb", driveValue.get());
    o->setProperty ("ceilingDb", ceilingValue.get());
    return var (o);
}
}
