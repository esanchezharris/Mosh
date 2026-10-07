#pragma once

#include "plugins/moshfx/MoshFxPlugins.h"

namespace mosh
{
// Tracktion's own compressor, plus a live gain-reduction meter for the "plugin_meters"
// rail. The AUDIO is te::CompressorPlugin's, untouched: applyToBuffer calls the base
// implementation on the same buffer and only measures around it (a copy of the input
// is taken first, into scratch memory allocated in initialise, never on the audio
// thread). Tracktion keeps the compressor's envelope private and publishes no gain
// reduction, so the meter reads what was actually applied: per sample, |out| / |in|
// relative to the makeup (output) gain, on samples above -80 dBFS. That makes it
// independent of the detector's internals.
//
// Same xmlTypeName as Tracktion's ("compressor", inherited), so saved sessions,
// presets, load_builtin, TrackPreset's processor table and every dynamic_cast to
// te::CompressorPlugin keep working. It is registered from
// MoshEngineBehaviour::autoInitialiseDeviceManager() (src/engine/MoshEngine.cpp), the
// one hook Tracktion's Engine::initialise() calls after it has constructed the
// PluginManager and BEFORE pluginManager->initialise() registers Tracktion's own
// CompressorPlugin; PluginManager::registerBuiltInType keeps the FIRST registration of
// a type, so every "compressor" Mosh creates or loads is one of these. --selftest fails
// if a loaded "compressor" is ever a plain te::CompressorPlugin (that ordering broke).
class MoshCompressorPlugin : public te::CompressorPlugin, public MoshLiveMetered
{
public:
    explicit MoshCompressorPlugin (te::PluginCreationInfo);
    ~MoshCompressorPlugin() override;

    void initialise (const te::PluginInitialisationInfo&) override;
    void applyToBuffer (const te::PluginRenderContext&) override;

    /** `{ grDb, inDb, outDb }`: the largest gain reduction applied since the previous
        take (dB, >= 0, makeup gain excluded) and the input and output sample peaks
        (dBFS, max over channels 0-1, floored at -100). See MoshLiveMetered. */
    juce::var takeLiveMeters() override;

private:
    // Channels 0-1 of the block's input, copied before the base class processes it.
    juce::AudioBuffer<float> scratch;
    int scratchSamples = 0;
    // maxima: input peak (linear), output peak (linear), gain reduction (dB).
    moshfx::LiveMeterLatch<3, 0> meter;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshCompressorPlugin)
};
}
