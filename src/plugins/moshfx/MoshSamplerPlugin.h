#pragma once

#include "plugins/moshfx/MoshFxPlugins.h"

#include <array>
#include <atomic>
#include <cstdint>

namespace mosh
{
// Tracktion's sampler, plus a live entry on the "plugin_meters" rail
// (docs/02_MOSHOPS_CONTRACT.md): the note-ons it received (each note once, with its largest
// velocity), the keys held down at it, and the peak of the signal it ADDED. The AUDIO is
// te::SamplerPlugin's, untouched: applyToBuffer scans the block's MIDI and copies the input,
// calls the base class on the same context, and only then measures what changed.
//
// What it can and cannot see. Hits are note-ons the sampler RECEIVED, not voices it started:
// a note no loaded sound covers, a sound still loading, or a note over the 32-voice cap is
// reported and silent (pair a hit with outDb). Held keys come from the MIDI (and from
// auditionKeys below), not from voices: a one-shot pad rings past its note-off. The voices,
// the loaded sound list and the engine's own held-key set are PRIVATE to te::SamplerPlugin,
// so voice counts are out of reach. The sampler passes its input through on channels 0-1 and
// its voices ADD to it (it is often not first in a chain: load_builtin appends), so its
// output level is measured as max |out - in|, not |out|.
//
// MIDI is read exactly as the base reads it: every message in the buffer the context hands
// it (the sampler does not filter by timestamp), a velocity-0 note-on is a note-off, any
// note-off releases the key whatever its channel, an all-notes-off or all-sound-off message
// and a block flagged all-notes-off release every key.
//
// The clipless-track audition. A track with no clips gets no live-MIDI node, so audition_note
// drives the sampler directly through te::SamplerPlugin::playNotes, which is NOT virtual and
// never reaches applyToBuffer's MIDI. MoshOps therefore calls auditionKeys instead (message
// thread), which reports the newly pressed keys as hits at 0.75 (the velocity playNotes plays
// at) and keeps the audition keys in `held`, then calls playNotes. Its "newly pressed" is
// measured against the previous auditionKeys call; Tracktion's own held set can also be
// cleared by a sound rebuild (any SOUND property write), which this class cannot observe, so a
// re-press after such a rebuild sounds without being reported (an under-report, never a false
// hit).
//
// Real-time rules. The base render allocates on the audio thread (a new SampledNote per
// note-on; ReferenceCountedArray removals free), so MOSH_RT_SCOPE wraps only this class's own
// MIDI scan, input copy and peak loop, never the base call. Nothing here allocates or locks;
// the input copy uses scratch sized in initialise (message thread), grown only, and a block
// longer than it is processed normally and not measured.
//
// Published only while the plugin is enabled and NOT rendering offline (an export or a bounce
// runs the same plugin objects), and only for a block that did something: a hit, a key down,
// or an added peak above 1e-5. An idle sampler therefore drops off the rail.
//
// The state is untouched: no parameters, macros or modifiers are added (the pad commands
// address SOUND children by raw child index, so one extra child would shift them), and no
// value-tree listener is overridden.
//
// Same xmlTypeName as Tracktion's ("sampler", inherited), registered from
// MoshEngineBehaviour::autoInitialiseDeviceManager() (src/engine/MoshEngine.cpp) before
// Tracktion registers its own SamplerPlugin; --selftest fails if a loaded, created (a drum
// track, load_drum_kit, assign_sample) or reloaded "sampler" is not one of these. Every
// dynamic_cast to te::SamplerPlugin keeps working, and the saved format is unchanged.
class MoshSamplerPlugin : public te::SamplerPlugin, public MoshLiveMetered
{
public:
    explicit MoshSamplerPlugin (te::PluginCreationInfo);
    ~MoshSamplerPlugin() override;

    // Each calls the base (whose initialise and deinitialise call allNotesOff, releasing every
    // key and voice), and drops the held keys and the audition keys with it.
    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;

    void applyToBuffer (const te::PluginRenderContext&) override;

    /** Message thread: te::SamplerPlugin::playNotes (keysDown), reporting the keys that were
        not down at the previous call as hits at kAuditionVelocity. `keysDown` is the whole set
        of keys down on this road: the base releases the gated voices of a key that left it
        and starts voices only for a key that joined it. */
    void auditionKeys (const juce::BigInteger& keysDown);

    /** Message thread: the keys the last auditionKeys call held down (empty after
        auditionAllNotesOff, initialise or deinitialise). */
    juce::BigInteger getAuditionKeys();

    /** Message thread: te::SamplerPlugin::allNotesOff (every voice and key, open-ended
        one-shots included), forgetting the audition keys too. */
    void auditionAllNotesOff();

    /** `{ outDb, held: [notes], hits: [{note, vel}] }`: the peak of the signal the sampler
        added since the previous take (dBFS, max |out - in| over channels 0-1, floored at
        -100), the keys down now (ascending), and the note-ons since the previous take
        (ascending by note, each once, vel 0..1 = the largest MIDI velocity / 127, or 0.75 for
        an audition). Void when nothing was published since the previous take, or when what
        was is idle. See MoshLiveMetered. */
    juce::var takeLiveMeters() override;

    /** Below this linear added peak, with no key down and no hit, a block is idle. */
    static constexpr float kIdlePeak = 1.0e-5f;
    /** The velocity te::SamplerPlugin::playNotes plays every key at. */
    static constexpr float kAuditionVelocity = 0.75f;

private:
    using NoteBits = std::array<std::uint32_t, 4>;   // 128 MIDI notes

    // Message thread: apply a pending initialise/deinitialise reset to the audition keys.
    void settleAuditionReset();

    // The input's channels 0-1, copied before the base class adds its voices.
    juce::AudioBuffer<float> scratch;
    int scratchSamples = 0;

    // Audio thread only: the MIDI keys down after the last scanned block.
    NoteBits localHeld {};
    // Audio -> message thread: the keys down after the latest published block (MIDI keys
    // and audition keys together).
    std::array<std::atomic<std::uint32_t>, 4> heldBits {};
    // Message -> audio thread: the audition keys down now, and the audition keys pressed
    // since the audio thread last looked (it turns them into hits and clears them).
    std::array<std::atomic<std::uint32_t>, 4> auditionHeldBits {};
    std::array<std::atomic<std::uint32_t>, 4> auditionStruckBits {};
    // initialise() / deinitialise() (any thread): the audio thread drops its MIDI keys at its
    // next block; the message thread forgets its audition keys at its next call.
    std::atomic<bool> clearHeld { false };
    std::atomic<bool> auditionReset { false };
    // Message thread only: the keys the last auditionKeys call held down.
    juce::BigInteger auditionDown;
    // maxima [0..127]: the largest velocity (0..1) of a note-on per note; [128]: the added
    // peak (linear).
    static constexpr std::size_t kPeakSlot = 128;
    moshfx::LiveMeterLatch<129, 0> meter;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshSamplerPlugin)
};
}
