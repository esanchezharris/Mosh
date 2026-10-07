#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh
{
namespace te = tracktion::engine;

// Tracktion's Delay and Chorus, with their delay lines sized on the message thread for
// the largest length set_plugin_state can ask for (src/moshops/PluginState.h).
//
// te::DelayPlugin / te::ChorusPlugin size the line in initialise() for the CURRENT
// length, and applyToBuffer() calls delayBuffer.ensureMaxBufferSize() for the length it
// is about to use, which reallocates (and zero-fills) on the AUDIO thread whenever the
// length grows. set_plugin_state is the first runtime writer of lengthMs/depthMs, so a
// panel drag upwards would allocate on almost every message. The buffer is private, so
// these subclasses size it through the one input Tracktion's own sizing reads:
// initialise() calls the base with a copy of the PluginInitialisationInfo whose
// sampleRate is scaled so the base computes the ceiling's size. In both base classes
// info.sampleRate is used ONLY for that sizing; the audio path uses Plugin::sampleRate,
// which Plugin::baseClassInitialise has already set from the unscaled info. The audio
// is the base class's, bit for bit (--selftest compares each with a directly
// constructed Tracktion plugin, including a length change mid-stream).
//
// Same xmlTypeName as Tracktion's ("delay", "chorus"), registered with the compressor
// from MoshEngineBehaviour::autoInitialiseDeviceManager() (src/engine/MoshEngine.cpp)
// before Tracktion registers its own; --selftest fails if a loaded "delay" or "chorus"
// is not one of these.
class MoshDelayPlugin : public te::DelayPlugin
{
public:
    /** set_plugin_state's ceiling for lengthMs. */
    static constexpr int kMaxLengthMs = 2000;

    explicit MoshDelayPlugin (te::PluginCreationInfo info) : te::DelayPlugin (info) {}
    void initialise (const te::PluginInitialisationInfo&) override;

    /** The sample rate to hand te::DelayPlugin::initialise so that its
        (int) (lengthMs * rate / 1000) covers max (kMaxLengthMs, lengthMs) at `sampleRate`
        with a few samples to spare. `sampleRate` itself for a non-positive length. */
    static double sizingRate (double sampleRate, int lengthMs) noexcept;
};

class MoshChorusPlugin : public te::ChorusPlugin
{
public:
    /** set_plugin_state's ceiling for depthMs. */
    static constexpr float kMaxDepthMs = 20.0f;

    explicit MoshChorusPlugin (te::PluginCreationInfo info) : te::ChorusPlugin (info) {}
    void initialise (const te::PluginInitialisationInfo&) override;

    /** The line length in ms Tracktion's chorus needs at `depthMs`:
        1 + roundToInt (20 + depthMs), exactly as te::ChorusPlugin computes it. */
    static int lineLengthMs (float depthMs) noexcept;
    /** The sample rate to hand te::ChorusPlugin::initialise so that its
        roundToInt (lineLengthMs (depthMs) * rate / 1000) covers the ceiling's line
        (lineLengthMs (kMaxDepthMs), or the current one if longer) at `sampleRate`. */
    static double sizingRate (double sampleRate, float depthMs) noexcept;
};
}
