#include "MoshFxPlugins.h"
#include "MoshFxMath.h"
#include "audio/RealtimeAudioGuard.h"

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
    const Identifier idGlide ("moshAutoTuneGlide");
    const Identifier idLookahead ("moshAutoTuneLookahead");

    // How long a bypass or Look-ahead change may keep moving before the playback
    // graph is rebuilt to pick up the new latency.
    constexpr int kLatencyChangeSettleMs = 150;
    constexpr int kRecordingRetryMs = 500;

    /** A parameter that is one of a few named choices: the key and the scale. It is
        stepped for real (every incoming value, automation included, snaps to the nearest
        choice) and it carries the choices' names, so a surface can offer a menu instead of
        a slider whose positions mean nothing. A name may list two spellings ("A#/Bb");
        either one is understood when the value arrives as text. */
    struct ChoiceParameter final : public te::AutomatableParameter
    {
        ChoiceParameter (const String& paramID, const String& name, te::Plugin& owner, StringArray choiceNames)
            : te::AutomatableParameter (paramID, name, owner, { 0.0f, (float) jmax (1, choiceNames.size() - 1) }),
              labels (std::move (choiceNames))
        {
        }

        ~ChoiceParameter() override
        {
            notifyListenersOfDeletion();
        }

        int stateFor (float v) const noexcept               { return jlimit (0, labels.size() - 1, roundToInt (v)); }

        bool isDiscrete() const override                    { return true; }
        int getNumberOfStates() const override              { return labels.size(); }
        float getValueForState (int i) const override       { return (float) jlimit (0, labels.size() - 1, i); }
        int getStateForValue (float v) const override       { return stateFor (v); }
        float snapToState (float v) const override          { return (float) stateFor (v); }

        bool hasLabels() const override                     { return true; }
        String getLabelForValue (float v) const override    { return labels[stateFor (v)]; }
        StringArray getAllLabels() const override           { return labels; }
        String valueToString (float v) override             { return labels[stateFor (v)]; }

        float stringToValue (const String& s) override
        {
            const auto wanted = s.trim();
            for (int i = 0; i < labels.size(); ++i)
                for (const auto& spelling : StringArray::fromTokens (labels[i], "/", {}))
                    if (spelling.equalsIgnoreCase (wanted))
                        return (float) i;
            return (float) stateFor (wanted.getFloatValue());
        }

        const StringArray labels;
    };

    // What each continuous control reads back as, so nothing shows a bare 0-1 number.
    std::function<String (float)> shownAs (float scale, int decimals, const char* unit)
    {
        return [scale, decimals, unit] (float v)
        {
            // Rounded here, not by String: with no decimal places String prints the raw
            // float ("80.95"), and a hair under zero would read "-0.0".
            const double step = std::pow (10.0, -decimals);
            double shown = std::round ((double) v * scale / step) * step;
            if (std::abs (shown) < 0.5 * step)
                shown = 0.0;
            return (decimals <= 0 ? String (roundToInt (shown)) : String (shown, decimals)) + " " + unit;
        };
    }

    std::function<float (const String&)> readAs (float scale)
    {
        return [scale] (const String& s) { return s.retainCharacters ("0123456789.-").getFloatValue() / scale; };
    }
}

MoshAutoTunePlugin::MoshAutoTunePlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    auto* um = getUndoManager();
    rootValue.referTo (state, idRoot, um, 0.0f);
    scaleValue.referTo (state, idScale, um, 0.0f);
    retuneValue.referTo (state, idRetune, um, 80.0f);
    amountValue.referTo (state, idAmount, um, 1.0f);
    rangeValue.referTo (state, idRange, um, 100.0f);
    mixValue.referTo (state, idMix, um, 1.0f);
    outputValue.referTo (state, idOutput, um, 0.0f);
    glideValue.referTo (state, idGlide, um, 1.0f);
    lookaheadValue.referTo (state, idLookahead, um, 0.0f);

    // The first seven keep their order and ranges; new params are appended. Key and
    // scale are menus; the rest read back in their own units.
    rootParam = new ChoiceParameter ("root", TRANS ("Key"), *this,
                                     { "C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B" });
    addAutomatableParameter (rootParam);
    scaleParam = new ChoiceParameter ("scale", TRANS ("Scale"), *this, { TRANS ("Chromatic"), TRANS ("Major"), TRANS ("Minor") });
    addAutomatableParameter (scaleParam);
    retuneParam = addParam ("retune", TRANS ("Retune speed"), { 5.0f, 250.0f }, shownAs (1.0f, 0, "ms"), readAs (1.0f));
    amountParam = addParam ("amount", TRANS ("Amount"), { 0.0f, 1.0f }, shownAs (100.0f, 0, "%"), readAs (100.0f));
    rangeParam = addParam ("range", TRANS ("Range"), { 0.0f, 300.0f }, shownAs (1.0f, 0, "cents"), readAs (1.0f));
    mixParam = addParam ("mix", TRANS ("Mix"), { 0.0f, 1.0f }, shownAs (100.0f, 0, "%"), readAs (100.0f));
    outputParam = addParam ("output", TRANS ("Output"), { -18.0f, 6.0f }, shownAs (1.0f, 1, "dB"), readAs (1.0f));
    glideParam = addParam ("glide", TRANS ("Glide"), { 0.0f, 1.0f }, shownAs (100.0f, 0, "%"), readAs (100.0f));
    lookaheadParam = addParam ("lookahead", TRANS ("Look-ahead"), { 0.0f, moshfx::retune::RetuneCore::kMaxLookaheadMs },
                               shownAs (1.0f, 1, "ms"), readAs (1.0f));

    rootParam->attachToCurrentValue (rootValue);
    scaleParam->attachToCurrentValue (scaleValue);
    retuneParam->attachToCurrentValue (retuneValue);
    amountParam->attachToCurrentValue (amountValue);
    rangeParam->attachToCurrentValue (rangeValue);
    mixParam->attachToCurrentValue (mixValue);
    outputParam->attachToCurrentValue (outputValue);
    glideParam->attachToCurrentValue (glideValue);
    lookaheadParam->attachToCurrentValue (lookaheadValue);
}

