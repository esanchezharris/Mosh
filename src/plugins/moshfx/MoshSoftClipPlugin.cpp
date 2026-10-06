#include "MoshFxPlugins.h"
#include "audio/RealtimeAudioGuard.h"
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
    MOSH_RT_SCOPE();
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

    // Live meter (plugin_meters rail): input and output sample peaks, and the gain
    // reduction the curve applied, 20*log10(|driveGain*x| / |y|) — how far below the
    // straight driven line the output sits. Measured only on samples above -80 dBFS,
    // where the ratio means something; quiet samples pass the curve almost linearly.
    float inPeak = 0.0f, outPeak = 0.0f, worstRatio = 1.0f;
    for (int ch = 0; ch < buf->getNumChannels(); ++ch)
    {
        auto* data = buf->getWritePointer (ch, fc.bufferStartSample);
        for (int i = 0; i < fc.bufferNumSamples; ++i)
        {
            const float x = data[i];
            const float y = ceilingLin * std::tanh (x * driveGain / ceilingLin);
            data[i] = y;
            const float ax = std::abs (x), ay = std::abs (y);
            inPeak = jmax (inPeak, ax);
            outPeak = jmax (outPeak, ay);
            if (ax > 1.0e-4f && ay > 0.0f)
                worstRatio = jmax (worstRatio, ax * driveGain / ay);
        }
    }
    meter.accumulateMax (0, inPeak);
    meter.accumulateMax (1, outPeak);
    meter.accumulateMax (2, 20.0f * std::log10 (worstRatio));
    meter.publish();
}

var MoshSoftClipPlugin::takeLiveMeters()
{
    const auto reading = meter.take();
    if (! reading.live)
        return {};
    auto* o = new DynamicObject();
    o->setProperty ("grDb", jmax (0.0f, reading.maxima[2]));
    o->setProperty ("inDb", meterDb (reading.maxima[0]));
    o->setProperty ("outDb", meterDb (reading.maxima[1]));
    return var (o);
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
