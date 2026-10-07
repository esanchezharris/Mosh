#pragma once

#include <atomic>
#include <cstdint>

// The tuner's latest pitch reading, handed from the audio thread to whatever draws it.
//
// The audio thread publishes once per processed block; the message thread takes it at
// its own pace (30 Hz). A reading counts as LIVE only if a block was processed since the
// previous take: a bypassed plugin, or one with no playback graph running, still has its
// last numbers in memory, and those must never be drawn as what is being sung right now.
// One writer, one reader, no locks, no allocation.

namespace mosh::moshfx::retune
{
struct LivePitchReading
{
    bool live = false;     // the audio thread ran since the last take()
    bool voiced = false;   // ... and it was hearing a pitch
    double inputHz = 0.0;  // what is being sung
    double targetHz = 0.0; // the note it is being pulled to
    float confidence = 0.0f;
};

class LivePitchLatch
{
public:
    /** Audio thread, once per block. Pass zeros while there is no pitch. */
    void publish (double inputHz, double targetHz, float confidence) noexcept
    {
        input.store (inputHz, std::memory_order_relaxed);
        target.store (targetHz, std::memory_order_relaxed);
        confidenceNow.store (confidence, std::memory_order_relaxed);
        serial.fetch_add (1, std::memory_order_release);
    }

    /** Message thread; the ONLY reader (it remembers what it last saw). */
    LivePitchReading take() noexcept
    {
        LivePitchReading reading;
        const auto now = serial.load (std::memory_order_acquire);
        reading.live = now != taken;
        taken = now;
        if (! reading.live)
            return reading;
        reading.inputHz = input.load (std::memory_order_relaxed);
        reading.targetHz = target.load (std::memory_order_relaxed);
        reading.confidence = confidenceNow.load (std::memory_order_relaxed);
        reading.voiced = reading.inputHz > 0.0 && reading.targetHz > 0.0;
        return reading;
    }

private:
    std::atomic<double> input { 0.0 }, target { 0.0 };
    std::atomic<float> confidenceNow { 0.0f };
    std::atomic<std::uint32_t> serial { 0 };
    std::uint32_t taken = 0;
};
}