MoshAutoTunePlugin::~MoshAutoTunePlugin()
{
    stopTimer();
    notifyListenersOfDeletion();
    rootParam->detachFromCurrentValue();
    scaleParam->detachFromCurrentValue();
    retuneParam->detachFromCurrentValue();
    amountParam->detachFromCurrentValue();
    rangeParam->detachFromCurrentValue();
    mixParam->detachFromCurrentValue();
    outputParam->detachFromCurrentValue();
    glideParam->detachFromCurrentValue();
    lookaheadParam->detachFromCurrentValue();
}

void MoshAutoTunePlugin::initialise (const te::PluginInitialisationInfo& info)
{
    // Message thread. A render initialises at its own rate, so everything is rebuilt.
    sampleRate = info.sampleRate > 0.0 ? info.sampleRate : 48000.0;
    core.prepare (sampleRate);
    sideDelay.prepare (moshfx::retune::RetuneCore::latencySamplesFor (sampleRate, moshfx::retune::RetuneCore::kMaxLookaheadMs));
    pendingReset.store (false, std::memory_order_release);
}

void MoshAutoTunePlugin::deinitialise()
{
}

double MoshAutoTunePlugin::getLatencySeconds()
{
    // A bypassed built-in is not processed at all, so it must not claim a delay.
    if (! isEnabled() || sampleRate <= 0.0)
        return 0.0;
    return (double) moshfx::retune::RetuneCore::latencySamplesFor (sampleRate, lookaheadValue.get()) / sampleRate;
}

void MoshAutoTunePlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    MOSH_RT_SCOPE();
    auto* buf = fc.destBuffer;
    if (buf == nullptr || ! isEnabled() || sampleRate <= 0.0)
        return;

    // Audio from before a bypass is stale: start clean (no allocation in either).
    if (pendingReset.exchange (false, std::memory_order_acquire))
    {
        core.reset();
        sideDelay.reset();
    }

    // Look-ahead comes from the saved state, the same value getLatencySeconds()
    // reports, so the delay and the reported latency cannot drift apart.
    core.setLookaheadMs (lookaheadValue.get());

    moshfx::retune::RetuneSettings settings;
    settings.rootSemitone = jlimit (0, 11, roundToInt (rootParam->getCurrentValue()));
    settings.scale = jlimit (0, 2, roundToInt (scaleParam->getCurrentValue()));
    settings.retuneMs = retuneParam->getCurrentValue();
    settings.amount = jlimit (0.0f, 1.0f, amountParam->getCurrentValue());
    settings.maxCorrectionCents = rangeParam->getCurrentValue();
    settings.glide = jlimit (0.0f, 1.0f, glideParam->getCurrentValue());
    settings.mix = jlimit (0.0f, 1.0f, mixParam->getCurrentValue());
    settings.outputDb = outputParam->getCurrentValue();

    const int numSamples = fc.bufferNumSamples;
    const int start = fc.bufferStartSample;
    moshfx::retune::RetuneReadout readout;

    if (buf->getNumChannels() >= 2)
    {
        // Mid/side: retune the mid, delay the side to match. With identical
        // channels the side is exactly zero and the output stays exactly mono.
        float* left = buf->getWritePointer (0, start);
        float* right = buf->getWritePointer (1, start);
        for (int i = 0; i < numSamples; ++i)
        {
            const float l = left[i], r = right[i];
            left[i] = 0.5f * (l + r);
            right[i] = 0.5f * (l - r);
        }
        readout = core.process (left, numSamples, settings);
        sideDelay.setDelay (core.latencySamples());
        sideDelay.process (right, numSamples);
        const float sideGain = moshfx::dbToGain (settings.outputDb);
        for (int i = 0; i < numSamples; ++i)
        {
            const float mid = left[i], side = right[i] * sideGain;
            left[i] = mid + side;
            right[i] = mid - side;
        }
    }
    else if (buf->getNumChannels() == 1)
    {
        readout = core.process (buf->getWritePointer (0, start), numSamples, settings);
    }

    lastInputHz.store (readout.inputHz);
    lastTargetHz.store (readout.targetHz);
    lastCorrectionCents.store (readout.correctionCents);
    lastConfidence.store (readout.confidence);
}

void MoshAutoTunePlugin::valueTreePropertyChanged (ValueTree& tree, const Identifier& property)
{
    te::Plugin::valueTreePropertyChanged (tree, property);

    if (tree != state)
        return;
    if (property == te::IDs::enabled)
        pendingReset.store (true, std::memory_order_release);
    if (property == te::IDs::enabled || property == idLookahead)
        startTimer (kLatencyChangeSettleMs); // debounced: a dragged knob rebuilds once
}

void MoshAutoTunePlugin::timerCallback()
{
    // The reported latency just changed; the graph only reads it when it is built.
    // Never rebuild under a take: its timing was captured with the old latency.
    if (edit.getTransport().isRecording())
    {
        startTimer (kRecordingRetryMs);
        return;
    }
    stopTimer();
    edit.restartPlayback();
}

void MoshAutoTunePlugin::restorePluginStateFromValueTree (const ValueTree& v)
{
    te::copyPropertiesToCachedValues (v, rootValue, scaleValue, retuneValue, amountValue, rangeValue, mixValue,
                                      outputValue, glideValue, lookaheadValue);
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
