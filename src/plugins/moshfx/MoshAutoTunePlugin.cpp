#include "MoshFxPlugins.h"

#include <cmath>

namespace mosh
{
using namespace juce;

const char* MoshAutoTunePlugin::xmlTypeName = "moshAutoTune";

namespace
{
    const Identifier idRoot ("moshAutoTuneRoot");
    const Identifier idScale ("moshAutoTuneScale");
    const Identifier idRetune ("moshAutoTuneRetune");
    const Identifier idAmount ("moshAutoTuneAmount");
    const Identifier idRange ("moshAutoTuneRange");
    const Identifier idMix ("moshAutoTuneMix");
    const Identifier idOutput ("moshAutoTuneOutput");

    moshfx::ScaleKind scaleKindFromValue (float v)
    {
        const auto i = jlimit (0, 2, roundToInt (v));
        if (i == 1) return moshfx::ScaleKind::major;
        if (i == 2) return moshfx::ScaleKind::minor;
        return moshfx::ScaleKind::chromatic;
    }

    moshfx::AutoTuneSettings autoTuneSettings (float root, float scale, float retune, float amount,
                                               float range, float mix, float output)
    {
        moshfx::AutoTuneSettings s;
        s.rootSemitone = jlimit (0, 11, roundToInt (root));
        s.scale = scaleKindFromValue (scale);
        s.retuneMs = retune;
        s.amount = jlimit (0.0f, 1.0f, amount);
        s.maxCorrectionCents = range;
        s.mix = jlimit (0.0f, 1.0f, mix);
        s.outputDb = output;
        return s;
    }

    float audioGainFromDb (float db)
    {
        return std::pow (10.0f, db / 20.0f);
    }
}

MoshAutoTunePlugin::MoshAutoTunePlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    auto* um = getUndoManager();
    rootValue.referTo (state, idRoot, um, 0.0f);
    scaleValue.referTo (state, idScale, um, 0.0f);
    retuneValue.referTo (state, idRetune, um, 80.0f);
    amountValue.referTo (state, idAmount, um, 0.35f);
    rangeValue.referTo (state, idRange, um, 100.0f);
    mixValue.referTo (state, idMix, um, 1.0f);
    outputValue.referTo (state, idOutput, um, 0.0f);

    rootParam = addParam ("root", TRANS ("Root"), { 0.0f, 11.0f });
    scaleParam = addParam ("scale", TRANS ("Scale"), { 0.0f, 2.0f });
    retuneParam = addParam ("retune", TRANS ("Retune"), { 5.0f, 250.0f });
    amountParam = addParam ("amount", TRANS ("Amount"), { 0.0f, 1.0f });
    rangeParam = addParam ("range", TRANS ("Range"), { 0.0f, 300.0f });
    mixParam = addParam ("mix", TRANS ("Mix"), { 0.0f, 1.0f });
    outputParam = addParam ("output", TRANS ("Output"), { -18.0f, 6.0f });

    rootParam->attachToCurrentValue (rootValue);
    scaleParam->attachToCurrentValue (scaleValue);
    retuneParam->attachToCurrentValue (retuneValue);
    amountParam->attachToCurrentValue (amountValue);
    rangeParam->attachToCurrentValue (rangeValue);
    mixParam->attachToCurrentValue (mixValue);
    outputParam->attachToCurrentValue (outputValue);
}

MoshAutoTunePlugin::~MoshAutoTunePlugin()
{
    notifyListenersOfDeletion();
    rootParam->detachFromCurrentValue();
    scaleParam->detachFromCurrentValue();
    retuneParam->detachFromCurrentValue();
    amountParam->detachFromCurrentValue();
    rangeParam->detachFromCurrentValue();
    mixParam->detachFromCurrentValue();
    outputParam->detachFromCurrentValue();
}

