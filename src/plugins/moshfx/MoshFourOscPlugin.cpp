#include "MoshFourOscPlugin.h"
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

MoshFourOscPlugin::MoshFourOscPlugin (te::PluginCreationInfo info) : te::FourOscPlugin (info)
{
}

MoshFourOscPlugin::~MoshFourOscPlugin() = default;

void MoshFourOscPlugin::clearHeldNow() noexcept
{
    clearHeld.store (true, std::memory_order_release);
    for (auto& word : heldBits)
        word.store (0, std::memory_order_relaxed);
}

void MoshFourOscPlugin::reset()
{
    clearHeldNow();
    te::FourOscPlugin::reset();
}

void MoshFourOscPlugin::midiPanic()
{
    clearHeldNow();
    te::FourOscPlugin::midiPanic();
}

void MoshFourOscPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    // FourOsc does nothing at all without a destination buffer (it consumes no MIDI
    // either), and an offline render or a bypassed plugin must not reach the rail.
    const bool measure = fc.destBuffer != nullptr && ! fc.isRendering && isEnabled();
    bool struckThisBlock = false;

    if (measure)
    {
        MOSH_RT_SCOPE();
        if (clearHeld.exchange (false, std::memory_order_acq_rel))
            localHeld = {};
        if (auto* midi = fc.bufferForMidiMessages)
        {
            // FourOsc turns every voice off first on an all-notes-off block, then plays
            // the block's MIDI.
            if (midi->isAllNotesOff)
                localHeld = {};
            // Plugin's rate (FourOsc reads its private MPESynthesiser base's copy; both are
            // the initialise rate).
            const double rate = te::Plugin::sampleRate;
            const int first = fc.bufferStartSample, end = fc.bufferStartSample + fc.bufferNumSamples;
            for (const auto& m : *midi)
            {
                // FourOsc's own filter: round (timestamp * rate) inside the block.
                const int pos = roundToInt (m.getTimeStamp() * rate);
                if (pos < first || pos >= end)
                    continue;
                const int channel = jlimit (1, 16, m.getChannel()) - 1;
                auto& keys = localHeld[(size_t) channel];
                // The same reading as JUCE's MPEInstrument (legacy mode, which FourOsc
                // runs unless its "mpe" property is set): a note-on with velocity 0 is a
                // note-off; note-offs, all-notes-off (CC 123) and reset-all-controllers
                // (CC 121) act on their own channel only; all-sound-off releases nothing.
                if (m.isNoteOn())   // velocity > 0
                {
                    const int note = m.getNoteNumber();
                    const auto mask = 1u << (note & 31);
                    keys[(size_t) (note >> 5)] |= mask;
                    struckBits[(size_t) (note >> 5)].fetch_or (mask, std::memory_order_relaxed);
                    struckThisBlock = true;
                }
                else if (m.isNoteOff())   // a velocity-0 note-on included
                {
                    const int note = m.getNoteNumber();
                    keys[(size_t) (note >> 5)] &= ~(1u << (note & 31));
                }
                else if (m.isAllNotesOff() || m.isResetAllControllers())
                {
                    keys = {};
                }
            }
        }
    }

    // The audio: Tracktion's 4OSC, bit for bit. NOT inside MOSH_RT_SCOPE: it allocates.
    te::FourOscPlugin::applyToBuffer (fc);

    if (! measure)
        return;

    MOSH_RT_SCOPE();
    auto& buffer = *fc.destBuffer;
    float peak = 0.0f;
    const int channels = jmin (2, buffer.getNumChannels());
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* out = buffer.getReadPointer (ch, fc.bufferStartSample);
        for (int i = 0; i < fc.bufferNumSamples; ++i)
            peak = jmax (peak, std::abs (out[i]));
    }

    bool anyHeld = false;
    for (size_t word = 0; word < heldBits.size(); ++word)
    {
        std::uint32_t down = 0;
        for (const auto& channel : localHeld)
            down |= channel[word];
        heldBits[word].store (down, std::memory_order_relaxed);
        anyHeld = anyHeld || down != 0;
    }

    if (peak > kIdlePeak || anyHeld || struckThisBlock)
    {
        meter.accumulateMax (0, peak);
        meter.publish();
    }
}

var MoshFourOscPlugin::takeLiveMeters()
{
    const auto reading = meter.take();
    if (! reading.live)
        return {};

    NoteBits held {}, struck {};
    bool any = reading.maxima[0] > kIdlePeak;
    for (size_t word = 0; word < held.size(); ++word)
    {
        held[word] = heldBits[word].load (std::memory_order_relaxed);
        struck[word] = struckBits[word].exchange (0, std::memory_order_relaxed);
        any = any || held[word] != 0 || struck[word] != 0;
    }
    if (! any)
        return {};

    auto* o = new DynamicObject();
    o->setProperty ("outDb", meterDb (reading.maxima[0]));
    o->setProperty ("held", notesOf (held));
    o->setProperty ("struck", notesOf (struck));
    return var (o);
}
}
