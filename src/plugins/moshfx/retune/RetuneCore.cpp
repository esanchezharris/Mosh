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
    shifterLatency = shifter.latencySamples();
    maxLookahead = (int) std::lround (kMaxLookaheadMs * 0.001 * sampleRate);
    lookahead = 0;
    latency = shifterLatency;

    // Sub-blocks never exceed the distance to the next hop, which is at most one
    // analysis window (before the first hop).
    analysis.assign ((std::size_t) ts.windowFrames, 0.0f);
    // One ring serves the look-ahead delay into the shifter and the dry path; it
    // is sized for the largest look-ahead so changing it never allocates.
    const int ringSize = nextPowerOfTwo (shifterLatency + maxLookahead + 1);
    dryRing.assign ((std::size_t) ringSize, 0.0f);
    dryMask = ringSize - 1;
    reset();
    return true;
}

int RetuneCore::latencySamplesFor (double sampleRate, float lookaheadMs)
{
    if (sampleRate <= 0.0)
        return 0;
    const int maxSamples = (int) std::lround (kMaxLookaheadMs * 0.001 * sampleRate);
    const int samples = std::clamp ((int) std::lround ((double) lookaheadMs * 0.001 * sampleRate), 0, maxSamples);
    return SpliceShifter::latencySamplesFor (sampleRate) + samples;
}

void RetuneCore::setLookaheadMs (float ms) noexcept
{
    if (dryRing.empty())
        return;
    const int wanted = std::clamp ((int) std::lround ((double) ms * 0.001 * rate), 0, maxLookahead);
    if (wanted == lookahead)
        return;
    lookahead = wanted;
    latency = shifterLatency + lookahead;
    // The audio path's delay just changed, so its history is no longer aligned.
    // The tracker keeps listening to the same undelayed input and is left alone.
    shifter.reset();
    std::fill (dryRing.begin(), dryRing.end(), 0.0f);
    dryWrite = 0;
    heldPeriod = 0.0;
}

void RetuneCore::reset()
{
    tracker.reset();
    correction.reset();
    shifter.reset();
    std::fill (dryRing.begin(), dryRing.end(), 0.0f);
    dryWrite = 0;
    heldPeriod = 0.0;
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

        // The shifter is fed the input `lookahead` samples late, so the tracker
        // (which hears it undelayed) has already seen the audio being corrected.
        const int ringSize = dryMask + 1;
        const int base = dryWrite;
        for (int i = 0; i < count; ++i)
        {
            dryRing[(std::size_t) dryWrite] = analysis[(std::size_t) i];
            chunk[i] = dryRing[(std::size_t) ((dryWrite + ringSize - lookahead) & dryMask)];
            dryWrite = (dryWrite + 1) & dryMask;
        }
        shifter.process (chunk, chunk, count);

        for (int i = 0; i < count; ++i)
        {
            const float dry = dryRing[(std::size_t) ((base + i + ringSize - latency) & dryMask)];
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
            {
                heldPeriod = rate / hop.f0Hz;
                shifter.setTarget (heldPeriod, out.ratio);
            }
            else if (out.holding && heldPeriod > 0.0)
            {
                // A short dropout inside a note: keep shifting at the held ratio.
                // Releasing here would let the pitch blip back to uncorrected and
                // force a recentre crossfade in the middle of the note.
                shifter.setTarget (heldPeriod, out.ratio);
            }
            else
            {
                heldPeriod = 0.0;
                shifter.setTarget (0.0, 1.0);
            }

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

void SampleDelay::prepare (int maxDelaySamples)
{
    const int ringSize = nextPowerOfTwo (std::max (0, maxDelaySamples) + 1);
    ring.assign ((std::size_t) ringSize, 0.0f);
    mask = ringSize - 1;
    write = 0;
    delay = 0;
}

void SampleDelay::setDelay (int delaySamples) noexcept
{
    const int wanted = std::clamp (delaySamples, 0, mask);
    if (wanted == delay)
        return;
    delay = wanted;
    reset();
}

void SampleDelay::reset() noexcept
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