void MoshAutoTunePlugin::initialise (const te::PluginInitialisationInfo& info)
{
    processSampleRate = info.sampleRate > 0.0 ? info.sampleRate : 48000.0;
    const auto block = jmax (info.blockSizeSamples, 512);
    scratchIn.assign ((size_t) jmin (block, 8192), 0.0f);
    synthPhase.fill (0.0);
    smoothedCorrectionCents.fill (0.0);
}

void MoshAutoTunePlugin::deinitialise()
{
    scratchIn.clear();
    smoothedCorrectionCents.fill (0.0);
}

void MoshAutoTunePlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    auto* buf = fc.destBuffer;
    if (buf == nullptr || ! isEnabled())
        return;

    const int n = jmin (fc.bufferNumSamples, (int) scratchIn.size());
    if (n <= 0)
        return;

    const auto settings = autoTuneSettings (rootValue.get(), scaleValue.get(), retuneValue.get(),
                                            amountValue.get(), rangeValue.get(), mixValue.get(),
                                            outputValue.get());
    const int start = fc.bufferStartSample;
    const int channels = jmin (buf->getNumChannels(), 8);

    for (int ch = 0; ch < channels; ++ch)
    {
        auto* data = buf->getWritePointer (ch);
        for (int i = 0; i < n; ++i)
            scratchIn[(size_t) i] = data[start + i];

        auto result = moshfx::analyseAutoTuneBlock (scratchIn.data(), n, processSampleRate, settings);
        const auto blockSeconds = processSampleRate > 0.0 ? (double) n / processSampleRate : 0.0;
        const auto response = moshfx::retuneCoefficient (blockSeconds, settings.retuneMs);
        const auto outputGain = audioGainFromDb (settings.outputDb);
        const auto mix = jlimit (0.0f, 1.0f, settings.mix);
        auto& smoothed = smoothedCorrectionCents[(size_t) ch];

        smoothed = result.corrected ? smoothed + (result.correctionCents - smoothed) * response : 0.0;
        result.correctionCents = smoothed;
        result.corrected = std::abs (result.correctionCents) > 0.05;

        if (ch == 0)
        {
            lastInputHz.store (result.input.frequencyHz);
            lastTargetHz.store (result.targetFrequencyHz);
            lastCorrectionCents.store (result.correctionCents);
            lastConfidence.store ((float) result.input.confidence);
        }

        if (! result.corrected)
        {
            for (int i = 0; i < n; ++i)
                data[start + i] = jlimit (-0.999f, 0.999f, scratchIn[(size_t) i] * outputGain);
            continue;
        }

        const auto correctedHz = result.input.frequencyHz * std::pow (2.0, result.correctionCents / 1200.0);
        const auto inc = MathConstants<double>::twoPi * correctedHz / processSampleRate;
        const auto amp = (float) (result.input.rms * 1.4142135623730951);
        auto phase = synthPhase[(size_t) ch];
        for (int i = 0; i < n; ++i)
        {
            const auto wet = amp * (float) std::sin (phase);
            const auto dry = scratchIn[(size_t) i];
            data[start + i] = jlimit (-0.999f, 0.999f, (dry + (wet - dry) * mix) * outputGain);
            phase += inc;
            if (phase >= MathConstants<double>::twoPi)
                phase -= MathConstants<double>::twoPi;
        }
        synthPhase[(size_t) ch] = phase;
    }
}

void MoshAutoTunePlugin::restorePluginStateFromValueTree (const ValueTree& v)
{
    te::copyPropertiesToCachedValues (v, rootValue, scaleValue, retuneValue, amountValue, rangeValue, mixValue, outputValue);
    for (auto p : getAutomatableParameters())
        p->updateFromAttachedValue();
}

var MoshAutoTunePlugin::describeMoshFx() const
{
    auto* o = new DynamicObject();
    o->setProperty ("kind", "autotune");
    o->setProperty ("inputHz", lastInputHz.load());
    o->setProperty ("targetHz", lastTargetHz.load());
    o->setProperty ("correctionCents", lastCorrectionCents.load());
    o->setProperty ("confidence", lastConfidence.load());
    return var (o);
}
}
