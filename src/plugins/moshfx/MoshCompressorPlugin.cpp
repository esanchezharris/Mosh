#include "MoshCompressorPlugin.h"
#include "audio/RealtimeAudioGuard.h"

#include <cmath>
#include <cstring>

namespace mosh
{
using namespace juce;

MoshCompressorPlugin::MoshCompressorPlugin (te::PluginCreationInfo info) : te::CompressorPlugin (info)
{
}

MoshCompressorPlugin::~MoshCompressorPlugin() = default;

void MoshCompressorPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    te::CompressorPlugin::initialise (info);

    // The measuring copy. Sized here, on the message thread, and only ever grown, so
    // the audio thread never allocates; a block longer than this is processed normally
    // and simply not measured.
    const int wanted = jmax (info.blockSizeSamples, 4096);
    if (wanted > scratchSamples)
    {
        scratch.setSize (2, wanted, false, false, true);
        scratchSamples = wanted;
    }
}

void MoshCompressorPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    MOSH_RT_SCOPE();
    auto* buf = fc.destBuffer;
    const int n = fc.bufferNumSamples;
    const int channels = buf != nullptr ? jmin (2, buf->getNumChannels()) : 0;
    const bool measure = channels > 0 && n > 0 && n <= scratchSamples && isEnabled();

    // The makeup gain the base class is about to apply, read the same way it reads it.
    // The base reads outputDb again itself; a message-thread write between the two
    // reads (an Output drag) would make |out|/|in| disagree with this makeup, so the
    // value is re-read afterwards and the block's gain reduction dropped if it moved.
    const float makeupDbBefore = measure ? outputDb.getCurrentValue() : 0.0f;
    const float makeup = measure ? te::dbToGain (makeupDbBefore) : 1.0f;
    if (measure)
        for (int ch = 0; ch < channels; ++ch)
            scratch.copyFrom (ch, 0, *buf, ch, fc.bufferStartSample, n);

    // The audio: Tracktion's compressor, bit for bit.
    te::CompressorPlugin::applyToBuffer (fc);

    if (! measure)
        return;

    float inPeak = 0.0f, outPeak = 0.0f, smallestGain = -1.0f;
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* in = scratch.getReadPointer (ch);
        const float* out = buf->getReadPointer (ch, fc.bufferStartSample);
        for (int i = 0; i < n; ++i)
        {
            const float ai = std::abs (in[i]), ao = std::abs (out[i]);
            inPeak = jmax (inPeak, ai);
            outPeak = jmax (outPeak, ao);
            if (ai > 1.0e-4f)   // -80 dBFS: below it the ratio is rounding noise
            {
                const float g = ao / ai;
                if (smallestGain < 0.0f || g < smallestGain)
                    smallestGain = g;
            }
        }
    }

    meter.accumulateMax (0, inPeak);
    meter.accumulateMax (1, outPeak);
    const float makeupDbAfter = outputDb.getCurrentValue();
    const bool makeupSteady = std::memcmp (&makeupDbBefore, &makeupDbAfter, sizeof (float)) == 0;
    if (makeupSteady)
    {
        if (smallestGain > 0.0f && makeup > 0.0f)
            meter.accumulateMax (2, 20.0f * std::log10 (makeup / smallestGain));
        else if (smallestGain == 0.0f)
            meter.accumulateMax (2, 100.0f);   // fully gated: as much reduction as we report
    }
    meter.publish();
}

var MoshCompressorPlugin::takeLiveMeters()
{
    const auto reading = meter.take();
    if (! reading.live)
        return {};
    auto* o = new DynamicObject();
    o->setProperty ("grDb", finiteDb (reading.maxima[2], 0.0f, 100.0f));
    o->setProperty ("inDb", meterDb (reading.maxima[0]));
    o->setProperty ("outDb", meterDb (reading.maxima[1]));
    return var (o);
}
}
