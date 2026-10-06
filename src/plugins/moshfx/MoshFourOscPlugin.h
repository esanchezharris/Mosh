#pragma once

#include "plugins/moshfx/MoshFxPlugins.h"

#include <array>
#include <atomic>
#include <cstdint>

namespace mosh
{
// Tracktion's 4OSC synth, plus a live entry on the "plugin_meters" rail
// (docs/02_MOSHOPS_CONTRACT.md): its output sample peak, the MIDI keys held down at the
// synth, and the note-ons since the previous take. The AUDIO is te::FourOscPlugin's,
// untouched: applyToBuffer scans the block's MIDI, calls the base class on the same
// context, and only then reads the output it wrote.
//
// What it can and cannot see. Keys come from the MIDI the synth received, filtered to
// the block exactly as FourOsc filters it (a message counts when round(timestamp * rate)
// lands in [bufferStartSample, bufferStartSample + bufferNumSamples)); they are KEYS, not
// voices: the sustain pedal, voice stealing and release tails make "held" differ from
// "sounding". Voice counts and envelope positions are out of reach: MPESynthesiser is a
// PRIVATE base of FourOscPlugin and its voice class is local to Tracktion's .cpp.
// getLevel() is never called: it consumes Tracktion's own level reading and applies its
// own ballistics.
//
// MIDI is read as JUCE's MPEInstrument reads it in legacy mode (FourOsc's mode unless its
// "mpe" property is set, which Mosh never does): velocity-0 note-ons are note-offs, and
// note-offs, all-notes-off and reset-all-controllers act on their own channel.
//
// Real-time rules. The base render allocates on the audio thread (a juce::MidiBuffer per
// 32-sample chunk whenever MIDI arrives), so MOSH_RT_SCOPE wraps only this class's own
// MIDI scan and peak loop, never the base call. Nothing here allocates or locks.
//
// Published only while the plugin is enabled and NOT rendering offline (an export or a
// bounce runs the same plugin objects), and only for a block that did something: a key
// down, a note-on, or a peak above 1e-5. An idle synth therefore drops off the rail.
//
// Do not override valueTreePropertyChanged: FourOscPlugin's is PRIVATE and runs its voice
// reallocation (voiceMode/voices) and MODMATRIX reload.
//
// Same xmlTypeName as Tracktion's ("4osc", inherited), registered from
// MoshEngineBehaviour::autoInitialiseDeviceManager() (src/engine/MoshEngine.cpp) before
// Tracktion registers its own FourOscPlugin; --selftest fails if a loaded, created (the
// default instrument) or reloaded "4osc" is not one of these. Every dynamic_cast to
// te::FourOscPlugin keeps working.
class MoshFourOscPlugin : public te::FourOscPlugin, public MoshLiveMetered
{
public:
    explicit MoshFourOscPlugin (te::PluginCreationInfo);
    ~MoshFourOscPlugin() override;

    void applyToBuffer (const te::PluginRenderContext&) override;
    void reset() override;
    void midiPanic() override;

    /** `{ outDb, held: [notes], struck: [notes] }`: the output sample peak since the
        previous take (dBFS, max over channels 0-1, floored at -100), the keys down now
        (ascending), and the note-ons since the previous take (ascending, each once).
        Void when nothing was published since the previous take, or when what was is
        idle (no key, no note-on, peak <= 1e-5). See MoshLiveMetered. */
    juce::var takeLiveMeters() override;

    /** Below this linear peak, with no key down and no note-on, a block is idle. */
    static constexpr float kIdlePeak = 1.0e-5f;

private:
    using NoteBits = std::array<std::uint32_t, 4>;   // 128 MIDI notes

    void clearHeldNow() noexcept;

    // Audio thread only: the keys down after the last scanned block, per MIDI channel
    // (a note-off or an all-notes-off releases only its own channel's keys, as in the
    // synth). Published as their union.
    std::array<NoteBits, 16> localHeld {};
    // Audio -> message thread. held: the latest block's keys (a plain store per block).
    // struck: note-ons OR-ed in by the audio thread, exchanged to 0 by the take.
    std::array<std::atomic<std::uint32_t>, 4> heldBits {};
    std::array<std::atomic<std::uint32_t>, 4> struckBits {};
    // reset() / midiPanic() (any thread): the audio thread drops its held keys at the
    // start of its next block.
    std::atomic<bool> clearHeld { false };
    // maxima: output peak (linear).
    moshfx::LiveMeterLatch<1, 0> meter;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshFourOscPlugin)
};
}
