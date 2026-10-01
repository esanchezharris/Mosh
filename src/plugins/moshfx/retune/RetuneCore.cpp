#include "RetuneCore.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace mosh::moshfx::retune
{
namespace
{
    int nextPowerOfTwo (int n)
    {
        int p = 1;
        while (p < n)
            p <<= 1;
        return p;
    }

    TuneCorrection::Scale scaleFromIndex (int scale)
    {
        if (scale == 1) return TuneCorrection::Scale::major;
        if (scale == 2) return TuneCorrection::Scale::minor;
        return TuneCorrection::Scale::chromatic;
    }
}

bool RetuneCore::prepare (double sampleRate)
{
    if (sampleRate <= 0.0 || ! tracker.prepare (sampleRate))
        return false;

    rate = sampleRate;
    const auto& ts = tracker.getSettings();
    correction.prepare ((double) ts.hopFrames / sampleRate);
    shifter.prepare (sampleRate);
    latency = shifter.latencySamples();

    // Sub-blocks never exceed the distance to the next hop, which is at most one
    // analysis window (before the first hop).
    analysis.assign ((std::size_t) ts.windowFrames, 0.0f);
    const int ringSize = nextPowerOfTwo (latency + 1);
    dryRing.assign ((std::size_t) ringSize, 0.0f);
    dryMask = ringSize - 1;
    reset();
    return true;
}

void RetuneCore::reset()
{
    tracker.reset();
    correction.reset();
    shifter.reset();
    std::fill (dryRing.begin(), dryRing.end(), 0.0f);
    dryWrite = 0;
    readout = RetuneReadout {};
}

RetuneReadout RetuneCore::process (float* mono, int numSamples, const RetuneSettings& settings)
{
    if (mono == nullptr || numSamples <= 0 || analysis.empty())
        return readout;

    TuneCorrection::Params params;
    params.rootSemitone = std::clamp (settings.rootSemitone, 0, 11);
    params.scale = scaleFromIndex (settings.scale);
    params.retuneMs = settings.retuneMs <= kHardRetuneMs ? 0.0 : (double) settings.retuneMs;
    params.amount = settings.amount;
    params.maxCorrectionCents = settings.maxCorrectionCents;
    params.glide = settings.glide;

    const float mix = std::clamp (settings.mix, 0.0f, 1.0f);
    const float gain = std::pow (10.0f, settings.outputDb / 20.0f);

    int at = 0;
    while (at < numSamples)
    {
        // Split at the tracker's hop boundaries so control lands on the same
        // absolute samples under any chunking.
        const int untilHop = std::max (1, tracker.samplesToNextHop());
        const int count = std::min ({ numSamples - at, untilHop, (int) analysis.size() });
        float* chunk = mono + at;

        std::memcpy (analysis.data(), chunk, (std::size_t) count * sizeof (float));
        shifter.process (chunk, chunk, count);

        for (int i = 0; i < count; ++i)
        {
            dryRing[(std::size_t) dryWrite] = analysis[(std::size_t) i];
            const float dry = dryRing[(std::size_t) ((dryWrite + dryMask + 1 - latency) & dryMask)];
            dryWrite = (dryWrite + 1) & dryMask;
            // Fully wet takes the shifter's sample untouched, so an identity through
            // the shifter stays bit-exact through the core.
            const float wet = chunk[i];
            chunk[i] = (mix >= 1.0f ? wet : dry + (wet - dry) * mix) * gain;
        }

        tracker.pushBlock (analysis.data(), count, [this, &params] (const PitchTracker::Hop& hop)
        {
            const auto out = correction.update (hop.f0Hz, hop.voiced, params);
            const bool voiced = out.active && hop.voiced && hop.f0Hz > 0.0;
            if (voiced)
                shifter.setTarget (rate / hop.f0Hz, out.ratio);
            else
                shifter.setTarget (0.0, 1.0);

            readout.voiced = voiced;
            readout.confidence = (float) hop.clarity;
            readout.inputHz = voiced ? hop.f0Hz : 0.0;
            readout.targetHz = voiced && out.targetNote >= 0 ? TuneCorrection::noteToHz (out.targetNote) : 0.0;
            readout.correctionCents = voiced ? out.correctionCents : 0.0;
        });
        at += count;
    }
    return readout;
}

void SampleDelay::prepare (int delaySamples)
{
    delay = std::max (0, delaySamples);
    const int ringSize = nextPowerOfTwo (delay + 1);
    ring.assign ((std::size_t) ringSize, 0.0f);
    mask = ringSize - 1;
    write = 0;
}

void SampleDelay::reset()
{
    std::fill (ring.begin(), ring.end(), 0.0f);
    write = 0;
}

void SampleDelay::process (float* samples, int numSamples)
{
    if (samples == nullptr || ring.empty())
        return;
    for (int i = 0; i < numSamples; ++i)
    {
        ring[(std::size_t) write] = samples[i];
        samples[i] = ring[(std::size_t) ((write + mask + 1 - delay) & mask)];
        write = (write + 1) & mask;
    }
}
}
