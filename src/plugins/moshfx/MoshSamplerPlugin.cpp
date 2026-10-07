#include "MoshSamplerPlugin.h"
#include "audio/RealtimeAudioGuard.h"

#include <cmath>

namespace mosh
{
using namespace juce;

namespace
{
    // The ascending note numbers set in `bits`.
    var notesOf (const std::array<std::uint32_t, 4>& bits)
    {
        Array<var> notes;
        for (int word = 0; word < 4; ++word)
            for (int bit = 0; bit < 32; ++bit)
                if ((bits[(size_t) word] >> bit) & 1u)
                    notes.add (word * 32 + bit);
        return notes;
    }
}

MoshSamplerPlugin::MoshSamplerPlugin (te::PluginCreationInfo info) : te::SamplerPlugin (info)
{
}

MoshSamplerPlugin::~MoshSamplerPlugin() = default;

void MoshSamplerPlugin::initialise (const te::PluginInitialisationInfo& info)
{
    // The base calls allNotesOff: every voice and every key it held is gone.
    te::SamplerPlugin::initialise (info);
    clearHeld.store (true, std::memory_order_release);
    for (auto& word : auditionHeldBits)
        word.store (0, std::memory_order_relaxed);
    auditionReset.store (true, std::memory_order_release);

    // The measuring copy. Sized here, off the audio thread, and only ever grown.
    const int wanted = jmax (info.blockSizeSamples, 4096);
    if (wanted > scratchSamples)
    {
        scratch.setSize (2, wanted, false, false, true);
        scratchSamples = wanted;
    }
}

void MoshSamplerPlugin::deinitialise()
{
    te::SamplerPlugin::deinitialise();   // allNotesOff, as initialise
    clearHeld.store (true, std::memory_order_release);
    for (auto& word : auditionHeldBits)
        word.store (0, std::memory_order_relaxed);
    auditionReset.store (true, std::memory_order_release);
}

void MoshSamplerPlugin::settleAuditionReset()
{
    if (auditionReset.exchange (false, std::memory_order_acq_rel))
        auditionDown.clear();
}

void MoshSamplerPlugin::auditionKeys (const BigInteger& keysDown)
{
    settleAuditionReset();
    NoteBits down {}, struck {};
    BigInteger keys;
    for (int note = 0; note < 128; ++note)
        if (keysDown[note])
        {
            keys.setBit (note);
            const auto mask = 1u << (note & 31);
            down[(size_t) (note >> 5)] |= mask;
            if (! auditionDown[note])
                struck[(size_t) (note >> 5)] |= mask;
        }
    auditionDown = keys;

    // The audio: Tracktion's playNotes (not virtual; it takes the plugin's lock).
    te::SamplerPlugin::playNotes (keysDown);

    for (size_t word = 0; word < down.size(); ++word)
    {
        auditionHeldBits[word].store (down[word], std::memory_order_relaxed);
        if (struck[word] != 0)
            auditionStruckBits[word].fetch_or (struck[word], std::memory_order_relaxed);
    }
}

BigInteger MoshSamplerPlugin::getAuditionKeys()
{
    settleAuditionReset();
    return auditionDown;
}

void MoshSamplerPlugin::auditionAllNotesOff()
{
    settleAuditionReset();
    auditionDown.clear();
    for (auto& word : auditionHeldBits)
        word.store (0, std::memory_order_relaxed);
    te::SamplerPlugin::allNotesOff();
}

void MoshSamplerPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    // The sampler does nothing at all without a destination buffer (it consumes no MIDI
    // either), and an offline render or a bypassed plugin must not reach the rail.
    auto* buffer = fc.destBuffer;
    const bool report = buffer != nullptr && ! fc.isRendering && isEnabled();
    const int numSamples = fc.bufferNumSamples;
    const int channels = buffer != nullptr ? jmin (2, buffer->getNumChannels()) : 0;
    const bool measure = report && channels > 0 && numSamples > 0 && numSamples <= scratchSamples;
    bool busy = false;

