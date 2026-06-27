#include "MoshFxDsp.h"
#include "MoshFxMath.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace mosh::moshfx
{
namespace
{
    // Decays the active cuts in place (compacting survivors to the front) and returns
    // the new count. No allocation — operates on the caller's fixed buffer.
    int releaseDecay (FeedbackCandidate* cuts, int count, int numSamples,
                      double sampleRate, const XFeedbackSettings& settings)
    {
        if (count <= 0)
            return 0;

        const auto releaseSeconds = std::max (0.001f, settings.releaseMs * 0.001f);
        const auto blockSeconds = sampleRate > 0.0 ? (double) numSamples / sampleRate : 0.0;
        const auto decay = (float) std::exp (-blockSeconds / (double) releaseSeconds);

        int write = 0;
        for (int i = 0; i < count; ++i)
        {
            cuts[i].score *= decay;
            cuts[i].depthDb *= decay;
            if (cuts[i].score >= 0.01f && cuts[i].depthDb >= 0.25f)
                cuts[write++] = cuts[i];
        }
        return write;
    }

    // Applies a narrow notch, carrying its biquad state across blocks. The state is only
    // re-zeroed when the target frequency changes meaningfully (or on first use), so a
    // steady feedback tone no longer produces a per-block startup transient.
    void applyNotch (float* samples, int numSamples, double sampleRate, double frequencyHz,
                     float depthDb, float mix, NotchState& st)
    {
        if (numSamples <= 0 || frequencyHz <= 0.0)
            return;

        if (st.frequencyHz <= 0.0 || std::abs (std::log2 (frequencyHz / st.frequencyHz)) > 0.02)
        {
            st.x1 = st.x2 = st.y1 = st.y2 = 0.0;
            st.frequencyHz = frequencyHz;
        }

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

        double x1 = st.x1, x2 = st.x2, y1 = st.y1, y2 = st.y2;
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
        st.x1 = x1;
        st.x2 = x2;
        st.y1 = y1;
        st.y2 = y2;
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

int detectFeedbackCandidates (const float* samples, int numSamples, double sampleRate,
                              const XFeedbackSettings& settings, FeedbackCandidate* out, int maxOut)
{
    if (out == nullptr || maxOut <= 0)
        return 0;
    if (samples == nullptr || numSamples < 128 || sampleRate <= 0.0)
        return 0;

    double energy = 0.0;
    for (int i = 0; i < numSamples; ++i)
        energy += (double) samples[i] * (double) samples[i];

    const auto rms = std::sqrt (energy / (double) numSamples);
    if (rms < 1.0e-5)
        return 0;

    const int bins = 128;
    const auto minHz = std::max (40.0f, settings.minHz);
    const auto maxHz = std::min ((float) sampleRate * 0.48f, std::max (minHz + 1.0f, settings.maxHz));
    const auto threshold = 0.06f + (1.0f - clamp01 (settings.sensitivity)) * 0.36f;
    const std::array<double, 7> offsets { -0.018, -0.012, -0.006, 0.0, 0.006, 0.012, 0.018 };

    // Raw candidates collected on the stack (one per bin, max) — no heap.
    std::array<FeedbackCandidate, (size_t) bins> raw {};
    int rawCount = 0;

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

        if (bestScore >= threshold && rawCount < (int) raw.size())
            raw[(size_t) rawCount++] = { bestHz, bestScore,
                                         std::clamp (settings.maxDepthDb * std::min (1.0f, bestScore), 3.0f, settings.maxDepthDb) };
    }

    std::sort (raw.begin(), raw.begin() + rawCount, [] (const auto& a, const auto& b)
    {
        return a.score > b.score;
    });

    const auto maxCuts = std::clamp (settings.maxCuts, 0, 4);
    const int limit = std::min (maxOut, maxCuts);
    int outCount = 0;
    for (int i = 0; i < rawCount && outCount < limit; ++i)
    {
        bool duplicate = false;
        for (int j = 0; j < outCount; ++j)
        {
            if (std::abs (std::log2 (raw[(size_t) i].frequencyHz / out[j].frequencyHz)) < 0.035)
            {
                duplicate = true;
                break;
            }
        }
        if (! duplicate)
            out[outCount++] = raw[(size_t) i];
    }
    return outCount;
}

std::vector<FeedbackCandidate> detectFeedbackCandidates (const float* samples, int numSamples,
                                                         double sampleRate, const XFeedbackSettings& settings)
{
    std::array<FeedbackCandidate, 4> buffer {};
    const int n = detectFeedbackCandidates (samples, numSamples, sampleRate, settings,
                                            buffer.data(), (int) buffer.size());
    return std::vector<FeedbackCandidate> (buffer.begin(), buffer.begin() + n);
}

void XFeedbackCore::prepare (double newSampleRate)
{
    sampleRate = newSampleRate > 0.0 ? newSampleRate : 48000.0;
    reset();
}

void XFeedbackCore::reset()
{
    numActiveCuts = 0;
    activeCuts = {};
    for (auto& n : notches)
        n = {};
}

XFeedbackState XFeedbackCore::processBlock (float* samples, int numSamples, const XFeedbackSettings& settings)
{
    XFeedbackState state;
    if (samples == nullptr || numSamples <= 0)
        return state;

    state.numCandidates = detectFeedbackCandidates (samples, numSamples, sampleRate, settings,
                                                    state.candidates.data(), (int) state.candidates.size());

    if (settings.autoSuppress)
    {
        const auto maxCuts = std::clamp (settings.maxCuts, 0, 4);
        if (state.numCandidates == 0)
        {
            numActiveCuts = releaseDecay (activeCuts.data(), numActiveCuts, numSamples, sampleRate, settings);
        }
        else
        {
            numActiveCuts = std::min (state.numCandidates, maxCuts);
            for (int i = 0; i < numActiveCuts; ++i)
                activeCuts[(size_t) i] = state.candidates[(size_t) i];
        }

        state.numActive = numActiveCuts;
        for (int i = 0; i < numActiveCuts; ++i)
        {
            state.activeCuts[(size_t) i] = activeCuts[(size_t) i];
            applyNotch (samples, numSamples, sampleRate, activeCuts[(size_t) i].frequencyHz,
                        activeCuts[(size_t) i].depthDb, settings.mix, notches[(size_t) i]);
        }
    }
    else
    {
        numActiveCuts = 0;
    }

    const auto outputGain = dbToGain (settings.outputDb);
    for (int i = 0; i < numSamples; ++i)
        samples[i] = softLimit (samples[i] * outputGain);

    return state;
}
}
