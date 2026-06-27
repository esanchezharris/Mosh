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

void AutoTuneCore::prepare (double newSampleRate)
{
    sampleRate = newSampleRate > 0.0 ? newSampleRate : 48000.0;
    reset();
}

void AutoTuneCore::reset()
{
    synthPhase = 0.0;
    smoothedCorrectionCents = 0.0;
    synthFrequencyHz = 0.0;
    synthAmplitude = 0.0f;
    wetEnvelope = 0.0f;
}

AutoTuneResult AutoTuneCore::processBlock (float* samples, int numSamples, const AutoTuneSettings& settings)
{
    AutoTuneResult result;
    if (samples == nullptr || numSamples <= 0)
        return result;

    result = analyseAutoTuneBlock (samples, numSamples, sampleRate, settings);

    const double blockSeconds = sampleRate > 0.0 ? (double) numSamples / sampleRate : 0.0;
    const double response = retuneCoefficient (blockSeconds, settings.retuneMs);
    const bool engaged = result.corrected;

    if (engaged)
    {
        smoothedCorrectionCents += (result.correctionCents - smoothedCorrectionCents) * response;
        synthFrequencyHz = result.input.frequencyHz * std::pow (2.0, smoothedCorrectionCents / 1200.0);
    }
    // When unvoiced we freeze the correction and frequency and let the envelope
    // ring the tone down — the held values keep the fade-out tail in tune.
    result.correctionCents = smoothedCorrectionCents;
    result.corrected = engaged && std::abs (smoothedCorrectionCents) > 0.05;

    const float outputGain = dbToGain (settings.outputDb);
    const float mix = clamp01 (settings.mix);

    // Per-sample one-pole envelopes (fixed ~5 ms) so the resynthesized tone fades
    // in/out across voiced boundaries instead of snapping. wetEnvelope gates the
    // dry/wet blend (-> dry when idle); synthAmplitude tracks the held tone level
    // so the tail rings down cleanly rather than jumping to zero.
    const float fadeCoeff = (float) std::exp (-1.0 / std::max (sampleRate * 0.005, 1.0));
    const float wetTarget = engaged ? 1.0f : 0.0f;
    const float ampTarget = engaged ? (float) (result.input.rms * std::sqrt (2.0)) : synthAmplitude;
    const double inc = 2.0 * kPi * synthFrequencyHz / sampleRate;

    for (int i = 0; i < numSamples; ++i)
    {
        synthAmplitude = ampTarget + (synthAmplitude - ampTarget) * fadeCoeff;
        wetEnvelope = wetTarget + (wetEnvelope - wetTarget) * fadeCoeff;
        const float wet = synthAmplitude * (float) std::sin (synthPhase);
        const float dry = samples[i];
        samples[i] = softLimit ((dry + (wet - dry) * (mix * wetEnvelope)) * outputGain);
        synthPhase += inc;
        if (synthPhase >= 2.0 * kPi)
            synthPhase -= 2.0 * kPi;
    }
    return result;
}
}