    if (report)
    {
        MOSH_RT_SCOPE();
        if (clearHeld.exchange (false, std::memory_order_acq_rel))
            localHeld = {};

        // Keys the message thread auditioned (playNotes) since the previous block.
        for (size_t word = 0; word < auditionStruckBits.size(); ++word)
            if (const auto bits = auditionStruckBits[word].exchange (0, std::memory_order_relaxed); bits != 0)
            {
                busy = true;
                for (int bit = 0; bit < 32; ++bit)
                    if ((bits >> bit) & 1u)
                        meter.accumulateMax ((size_t) word * 32 + (size_t) bit, kAuditionVelocity);
            }

        if (auto* midi = fc.bufferForMidiMessages)
        {
            // The base's own reading (SamplerPlugin::applyToBuffer): a block flagged
            // all-notes-off first, then every message, whatever its timestamp or channel.
            if (midi->isAllNotesOff)
                localHeld = {};
            for (const auto& m : *midi)
            {
                if (m.isNoteOn())   // velocity > 0
                {
                    const int note = m.getNoteNumber();
                    localHeld[(size_t) (note >> 5)] |= 1u << (note & 31);
                    meter.accumulateMax ((size_t) note, m.getVelocity() / 127.0f);
                    busy = true;
                }
                else if (m.isNoteOff())   // a velocity-0 note-on included
                {
                    const int note = m.getNoteNumber();
                    localHeld[(size_t) (note >> 5)] &= ~(1u << (note & 31));
                }
                else if (m.isAllNotesOff() || m.isAllSoundOff())
                {
                    localHeld = {};
                }
            }
        }

        if (measure)
            for (int ch = 0; ch < channels; ++ch)
                scratch.copyFrom (ch, 0, *buffer, ch, fc.bufferStartSample, numSamples);
    }

    // The audio: Tracktion's sampler, bit for bit. NOT inside MOSH_RT_SCOPE: it allocates.
    te::SamplerPlugin::applyToBuffer (fc);

    if (! report)
        return;

    MOSH_RT_SCOPE();
    // What the voices added: the sampler passes its input through on channels 0-1.
    float added = 0.0f;
    if (measure)
        for (int ch = 0; ch < channels; ++ch)
        {
            const float* in = scratch.getReadPointer (ch);
            const float* out = buffer->getReadPointer (ch, fc.bufferStartSample);
            for (int i = 0; i < numSamples; ++i)
                added = jmax (added, std::abs (out[i] - in[i]));
        }

    bool anyHeld = false;
    for (size_t word = 0; word < heldBits.size(); ++word)
    {
        const auto down = localHeld[word] | auditionHeldBits[word].load (std::memory_order_relaxed);
        heldBits[word].store (down, std::memory_order_relaxed);
        anyHeld = anyHeld || down != 0;
    }

    if (busy || anyHeld || added > kIdlePeak)
    {
        meter.accumulateMax (kPeakSlot, added);
        meter.publish();
    }
}

var MoshSamplerPlugin::takeLiveMeters()
{
    // An audition played while the sampler is bypassed never reached a block; drop it rather
    // than surface it as new when the sampler is switched back on.
    if (! isEnabled())
        for (auto& word : auditionStruckBits)
            word.store (0, std::memory_order_relaxed);

    const auto reading = meter.take();
    if (! reading.live)
        return {};

    NoteBits held {};
    juce::Array<var> hits;
    bool any = reading.maxima[kPeakSlot] > kIdlePeak;
    for (int note = 0; note < 128; ++note)
        if (const float vel = reading.maxima[(size_t) note]; vel > 0.0f)
        {
            auto* hit = new DynamicObject();
            hit->setProperty ("note", note);
            hit->setProperty ("vel", (double) jmin (1.0f, vel));
            hits.add (var (hit));
            any = true;
        }
    for (size_t word = 0; word < held.size(); ++word)
    {
        held[word] = heldBits[word].load (std::memory_order_relaxed);
        any = any || held[word] != 0;
    }
    if (! any)
        return {};

    auto* o = new DynamicObject();
    o->setProperty ("outDb", meterDb (reading.maxima[kPeakSlot]));
    o->setProperty ("held", notesOf (held));
    o->setProperty ("hits", hits);
    return var (o);
}
}
