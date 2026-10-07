#pragma once

#include <algorithm>
#include <cmath>

// An independent pitch measurement for the retune tests: whole-block normalised
// autocorrelation with a parabolic refinement. It is deliberately NOT the engine's
// own tracker, so a test that measures the engine's output is not marking its own
// homework. (This was the detector of the sine-resynthesis AutoTune core that the
// retune engine replaced.) Pass a narrow minHz/maxHz: on periodic input it can
// otherwise settle on a multiple of the period.

namespace mosh::tests::retune
{
struct PitchMeasurement
{
    double frequencyHz = 0.0;
    double confidence = 0.0;
    bool voiced = false;
};

inline PitchMeasurement measurePitch (const float* samples, int numSamples, double sampleRate,
                                      double minHz, double maxHz)
{
    PitchMeasurement out;
    if (samples == nullptr || numSamples < 64 || sampleRate <= 0.0)
        return out;

    double mean = 0.0;
    for (int i = 0; i < numSamples; ++i)
        mean += samples[i];
    mean /= (double) numSamples;

    const int minLag = std::max (2, (int) std::floor (sampleRate / std::max (maxHz, 1.0)));
    const int maxLag = std::min ((int) std::ceil (sampleRate / std::max (minHz, 1.0)), numSamples / 2);
    if (maxLag <= minLag)
        return out;

    auto corrAt = [&] (int lag)
    {
        double sum = 0.0, e1 = 0.0, e2 = 0.0;
        for (int i = 0; i < numSamples - lag; ++i)
        {
            const double a = (double) samples[i] - mean;
            const double b = (double) samples[i + lag] - mean;
            sum += a * b;
            e1 += a * a;
            e2 += b * b;
        }
        return (e1 > 0.0 && e2 > 0.0) ? sum / std::sqrt (e1 * e2) : 0.0;
    };

    int bestLag = 0;
    double best = 0.0;
    for (int lag = minLag; lag <= maxLag; ++lag)
    {
        const double corr = corrAt (lag);
        if (corr > best)
        {
            best = corr;
            bestLag = lag;
        }
    }

    double lag = (double) bestLag;
    if (bestLag > minLag && bestLag < maxLag)
    {
        const double prev = corrAt (bestLag - 1);
        const double next = corrAt (bestLag + 1);
        const double denom = prev - 2.0 * best + next;
        if (std::abs (denom) > 1.0e-9)
            lag += 0.5 * (prev - next) / denom;
    }

    out.frequencyHz = sampleRate / std::max (lag, 1.0);
    out.confidence = std::clamp (best, 0.0, 1.0);
    out.voiced = out.confidence >= 0.72;
    return out;
}
}
