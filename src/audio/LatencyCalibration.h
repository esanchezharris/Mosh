#pragma once

// Measured round-trip latency: the headless detector.
//
// PROVENANCE: ported verbatim (namespace + includes only) from Moshpit
// modules/recorder_core/LatencyCalibration.h at commit af8b6b7
// (M005-13 / M005-29, accepted). Owner-authored code; no license change.
//
// The first design (white-noise burst + normalized correlation) failed on
// REAL acoustics — a speaker→room→mic path decorrelates noise to r≈0.22
// (measured on the reference setup) — so the stimulus is a logarithmic
// sine sweep (100 Hz → 10 kHz, Farina method): matched filtering
// concentrates the whole sweep's energy into one sharp arrival regardless
// of speaker/mic coloring (measured 908x over the floor on the same
// setup). Measurements are UNTRUSTED numbers: the search is bounded to
// one second, a silent or uncorrelated capture is refused, and a rival
// arrival outside the ±20 ms direct-path cluster at ≥70% of the peak is
// refused as ambiguous — a wrong calibration is worse than none.

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <vector>

namespace mosh::latency
{
struct CalibrationMeasurement
{
    std::int64_t frames = 0;
    double confidence = 0.0;
};

struct CalibrationResult
{
    std::optional<CalibrationMeasurement> value;
    juce::String error;
    [[nodiscard]] bool succeeded() const noexcept
    {
        return value.has_value();
    }
};

// Logarithmic sweep with 5 ms fades; `frames` should be ~rate/2.
inline void renderCalibrationStimulus(float* out, int frames,
                                      double sampleRate)
{
    if (frames <= 0 || sampleRate <= 0.0)
        return;
    const auto f0 = 100.0, f1 = 10000.0;
    const auto duration = double(frames) / sampleRate;
    const auto k = duration / std::log(f1 / f0);
    const auto fade =
        std::max(1, std::min(frames / 4, (int) (sampleRate * 0.005)));
    for (int i = 0; i < frames; ++i)
    {
        const auto t = double(i) / sampleRate;
        const auto phase = juce::MathConstants<double>::twoPi * f0 * k
            * (std::exp(t / k) - 1.0);
        auto value = 0.5 * std::sin(phase);
        if (i < fade)
            value *= double(i) / fade;
        if (i >= frames - fade)
            value *= double(frames - 1 - i) / fade;
        out[i] = (float) value;
    }
}

inline CalibrationResult measureRoundTripOffset(const float* stimulus,
                                                int stimulusFrames,
                                                const float* captured,
                                                int capturedFrames,
                                                double sampleRate)
{
    if (stimulus == nullptr || captured == nullptr || stimulusFrames <= 0
        || capturedFrames <= stimulusFrames || sampleRate <= 0.0)
        return { std::nullopt, "calibration inputs are malformed" };

    auto stimulusEnergy = 0.0, capturedEnergy = 0.0;
    for (int i = 0; i < stimulusFrames; ++i)
        stimulusEnergy += double(stimulus[i]) * double(stimulus[i]);
    for (int i = 0; i < capturedFrames; ++i)
        capturedEnergy += double(captured[i]) * double(captured[i]);
    if (stimulusEnergy <= 0.0)
        return { std::nullopt, "the stimulus is silent" };
    if (capturedEnergy < 1.0e-9)
        return { std::nullopt,
                 "nothing was captured — check the input device" };

    const auto maxLag = std::min<std::int64_t>(
        capturedFrames - stimulusFrames,
        (std::int64_t) sampleRate); // the 1-second bound
    if (maxLag < 1)
        return { std::nullopt, "the capture is too short" };

    // Coarse matched-filter envelope (stride 8), then a fine pass
    // around the coarse peak. The floor is the coarse median.
    constexpr std::int64_t stride = 8;
    std::vector<double> coarse;
    coarse.reserve((std::size_t) (maxLag / stride + 1));
    for (std::int64_t lag = 0; lag <= maxLag; lag += stride)
    {
        auto dot = 0.0;
        for (int i = 0; i < stimulusFrames; ++i)
            dot += double(captured[lag + i]) * double(stimulus[i]);
        coarse.push_back(std::abs(dot));
    }
    auto sorted = coarse;
    std::nth_element(sorted.begin(),
                     sorted.begin() + (std::ptrdiff_t) sorted.size() / 2,
                     sorted.end());
    const auto floor = sorted[sorted.size() / 2];
    const auto coarseBest = (std::int64_t) std::distance(
        coarse.begin(), std::max_element(coarse.begin(), coarse.end()));

    auto bestLag = std::int64_t(0);
    auto bestScore = 0.0;
    const auto fineLo =
        std::max<std::int64_t>(0, coarseBest * stride - stride * 2);
    const auto fineHi =
        std::min<std::int64_t>(maxLag, coarseBest * stride + stride * 2);
    for (std::int64_t lag = fineLo; lag <= fineHi; ++lag)
    {
        auto dot = 0.0;
        for (int i = 0; i < stimulusFrames; ++i)
            dot += double(captured[lag + i]) * double(stimulus[i]);
        if (std::abs(dot) > bestScore)
        {
            bestScore = std::abs(dot);
            bestLag = lag;
        }
    }

    // A zero floor is a PERFECT background (synthetic silence); the
    // absolute term only rejects numerical dust.
    if (bestScore < std::max(50.0 * floor, 1.0e-6))
        return { std::nullopt,
                 "no correlated stimulus found within one second" };

    // A rival arrival outside the direct-path cluster (±20 ms) at 70%
    // of the peak is a distinct echo strong enough to distrust.
    const auto cluster = (std::int64_t) (sampleRate * 0.020);
    auto rival = 0.0;
    for (std::size_t index = 0; index < coarse.size(); ++index)
    {
        const auto lag = (std::int64_t) index * stride;
        if (std::abs(lag - bestLag) > cluster)
            rival = std::max(rival, coarse[index]);
    }
    if (rival >= 0.7 * bestScore)
        return { std::nullopt,
                 "the measurement is ambiguous (a strong distinct "
                 "echo) — reduce reflections and retry" };

    const auto floorForConfidence =
        std::max(floor, bestScore / 1000.0);
    return { CalibrationMeasurement {
                 bestLag,
                 std::min(1.0, bestScore / (100.0 * floorForConfidence)) },
             {} };
}
} // namespace mosh::latency
