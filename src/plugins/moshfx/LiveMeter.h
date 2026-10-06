#pragma once

#include <array>
#include <atomic>
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

    /** Audio thread: raise maxima[i] to `value` if it is larger. Negative or NaN values
        are ignored (maxima are non-negative by contract). */
    void accumulateMax (std::size_t i, float value) noexcept
    {
        if (i >= NumMaxima || ! (value > 0.0f))
            return;
        auto& slot = maxima[i];
        float current = slot.load (std::memory_order_relaxed);
        while (value > current
               && ! slot.compare_exchange_weak (current, value, std::memory_order_relaxed))
        {
        }
    }

    /** Audio thread: the last block's value for latest[i]. */
    void setLatest (std::size_t i, float value) noexcept
    {
        if (i < NumLatest)
            latest[i].store (value, std::memory_order_relaxed);
    }

    /** Audio thread, once per block, after the accumulate/set calls for that block. */
    void publish() noexcept { serial.fetch_add (1, std::memory_order_release); }

    /** Message thread; the ONLY reader (it remembers what it last saw). Resets the
        maxima only when the reading is live. */
    Reading take() noexcept
    {
        Reading reading;
        const auto now = serial.load (std::memory_order_acquire);
        reading.live = now != taken;
        taken = now;
        if (! reading.live)
            return reading;
        for (std::size_t i = 0; i < NumMaxima; ++i)
            reading.maxima[i] = maxima[i].exchange (0.0f, std::memory_order_relaxed);
        for (std::size_t i = 0; i < NumLatest; ++i)
            reading.latest[i] = latest[i].load (std::memory_order_relaxed);
        return reading;
    }

private:
    std::array<std::atomic<float>, (NumMaxima > 0 ? NumMaxima : 1)> maxima {};
    std::array<std::atomic<float>, (NumLatest > 0 ? NumLatest : 1)> latest {};
    std::atomic<std::uint32_t> serial { 0 };
    std::uint32_t taken = 0;
};
}
