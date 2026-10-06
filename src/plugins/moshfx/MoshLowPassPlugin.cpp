#include "MoshLowPassPlugin.h"
#include "audio/RealtimeAudioGuard.h"

#include <cstring>

namespace mosh
{
namespace design = moshfx::filterdesign;

const juce::Identifier& MoshLowPassPlugin::slopePropertyId()
{
    static const juce::Identifier id ("moshFilterSlope");
    return id;
}

MoshLowPassPlugin::MoshLowPassPlugin (te::PluginCreationInfo info) : te::LowPassPlugin (info)
{
    slope.referTo (state, slopePropertyId(), getUndoManager(), design::kDefaultSlope);
    highPassMirror.store (state.getProperty (te::IDs::mode).toString() == "highpass");
}

MoshLowPassPlugin::~MoshLowPassPlugin() = default;

void MoshLowPassPlugin::valueTreePropertyChanged (juce::ValueTree& tree, const juce::Identifier& id)
{
    te::LowPassPlugin::valueTreePropertyChanged (tree, id);
    // te::LowPassPlugin::isLowPass() is `mode != "highpass"`; same rule, read off the tree.
    if (tree == state && id == te::IDs::mode)
        highPassMirror.store (state.getProperty (te::IDs::mode).toString() == "highpass");
}

void MoshLowPassPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    // Keeps the base consistent (it sets the rate and readies its own filters, which this
    // class never runs).
    te::LowPassPlugin::initialise (info);

    for (int b = 0; b < kBanks; ++b)
        resetBank (b);
    live = 0;
    fadeDone = -1;
    bankOrder[0] = bankOrder[1] = design::orderOf (getSlope());
    lastFreq = frequency->getCurrentValue();
    lastHighPass = highPassMirror.load();
    // An IIRFilter passes audio through untouched until it has coefficients.
    designBank (live, lastFreq, lastHighPass);

    fadeTotal = juce::jmax (1, juce::roundToInt (kSlopeCrossfadeSeconds * info.sampleRate));
    const int wanted = juce::jmax (info.blockSizeSamples, 4096);
    if (wanted > scratchSamples)
    {
        scratch.setSize (kChannels, wanted, false, false, true);
        scratchSamples = wanted;
    }
}

void MoshLowPassPlugin::designBank (int bank, float freq, bool highPass) noexcept
{
    juce::IIRCoefficients sections[kSections];
    const int count = design::design (! highPass, bankOrder[bank], sampleRate, freq, sections);
    for (int ch = 0; ch < kChannels; ++ch)
        for (int s = 0; s < count; ++s)
            banks[bank][ch][s].setCoefficients (sections[s]);
}

void MoshLowPassPlugin::resetBank (int bank) noexcept
{
    for (auto& channel : banks[bank])
        for (auto& section : channel)
            section.reset();
}

void MoshLowPassPlugin::runBank (int bank, int channel, float* samples, int numSamples) noexcept
{
    const int count = design::numSections (bankOrder[bank]);
    for (int s = 0; s < count; ++s)
        banks[bank][channel][s].processSamples (samples, numSamples);
}

void MoshLowPassPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    if (fc.destBuffer == nullptr)
        return;
    MOSH_RT_SCOPE();
    auto& buffer = *fc.destBuffer;
    const int start = fc.bufferStartSample, n = fc.bufferNumSamples;

    // Coefficients follow the cutoff and the mode exactly as te::LowPassPlugin's
    // updateFilters does: recomputed when either changed since the last block (the
    // cutoff compared as a float), with no smoothing and no state reset.
    const float freq = frequency->getCurrentValue();
    const bool highPass = highPassMirror.load();
    if (! juce::exactlyEqual (freq, lastFreq) || highPass != lastHighPass)
    {
        lastFreq = freq;
        lastHighPass = highPass;
        designBank (live, freq, highPass);
        if (fadeDone >= 0)
            designBank (1 - live, freq, highPass);
    }

    // A slope change: start the new cascade from silence and crossfade into it. A change
    // that lands mid-crossfade waits for it to finish, then starts its own.
    const int wanted = design::orderOf (getSlope());
    if (fadeDone < 0 && wanted != bankOrder[live])
    {
        const int next = 1 - live;
        bankOrder[next] = wanted;
        resetBank (next);
        designBank (next, lastFreq, lastHighPass);
        if (scratchSamples > 0)
            fadeDone = 0;
        else
            live = next;   // never initialised with scratch: switch without a fade
    }

    te::clearChannels (buffer, 2, -1, start, n);
    const int channels = juce::jmin (kChannels, buffer.getNumChannels());

    if (fadeDone < 0)
    {
        for (int ch = channels; --ch >= 0;)
            runBank (live, ch, buffer.getWritePointer (ch, start), n);
    }
    else
    {
        const int next = 1 - live;
        for (int done = 0; done < n;)
        {
            const int chunk = juce::jmin (n - done, scratchSamples);
            for (int ch = channels; --ch >= 0;)
            {
                float* out = buffer.getWritePointer (ch, start + done);
                float* in = scratch.getWritePointer (ch);
                std::memcpy (in, out, sizeof (float) * (size_t) chunk);
                runBank (live, ch, out, chunk);
                runBank (next, ch, in, chunk);
                for (int i = 0; i < chunk; ++i)
                {
                    const float g = juce::jmin (1.0f, (float) (fadeDone + done + i + 1) / (float) fadeTotal);
                    out[i] += g * (in[i] - out[i]);
                }
            }
            done += chunk;
        }
        fadeDone += n;
        if (fadeDone >= fadeTotal)
        {
            live = next;
            fadeDone = -1;
        }
    }

    te::sanitiseValues (buffer, start, n, 3.0f);
}
}
