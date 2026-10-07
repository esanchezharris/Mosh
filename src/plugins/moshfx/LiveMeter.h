#pragma once

#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>

// A plugin's live meter readings, handed from the audio thread to the 30 Hz
// "plugin_meters" rail (MoshOps::pluginMeters). The same discipline as the tuner's
// LivePitchLatch (retune/LivePitch.h), with one difference that matters at small
// buffers: at 64 samples and 48 kHz about 25 blocks pass between two 30 Hz takes, so a
// peak or a gain-reduction value must ACCUMULATE (keep the largest) between takes, or a
// transient that lasted one block would almost never be seen.
//
// Two kinds of slot:
//   - maxima: non-negative quantities (linear peaks, gain reduction in dB, a 0/1 flag).
//     The audio thread raises them with a lock-free CAS-max; take() reads AND resets
//     them to 0 with one atomic exchange each, so every block's contribution lands in
//     exactly one take.
//   - latest: the last block's value (a gain at the end of the block, a frequency).
//     The set is published as ONE frame (a seqlock on the serial): take() never returns
//     slots from two different blocks. If the writer is mid-block, or overtakes the
//     reader twice in a row, take() returns the previous whole frame instead.
//
// Every value the latch hands out is finite: +inf is clamped to kCeiling on the way in
// (an upstream plugin or a float file can deliver inf; Tracktion's PluginNode only
// zeroes NaN), NaN is ignored by the maxima and stored as 0 in the latest slots.
//
// A reading is LIVE only if a block was published since the previous take: a bypassed
// plugin, or one with no playback graph running, still holds its last numbers, and those
// must never be drawn as what the audio is doing now. Contributions made before a
// publish() that the reader has not yet seen stay in the slots for the next take.
//
// One writer (the audio thread that runs the plugin), one reader (the message thread).
// No locks, no allocation; every operation is noexcept.

namespace mosh::moshfx
{
template <std::size_t NumMaxima, std::size_t NumLatest>
class LiveMeterLatch
{
public:
    struct Reading
    {
        bool live = false;                       // a block was published since the last take
        std::array<float, NumMaxima> maxima {};  // largest value since the last live take (0 if none)
        std::array<float, NumLatest> latest {};  // the last published block's values
    };

    /** The largest value a slot ever holds (finite; +inf is clamped to it). */
    static constexpr float kCeiling = 1.0e30f;

    /** Audio thread: raise maxima[i] to `value` if it is larger. Negative or NaN values
        are ignored (maxima are non-negative by contract); +inf becomes kCeiling. */
    void accumulateMax (std::size_t i, float value) noexcept
    {
        if (i >= NumMaxima || ! (value > 0.0f))
            return;
        if (! (value < kCeiling))
            value = kCeiling;
        auto& slot = maxima[i];
        float current = slot.load (std::memory_order_relaxed);
        while (value > current
               && ! slot.compare_exchange_weak (current, value, std::memory_order_relaxed))
        {
        }
    }

    /** Audio thread: the last block's value for latest[i]. A non-finite value is
        stored as 0. The first call of a block opens the frame (serial goes odd). */
    void setLatest (std::size_t i, float value) noexcept
    {
        if (i >= NumLatest)
            return;
        if (! writing)
        {
            // Seqlock write side: odd while the frame's slots are being written.
            serial.store (writerSerial + 1, std::memory_order_relaxed);
            std::atomic_thread_fence (std::memory_order_release);
            writing = true;
        }
        latest[i].store (std::isfinite (value) ? value : 0.0f, std::memory_order_relaxed);
    }

    /** Audio thread, once per block, after the accumulate/set calls for that block.
        Closes the frame: the serial advances by 2 per block and is even when stable. */
    void publish() noexcept
    {
        writerSerial += 2;
        writing = false;
        serial.store (writerSerial, std::memory_order_release);
    }

    /** Message thread; the ONLY reader (it remembers what it last saw). Resets the
        maxima only when the reading is live. */
    Reading take() noexcept
    {
        Reading reading;
        // Blocks published so far: serial / 2 (an odd serial is a frame being written,
        // after serial / 2 complete ones).
        const auto first = serial.load (std::memory_order_acquire);
        const auto published = first >> 1;
        reading.live = published != taken;
        taken = published;
        if (! reading.live)
            return reading;
        for (std::size_t i = 0; i < NumMaxima; ++i)
            reading.maxima[i] = maxima[i].exchange (0.0f, std::memory_order_relaxed);
        if constexpr (NumLatest > 0)
        {
            // Seqlock read side: copy, then confirm no write began or ended meanwhile.
            auto before = first;
            for (int attempt = 0; attempt < 2; ++attempt)
            {
                if (attempt > 0)
                    before = serial.load (std::memory_order_acquire);
                std::array<float, NumLatest> copy {};
                for (std::size_t i = 0; i < NumLatest; ++i)
                    copy[i] = latest[i].load (std::memory_order_relaxed);
                std::atomic_thread_fence (std::memory_order_acquire);
                if ((before & 1u) == 0 && serial.load (std::memory_order_relaxed) == before)
                {
                    lastFrame = copy;
                    break;
                }
            }
            reading.latest = lastFrame;   // this frame if consistent, else the previous whole one
        }
        return reading;
    }

private:
    std::array<std::atomic<float>, (NumMaxima > 0 ? NumMaxima : 1)> maxima {};
    std::array<std::atomic<float>, (NumLatest > 0 ? NumLatest : 1)> latest {};
    std::atomic<std::uint32_t> serial { 0 };
    // Writer-only (the audio thread that runs the plugin; successive blocks are ordered
    // by the playback graph): the serial of the last published frame, and whether this
    // block has opened its frame.
    std::uint32_t writerSerial = 0;
    bool writing = false;
    // Reader-only (the message thread).
    std::uint32_t taken = 0;
    std::array<float, NumLatest> lastFrame {};
};
}
