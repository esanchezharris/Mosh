#include "MoshFxDsp.h"
#include "MoshFxMath.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace mosh::moshfx
{
namespace
{
    bool scaleAllows (int semitone, int root, ScaleKind scale)
    {
        static constexpr std::array<int, 7> major { 0, 2, 4, 5, 7, 9, 11 };
        static constexpr std::array<int, 7> minor { 0, 2, 3, 5, 7, 8, 10 };
        const int pc = ((semitone - root) % 12 + 12) % 12;

        if (scale == ScaleKind::chromatic)
            return true;

        const auto& intervals = scale == ScaleKind::major ? major : minor;
        return std::find (intervals.begin(), intervals.end(), pc) != intervals.end();
    }

    double midiToHz (double midi)
    {
        return 440.0 * std::pow (2.0, (midi - 69.0) / 12.0);
    }

    double hzToMidi (double hz)
    {
        return 69.0 + 12.0 * std::log2 (hz / 440.0);
    }
}

PitchAnalysis estimateMonophonicPitch (const float* samples, int numSamples, double sampleRate,
                                       double minHz, double maxHz)
{
    PitchAnalysis out;
    if (samples == nullptr || numSamples < 64 || sampleRate <= 0.0)
        return out;

    double mean = 0.0;
    for (int i = 0; i < numSamples; ++i)
        mean += samples[i];
    mean /= (double) numSamples;

    double energy = 0.0;
    for (int i = 0; i < numSamples; ++i)
    {
        const auto v = (double) samples[i] - mean;
        energy += v * v;
    }

    out.rms = std::sqrt (energy / (double) numSamples);
    if (out.rms < 1.0e-4)
        return out;

    const int minLag = std::max (2, (int) std::floor (sampleRate / std::max (maxHz, 1.0)));
    const int maxLag = std::min ((int) std::ceil (sampleRate / std::max (minHz, 1.0)), numSamples / 2);
    if (maxLag <= minLag)
        return out;

    int bestLag = 0;
    double best = 0.0;
    double prev = 0.0;
    double next = 0.0;

    auto corrAt = [&] (int lag)
    {
        double sum = 0.0;
        double e1 = 0.0;
        double e2 = 0.0;
        const int count = numSamples - lag;
        for (int i = 0; i < count; ++i)
        {
            const auto a = (double) samples[i] - mean;
            const auto b = (double) samples[i + lag] - mean;
            sum += a * b;
            e1 += a * a;
            e2 += b * b;
        }
        return (e1 > 0.0 && e2 > 0.0) ? sum / std::sqrt (e1 * e2) : 0.0;
    };

    for (int lag = minLag; lag <= maxLag; ++lag)
    {
        const auto corr = corrAt (lag);
        if (corr > best)
        {
            best = corr;
            bestLag = lag;
        }
    }

    if (bestLag > minLag && bestLag < maxLag)
    {
        prev = corrAt (bestLag - 1);
        next = corrAt (bestLag + 1);
    }

    double lag = (double) bestLag;
    const auto denom = prev - 2.0 * best + next;
    if (std::abs (denom) > 1.0e-9)
        lag += 0.5 * (prev - next) / denom;

    out.frequencyHz = sampleRate / std::max (lag, 1.0);
    out.confidence = std::clamp (best, 0.0, 1.0);
    out.voiced = out.confidence >= 0.72;
    return out;
}

double nearestScaleFrequency (double frequencyHz, int rootSemitone, ScaleKind scale)
{
    if (frequencyHz <= 0.0)
        return 0.0;

    const auto midi = hzToMidi (frequencyHz);
    const int center = (int) std::round (midi);
    double bestMidi = (double) center;
    double bestDistance = 1.0e9;

    for (int note = center - 24; note <= center + 24; ++note)
    {
        if (! scaleAllows (note, rootSemitone, scale))
            continue;

        const auto distance = std::abs ((double) note - midi);
        if (distance < bestDistance)
        {
            bestDistance = distance;
            bestMidi = (double) note;
        }
    }

    return midiToHz (bestMidi);
}

double retuneCoefficient (double blockSeconds, float retuneMs)
{
    const auto seconds = std::max (blockSeconds, 0.0);
    const auto timeSeconds = std::max (0.001, (double) retuneMs * 0.001);
    return std::clamp (1.0 - std::exp (-seconds / timeSeconds), 0.0, 1.0);
}

AutoTuneResult analyseAutoTuneBlock (const float* input, int numSamples,
                                     double sampleRate, const AutoTuneSettings& settings)
{
    AutoTuneResult result;
    if (input == nullptr || numSamples <= 0)
        return result;

    result.input = estimateMonophonicPitch (input, numSamples, sampleRate, settings.minHz, settings.maxHz);
    if (! result.input.voiced)
        return result;

    result.targetFrequencyHz = nearestScaleFrequency (result.input.frequencyHz, settings.rootSemitone, settings.scale);
    if (result.targetFrequencyHz <= 0.0)
        return result;

    const auto requestedCents = 1200.0 * std::log2 (result.targetFrequencyHz / result.input.frequencyHz);
    const auto clampedCents = std::clamp (requestedCents,
                                          -(double) std::abs (settings.maxCorrectionCents),
                                          (double) std::abs (settings.maxCorrectionCents));
    result.correctionCents = clampedCents * clamp01 (settings.amount);
    result.corrected = std::abs (result.correctionCents) > 0.05;
    return result;
}

AutoTuneResult processAutoTuneBlock (const float* input, float* output, int numSamples,
                                     double sampleRate, const AutoTuneSettings& settings)
{
    AutoTuneResult result;
    if (input == nullptr || output == nullptr || numSamples <= 0)
        return result;

    const auto outputGain = dbToGain (settings.outputDb);

    auto copyDry = [&]
    {
        for (int i = 0; i < numSamples; ++i)
            output[i] = softLimit (input[i] * outputGain);
    };

    result = analyseAutoTuneBlock (input, numSamples, sampleRate, settings);
    const auto blockSeconds = sampleRate > 0.0 ? (double) numSamples / sampleRate : 0.0;
    result.correctionCents *= retuneCoefficient (blockSeconds, settings.retuneMs);
    result.corrected = std::abs (result.correctionCents) > 0.05;

    if (! result.corrected)
    {
        copyDry();
        return result;
    }

    const auto ratio = std::pow (2.0, result.correctionCents / 1200.0);
    const auto mix = clamp01 (settings.mix);
    for (int i = 0; i < numSamples; ++i)
    {
        const auto pos = (double) i * ratio;
        const int i0 = std::clamp ((int) std::floor (pos), 0, std::max (0, numSamples - 1));
        const int i1 = std::min (i0 + 1, numSamples - 1);
        const auto frac = (float) (pos - (double) i0);
        const auto wet = input[i0] + (input[i1] - input[i0]) * frac;
        output[i] = softLimit ((input[i] + (wet - input[i]) * mix) * outputGain);
    }

    return result;
}

AutoTuneResult processAutoTuneBlock (const std::vector<float>& input, std::vector<float>& output,
                                     double sampleRate, const AutoTuneSettings& settings)
{
    output.assign (input.size(), 0.0f);
    return processAutoTuneBlock (input.data(), output.data(), (int) input.size(), sampleRate, settings);
}
}
