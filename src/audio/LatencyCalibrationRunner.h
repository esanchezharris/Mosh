#pragma once

// Plays the calibration sweep once through the device output while
// capturing the input, entirely inside ONE audio-callback clock, so the
// detected offset between emission and arrival IS the output→room→input
// round trip. Every buffer is preallocated in begin(); the callback only
// indexes (audio-thread rules). The message thread polls finished() and
// runs the measurement off the callback.
//
// PROVENANCE: ported from Moshpit apps/recorder/CalibrationRunner.h at
// commit af8b6b7 (M005-29, accepted). Changes: namespace; the debug dump
// path is injected (setDebugDumpFile) instead of a fixed /tmp path, and
// the env switch is MOSH_CALIBRATION_DEBUG.

#include "audio/LatencyCalibration.h"

#include <juce_audio_devices/juce_audio_devices.h>

#include <atomic>
#include <cstdint>
#include <vector>

namespace mosh::latency
{
class CalibrationRunner final : public juce::AudioIODeviceCallback
{
public:
    void begin(double sampleRateToUse)
    {
        rate = sampleRateToUse;
        preroll = (std::int64_t) (rate / 4.0);
        // A half-second log sweep (the noise burst failed on real
        // acoustics — see LatencyCalibration.h).
        stimulusFrames = (int) (rate / 2.0);
        stimulus.assign((std::size_t) stimulusFrames, 0.0f);
        renderCalibrationStimulus(stimulus.data(), stimulusFrames, rate);
        // Sized so maxLag = captured - stimulus >= one full second: the
        // detector's documented bound is real, not ~0.95 s.
        captured.assign((std::size_t) (preroll + stimulusFrames
                                       + (std::int64_t) rate
                                       + (std::int64_t) (rate / 5.0)),
                        0.0f);
        position = 0;
        completed.store(false, std::memory_order_release);
    }

    void setDebugDumpFile(juce::File file) { debugDump = std::move(file); }

    [[nodiscard]] bool finished() const noexcept
    {
        return completed.load(std::memory_order_acquire);
    }

    [[nodiscard]] double sampleRate() const noexcept { return rate; }

    // Message thread, after finished(): RTT = arrival - emission.
    [[nodiscard]] CalibrationResult measure() const
    {
        if (debugDump != juce::File()
            && juce::SystemStats::getEnvironmentVariable(
                   "MOSH_CALIBRATION_DEBUG", {}).isNotEmpty())
            debugDump.replaceWithData(captured.data(),
                                      captured.size() * sizeof(float));

        auto detected = measureRoundTripOffset(
            stimulus.data(), stimulusFrames, captured.data(),
            (int) captured.size(), rate);
        if (!detected.succeeded())
            return detected;
        const auto roundTrip = detected.value->frames - preroll;
        if (roundTrip < 0)
            return { std::nullopt,
                     "the arrival preceded the emission — retry in a "
                     "quieter room" };
        return { CalibrationMeasurement { roundTrip,
                                          detected.value->confidence },
                 {} };
    }

    void audioDeviceIOCallbackWithContext(
        const float* const* inputs, int numInputs, float* const* outputs,
        int numOutputs, int numFrames,
        const juce::AudioIODeviceCallbackContext&) override
    {
        const auto total = (std::int64_t) captured.size();
        // ASSIGN every frame (zeros included): a secondary callback's
        // output buffer arrives UNCLEARED, and a += that stops writing
        // leaves the last chunk looping — a 16-sample block replayed at
        // 48 kHz is a sustained 3 kHz tone (found live in Moshpit A12).
        for (int frame = 0; frame < numFrames; ++frame)
        {
            const auto at = position + frame;
            const auto inStimulus = at >= preroll
                && at < preroll + stimulusFrames;
            const auto sample = inStimulus
                ? stimulus[(std::size_t) (at - preroll)]
                : 0.0f;
            for (int channel = 0; channel < numOutputs; ++channel)
                if (outputs[channel] != nullptr)
                    outputs[channel][frame] = sample;
            if (at < total)
                captured[(std::size_t) at] =
                    numInputs > 0 && inputs[0] != nullptr
                        ? inputs[0][frame]
                        : 0.0f;
        }
        position += numFrames;
        if (position >= total)
            completed.store(true, std::memory_order_release);
    }

    void audioDeviceAboutToStart(juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}

private:
    double rate = 0.0;
    int stimulusFrames = 0;
    std::int64_t preroll = 0;
    std::int64_t position = 0;
    std::vector<float> stimulus;
    std::vector<float> captured;
    std::atomic<bool> completed { false };
    juce::File debugDump;
};
} // namespace mosh::latency
