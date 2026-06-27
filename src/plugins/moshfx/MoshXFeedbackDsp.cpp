#include "MoshFxDsp.h"
#include "MoshFxMath.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace mosh::moshfx
{
namespace
{
    std::vector<FeedbackCandidate> releasedCuts (std::vector<FeedbackCandidate> cuts,
                                                 int numSamples,
                                                 double sampleRate,
                                                 const XFeedbackSettings& settings)
    {
        if (cuts.empty())
            return cuts;

        const auto releaseSeconds = std::max (0.001f, settings.releaseMs * 0.001f);
        const auto blockSeconds = sampleRate > 0.0 ? (double) numSamples / sampleRate : 0.0;
        const auto decay = (float) std::exp (-blockSeconds / (double) releaseSeconds);

        for (auto& cut : cuts)
        {
            cut.score *= decay;
            cut.depthDb *= decay;
        }

        cuts.erase (std::remove_if (cuts.begin(), cuts.end(), [] (const auto& cut)
        {
            return cut.score < 0.01f || cut.depthDb < 0.25f;
        }), cuts.end());

        return cuts;
    }

    void applyNotch (float* samples, int numSamples, double sampleRate, double frequencyHz,
                     float depthDb, float mix)
    {
        if (numSamples <= 0 || frequencyHz <= 0.0)
            return;

        const auto omega = 2.0 * kPi * std::clamp (frequencyHz / sampleRate, 0.0, 0.49);
        const auto q = 30.0;
        const auto alpha = std::sin (omega) / (2.0 * q);
        const auto c = std::cos (omega);
        const auto a0 = 1.0 + alpha;
        const auto b0 = 1.0 / a0;
        const auto b1 = -2.0 * c / a0;
        const auto b2 = 1.0 / a0;
        const auto a1 = -2.0 * c / a0;
        const auto a2 = (1.0 - alpha) / a0;
        const auto depthMix = std::clamp (1.0f - dbToGain (-std::abs (depthDb)), 0.0f, 1.0f) * clamp01 (mix);

        double x1 = 0.0;
        double x2 = 0.0;
        double y1 = 0.0;
        double y2 = 0.0;

        for (int i = 0; i < numSamples; ++i)
        {
            const auto x0 = (double) samples[i];
            const auto y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
            samples[i] = (float) (x0 + ((float) y0 - (float) x0) * depthMix);
        }
    }
}

double goertzelMagnitude (const float* samples, int numSamples, double sampleRate, double frequencyHz)
{
    if (samples == nullptr || numSamples <= 0 || sampleRate <= 0.0 || frequencyHz <= 0.0)
        return 0.0;

    const auto omega = 2.0 * kPi * frequencyHz / sampleRate;
    const auto coeff = 2.0 * std::cos (omega);
    double q1 = 0.0;
    double q2 = 0.0;

    for (int i = 0; i < numSamples; ++i)
    {
        const auto q0 = coeff * q1 - q2 + samples[i];
        q2 = q1;
        q1 = q0;
    }

    const auto power = q1 * q1 + q2 * q2 - q1 * q2 * coeff;
    return std::sqrt (std::max (0.0, power)) / (double) numSamples;
}

std::vector<FeedbackCandidate> detectFeedbackCandidates (const float* samples, int numSamples,
                                                         double sampleRate, const XFeedbackSettings& settings)
{
    std::vector<FeedbackCandidate> out;
    if (samples == nullptr || numSamples < 128 || sampleRate <= 0.0)
        return out;

    double energy = 0.0;
    for (int i = 0; i < numSamples; ++i)
        energy += (double) samples[i] * (double) samples[i];

    const auto rms = std::sqrt (energy / (double) numSamples);
    if (rms < 1.0e-5)
        return out;

    const int bins = 128;
    const auto minHz = std::max (40.0f, settings.minHz);
    const auto maxHz = std::min ((float) sampleRate * 0.48f, std::max (minHz + 1.0f, settings.maxHz));
    const auto threshold = 0.06f + (1.0f - clamp01 (settings.sensitivity)) * 0.36f;
    const std::array<double, 7> offsets { -0.018, -0.012, -0.006, 0.0, 0.006, 0.012, 0.018 };

    for (int i = 0; i < bins; ++i)
    {
        const auto t = (double) i / (double) (bins - 1);
        const auto centerHz = (double) minHz * std::pow ((double) maxHz / (double) minHz, t);
        double bestHz = centerHz;
        float bestScore = 0.0f;

        for (auto offset : offsets)
        {
            const auto hz = std::clamp (centerHz * (1.0 + offset), (double) minHz, (double) maxHz);
            const auto mag = goertzelMagnitude (samples, numSamples, sampleRate, hz);
            const auto score = (float) (mag / std::max (rms, 1.0e-7));
            if (score > bestScore)
            {
                bestScore = score;
                bestHz = hz;
            }
        }

        if (bestScore >= threshold)
            out.push_back ({ bestHz, bestScore, std::clamp (settings.maxDepthDb * std::min (1.0f, bestScore), 3.0f, settings.maxDepthDb) });
    }

    std::sort (out.begin(), out.end(), [] (const auto& a, const auto& b)
    {
        return a.score > b.score;
    });

    std::vector<FeedbackCandidate> unique;
    for (const auto& candidate : out)
    {
        const auto duplicate = std::any_of (unique.begin(), unique.end(), [&] (const auto& kept)
        {
            return std::abs (std::log2 (candidate.frequencyHz / kept.frequencyHz)) < 0.035;
        });
        if (! duplicate)
            unique.push_back (candidate);
    }
    out = std::move (unique);

    const auto maxCuts = std::clamp (settings.maxCuts, 0, 4);
    if ((int) out.size() > maxCuts)
        out.resize ((size_t) maxCuts);

    return out;
}

void XFeedbackCore::prepare (double newSampleRate)
{
    sampleRate = newSampleRate > 0.0 ? newSampleRate : 48000.0;
}

void XFeedbackCore::reset()
{
    activeCuts.clear();
}

XFeedbackState XFeedbackCore::processBlock (float* samples, int numSamples, const XFeedbackSettings& settings)
{
    XFeedbackState state;
    if (samples == nullptr || numSamples <= 0)
        return state;

    state.candidates = detectFeedbackCandidates (samples, numSamples, sampleRate, settings);
    if (settings.autoSuppress)
    {
        activeCuts = state.candidates.empty()
                         ? releasedCuts (std::move (activeCuts), numSamples, sampleRate, settings)
                         : state.candidates;
        const auto maxCuts = std::clamp (settings.maxCuts, 0, 4);
        if ((int) activeCuts.size() > maxCuts)
            activeCuts.resize ((size_t) maxCuts);

        state.activeCuts = activeCuts;
        for (const auto& cut : activeCuts)
            applyNotch (samples, numSamples, sampleRate, cut.frequencyHz, cut.depthDb, settings.mix);
    }
    else
    {
        activeCuts.clear();
    }

    const auto outputGain = dbToGain (settings.outputDb);
    for (int i = 0; i < numSamples; ++i)
        samples[i] = softLimit (samples[i] * outputGain);

    return state;
}
}
