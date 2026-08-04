#include "TrackMutePlugin.h"

namespace mosh
{
using namespace juce;

const char* TrackMutePlugin::xmlTypeName = "moshTrackMute";
const char* TrackMutePlugin::muteParamID = "mute";

namespace
{
    // Mosh-prefixed so it can never collide with an engine property on the PLUGIN tree
    // (the repo convention for anything Mosh parks on an engine-owned ValueTree).
    const Identifier idTrackMute ("moshMute");

    // The gate edge, in seconds. Long enough that a step from 1 -> 0 is inaudible as a
    // click; short enough that "muted at t" is true to within a millisecond, which is
    // what the verify.py PCM assertion measures.
    constexpr double gateRampSeconds = 0.005;

    /** A two-state parameter. Discreteness is not cosmetic: `setParameterValue` runs
        every incoming value (including each curve sample) through `snapToState`, so a
        linear curve segment drawn between 0 and 1 is APPLIED as a step that flips at the
        midpoint rather than as a fade through half-mute — which is what a mute lane
        means everywhere else in the world. */
    struct MuteParameter : public te::AutomatableParameter
    {
        MuteParameter (const String& paramID, const String& name, te::Plugin& owner)
            : te::AutomatableParameter (paramID, name, owner, { 0.0f, 1.0f })
        {
        }

        ~MuteParameter() override
        {
            notifyListenersOfDeletion();
        }

        static bool closed (float v) noexcept { return v >= 0.5f; }

        bool isDiscrete() const override                    { return true; }
        int getNumberOfStates() const override              { return 2; }
        float getValueForState (int i) const override       { return i <= 0 ? 0.0f : 1.0f; }
        int getStateForValue (float v) const override       { return closed (v) ? 1 : 0; }
        float snapToState (float v) const override          { return closed (v) ? 1.0f : 0.0f; }

        bool hasLabels() const override                     { return true; }
        String getLabelForValue (float v) const override    { return closed (v) ? TRANS ("Muted") : TRANS ("Open"); }
        StringArray getAllLabels() const override           { return { TRANS ("Open"), TRANS ("Muted") }; }
        String valueToString (float v) override             { return closed (v) ? TRANS ("Muted") : TRANS ("Open"); }

        float stringToValue (const String& s) override
        {
            const auto t = s.trim();
            if (t.equalsIgnoreCase ("muted") || t.equalsIgnoreCase ("mute") || t.equalsIgnoreCase ("on"))
                return 1.0f;
            if (t.equalsIgnoreCase ("open") || t.equalsIgnoreCase ("unmuted") || t.equalsIgnoreCase ("off"))
                return 0.0f;
            return closed (t.getFloatValue()) ? 1.0f : 0.0f;
        }
    };
}

TrackMutePlugin::TrackMutePlugin (te::PluginCreationInfo info) : te::Plugin (info)
{
    muteValue.referTo (state, idTrackMute, getUndoManager(), 0.0f);

    addAutomatableParameter (muteParam = new MuteParameter (muteParamID, TRANS ("Mute"), *this));
    muteParam->attachToCurrentValue (muteValue);

    // Open, and already settled there — an un-automated gate must not fade the first
    // block of every render in from silence.
    gateGain.setCurrentAndTargetValue (muteValue.get() >= 0.5f ? 0.0f : 1.0f);
}

TrackMutePlugin::~TrackMutePlugin()
{
    notifyListenersOfDeletion();
    muteParam->detachFromCurrentValue();
}

void TrackMutePlugin::initialise (const te::PluginInitialisationInfo& info)
{
    const auto sr = info.sampleRate > 0.0 ? info.sampleRate : 48000.0;
    gateGain.reset (sr, gateRampSeconds);
    gateGain.setCurrentAndTargetValue (muteParam->getCurrentValue() >= 0.5f ? 0.0f : 1.0f);
}

void TrackMutePlugin::deinitialise()
{
}

void TrackMutePlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    // Read the PARAMETER, not the CachedValue: `Plugin::applyToBufferWithAutomation` has
    // just run `updateParameterStreams` for this block's edit time, so the parameter's
    // atomic current value IS the curve's value here. The CachedValue behind it is only
    // written back asynchronously on the message thread (AttachedValue is an
    // AsyncUpdater), so reading it would lag the curve by however long the message loop
    // takes — and in an offline render, forever.
    //
    // Deliberately NOT gated on isEnabled(): the plugin is hidden from the rack, so
    // nothing can bypass it, and honouring bypass would be a way to silently defeat an
    // automated mute.
    gateGain.setTargetValue (muteParam->getCurrentValue() >= 0.5f ? 0.0f : 1.0f);

    auto* buf = fc.destBuffer;
    if (buf == nullptr || fc.bufferNumSamples <= 0)
        return;

    const int numChans = buf->getNumChannels();
    if (numChans <= 0)
        return;

    // applyGain advances the ramp, so each channel has to start from the same place —
    // same save/restore the engine's own VolumeAndPanPlugin does for channels 2+.
    const auto blockStart = gateGain;
    for (int ch = 0; ch < numChans; ++ch)
    {
        gateGain = blockStart;
        gateGain.applyGain (buf->getWritePointer (ch, fc.bufferStartSample), fc.bufferNumSamples);
    }

    // MIDI passes through untouched. A muted instrument track is already silent — Mosh
    // inserts instruments at the FRONT of the chain, so their audio is generated
    // upstream of this gate and gated here like everything else — and swallowing MIDI
    // would strand note-offs and hang notes across the gate edge.
}

void TrackMutePlugin::restorePluginStateFromValueTree (const ValueTree& v)
{
    te::copyPropertiesToCachedValues (v, muteValue);

    for (auto p : getAutomatableParameters())
        p->updateFromAttachedValue();
}

}
