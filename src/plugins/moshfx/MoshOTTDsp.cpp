#include "MoshFxDsp.h"
#include "MoshFxMath.h"

#include <cmath>

namespace mosh::moshfx
{
namespace
{
    float updateEnv (float current, float value, float attackCoeff, float releaseCoeff)
    {
        const auto coeff = value > current ? attackCoeff : releaseCoeff;
        return value + coeff * (current - value);
    }

    float ottGainDb (float env, float amount, float upward, float downward, float trimDb)
    {
        const auto levelDb = (float) linToDb (env);
        float gainDb = trimDb;

        if (levelDb > -20.0f)
        {
            const auto compressed = -20.0f + (levelDb + 20.0f) / 4.0f;
            gainDb += (compressed - levelDb) * downward * amount;
        }

        if (levelDb > -76.0f && levelDb < -38.0f)
        {
            const auto lift = std::min (18.0f, (-38.0f - levelDb) * 0.45f);
            gainDb += lift * upward * amount;
        }

        return gainDb;
    }
}

void OTTCore::prepare (double newSampleRate)
{
    sampleRate = newSampleRate > 0.0 ? newSampleRate : 48000.0;
    reset();
}

void OTTCore::reset()
{
    lowState = 0.0f;
    highLpState = 0.0f;
    lowEnv = 0.0f;
    midEnv = 0.0f;
    highEnv = 0.0f;
}

void OTTCore::processBlock (float* samples, int numSamples, const OTTSettings& settings)
{
    if (samples == nullptr || numSamples <= 0)
        return;

    const auto amount = clamp01 (settings.amount);
    if (amount <= 0.0001f)
    {
        const auto gain = dbToGain (settings.outputDb);
        for (int i = 0; i < numSamples; ++i)
            samples[i] = softLimit (samples[i] * gain);
        return;
    }

    const auto lowCoeff = onePoleCoeff (120.0, sampleRate);
    const auto highCoeff = onePoleCoeff (3500.0, sampleRate);
    const auto timeSeconds = std::max (0.001f, settings.timeMs * 0.001f);
    const auto attackCoeff = std::exp (-1.0f / (std::max (0.001f, timeSeconds * 0.18f) * (float) sampleRate));
    const auto releaseCoeff = std::exp (-1.0f / (timeSeconds * (float) sampleRate));
    const auto mix = clamp01 (settings.mix);
    const auto outputGain = dbToGain (settings.outputDb);

    for (int i = 0; i < numSamples; ++i)
    {
        const auto dry = samples[i];

        lowState = dry + lowCoeff * (lowState - dry);
        highLpState = dry + highCoeff * (highLpState - dry);

        const auto low = lowState;
        const auto high = dry - highLpState;
        const auto mid = dry - low - high;

        lowEnv = updateEnv (lowEnv, std::abs (low), attackCoeff, releaseCoeff);
        midEnv = updateEnv (midEnv, std::abs (mid), attackCoeff, releaseCoeff);
        highEnv = updateEnv (highEnv, std::abs (high), attackCoeff, releaseCoeff);

        const auto lowGain = dbToGain (ottGainDb (lowEnv, amount, settings.upward, settings.downward, settings.lowGainDb));
        const auto midGain = dbToGain (ottGainDb (midEnv, amount, settings.upward, settings.downward, settings.midGainDb));
        const auto highGain = dbToGain (ottGainDb (highEnv, amount, settings.upward, settings.downward, settings.highGainDb));
        const auto wet = low * lowGain + mid * midGain + high * highGain;

        samples[i] = softLimit ((dry + (wet - dry) * mix) * outputGain);
    }
}
}
