#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

// Streaming monophonic pitch tracking for Mosh AutoTune
// (docs/AUTOTUNE-SCOPE-2026-10-01.md §5). Ported from the owner's Moshpit M009
// TunePitchTracker: YIN (difference function, cumulative-mean normalisation,
// absolute threshold, parabolic refinement) on a preallocated ring, with the hop
// cadence anchored to the absolute sample count so any chunking of the same
// samples yields bit-identical hops. Changes from the original: to cut detection
// lag for the low-latency shifter, the fixed comparison segment is the MOST RECENT
// span of samples (the lagged one slides back in time) and the median is 3 taps;
// to stop notes dropping out, a voiced run survives a weaker match near the held
// pitch (the continuity rescue below); and a clarity value is reported. No
// allocation, locks, logging or IO after prepare().

namespace mosh::moshfx::retune
{
class PitchTracker
{
public:
    struct Settings
    {
        int windowFrames = 0;
        int hopFrames = 0;
        int tauMin = 0;
        int tauMax = 0;
        int span = 0;
        double threshold = 0.15;        // CMNDF threshold to START a voiced run
        double releaseThreshold = 0.35; // ... and to STAY in one, near the held pitch only
        double rmsGate = 0.00316; // -50 dBFS
        int medianTaps = 3;
        int voicingHysteresisFrames = 3;
        double jumpRejectCents = 600.0;
        int jumpPersistFrames = 3;
    };

    // The 70-800 Hz vocal band; the span scales with the rate (~21.3 ms) and the
    // window is exactly span + tauMax, so every lag compares equal evidence.
    [[nodiscard]] static Settings settingsFor (double sampleRate)
    {
        Settings s;
        s.tauMin = std::max (2, (int) std::floor (sampleRate / 800.0));
        s.tauMax = (int) std::ceil (sampleRate / 70.0);
        s.span = std::max (256, (int) (sampleRate * 0.0213));
        s.windowFrames = s.span + s.tauMax;
        s.hopFrames = std::max (16, s.windowFrames / 8);
        return s;
    }

    struct Hop
    {
        double f0Hz = 0.0;    // 0 while unvoiced
        double clarity = 0.0; // 1 - CMNDF at the chosen lag, 0..1
        bool voiced = false;
    };

    bool prepare (double sampleRate)
    {
        if (sampleRate <= 0.0)
            return false;
        rate = sampleRate;
        settings = settingsFor (sampleRate);
        ringSize = 1;
        while (ringSize < settings.windowFrames * 2)
            ringSize <<= 1;
        ring.assign ((std::size_t) ringSize, 0.0f);
        windowScratch.assign ((std::size_t) settings.windowFrames, 0.0f);
        cmndf.assign ((std::size_t) settings.tauMax + 1, 1.0);
        reset();
        return true;
    }

    void reset()
    {
        std::fill (ring.begin(), ring.end(), 0.0f);
        samplesSinceReset = 0;
        nextHopAt = (std::uint64_t) settings.windowFrames;
        medianCount = 0;
        medianNext = 0;
        voicedState = false;
        hysteresisRun = 0;
        heldF0 = 0.0;
        jumpRun = 0;
        latest = Hop {};
    }

    [[nodiscard]] const Settings& getSettings() const noexcept { return settings; }
    [[nodiscard]] const Hop& current() const noexcept { return latest; }

    // Frames until the next hop fires, for sub-block control interleaving.
    [[nodiscard]] int samplesToNextHop() const noexcept
    {
        return (int) (nextHopAt - samplesSinceReset);
    }

    // Streams one mono block; fires onHop (const Hop&) for every hop boundary the
    // block completes.
    template <typename HopFn>
    void pushBlock (const float* mono, int numFrames, HopFn&& onHop)
    {
        if (mono == nullptr || numFrames <= 0 || ringSize == 0)
            return;
        const auto mask = (std::uint64_t) (ringSize - 1);
        for (int frame = 0; frame < numFrames; ++frame)
        {
            ring[(std::size_t) (samplesSinceReset & mask)] = mono[frame];
            ++samplesSinceReset;
            if (samplesSinceReset == nextHopAt)
            {
                nextHopAt += (std::uint64_t) settings.hopFrames;
                latest = analyzeHop();
                onHop ((const Hop&) latest);
            }
        }
    }

private:
    [[nodiscard]] Hop analyzeHop()
    {
        // Linearize the last windowFrames samples ending at samplesSinceReset.
        const auto mask = (std::uint64_t) (ringSize - 1);
        const int window = settings.windowFrames;
        const auto start = samplesSinceReset - (std::uint64_t) window;
        for (int i = 0; i < window; ++i)
            windowScratch[(std::size_t) i] = ring[(std::size_t) ((start + (std::uint64_t) i) & mask)];

        double rawF0 = 0.0;
        double rawClarity = 0.0;
        bool rawVoiced = false;
        {
            const float* w = windowScratch.data();
            const int tauMin = settings.tauMin;
            const int tauMax = settings.tauMax;
            const int span = settings.span;
            // The fixed segment is the newest `span` samples; `recent[i - tau]` is the
            // same segment one lag earlier.
            const float* recent = w + (window - span);
            double rms = 0.0;
            for (int i = 0; i < window; ++i)
                rms += (double) w[i] * (double) w[i];
            rms = std::sqrt (rms / window);
            if (rms >= settings.rmsGate && tauMax > tauMin && span >= 32)
            {
                // Tau decimation: full lag resolution through tauFull (~280 Hz and
                // above), stride 2 beneath. The cumulative mean normalizes over the
                // COMPUTED lags and the parabolic refine uses the local stride, so
                // sub-sample accuracy survives.
                const int tauFull = std::min (tauMax, std::max (2 * tauMin, (int) std::ceil (rate / 280.0)));
                const auto strided = [tauFull] (int tau) { return tau > tauFull && ((tau - tauFull) & 1) != 0; };
                double runningSum = 0.0;
                int computedCount = 0;
                for (int tau = 1; tau <= tauMax; ++tau)
                {
                    if (strided (tau))
                    {
                        cmndf[(std::size_t) tau] = 1.0e9;
                        continue;
                    }
                    double difference = 0.0;
                    const float* lagged = recent - tau;
                    for (int i = 0; i < span; ++i)
                    {
                        const double delta = (double) recent[i] - (double) lagged[i];
                        difference += delta * delta;
                    }
                    runningSum += difference;
                    ++computedCount;
                    cmndf[(std::size_t) tau] = runningSum > 0.0 ? difference * computedCount / runningSum : 1.0;
                }
                const auto next = [tauFull] (int tau) { return tau + (tau >= tauFull ? 2 : 1); };
                int best = tauMin;
                for (int tau = tauMin; tau <= tauMax; tau = next (tau))
                    if (cmndf[(std::size_t) tau] < cmndf[(std::size_t) best])
                        best = tau;
                bool found = false;
                for (int tau = tauMin; tau <= tauMax; tau = next (tau))
                {
                    if (cmndf[(std::size_t) tau] < settings.threshold)
                    {
                        int trough = tau;
                        while (next (trough) <= tauMax
                               && cmndf[(std::size_t) next (trough)] < cmndf[(std::size_t) trough])
                            trough = next (trough);
                        best = trough;
                        found = true;
                        break;
                    }
                }
                double limit = settings.threshold;
                // Continuity rescue: inside a voiced run, a breathy or reverberant
                // stretch can miss the strict threshold. Look only near the held
                // pitch (+/- 4 semitones) and accept the looser release threshold
                // there. Searching the whole band at the looser threshold instead
                // would pick octave-up lags (measured on vocadito).
                if (! found && voicedState && heldF0 > 0.0 && settings.releaseThreshold > settings.threshold)
                {
                    const double heldTau = rate / heldF0;
                    const int from = std::max (tauMin, (int) std::floor (heldTau / 1.26));
                    const int to = std::min (tauMax, (int) std::ceil (heldTau * 1.26));
                    int near = -1;
                    for (int tau = from; tau <= to; ++tau)
                        if (! strided (tau) && (near < 0 || cmndf[(std::size_t) tau] < cmndf[(std::size_t) near]))
                            near = tau;
                    if (near > 0 && cmndf[(std::size_t) near] < settings.releaseThreshold)
                    {
                        best = near;
                        limit = settings.releaseThreshold;
                    }
                }
                double tauEstimate = (double) best;
                const int stride = best > tauFull ? 2 : 1;
                const int lo = best - stride;
                const int hi = best + stride;
                if (lo > 0 && hi <= tauMax && ! strided (lo) && ! strided (hi))
                {
                    const double previous = cmndf[(std::size_t) lo];
                    const double centre = cmndf[(std::size_t) best];
                    const double after = cmndf[(std::size_t) hi];
                    const double denominator = previous - 2.0 * centre + after;
                    if (std::abs (denominator) > 1.0e-12)
                        tauEstimate += stride * 0.5 * (previous - after) / denominator;
                }
                rawF0 = rate / std::max (tauEstimate, 1.0);
                rawVoiced = cmndf[(std::size_t) best] < limit;
                rawClarity = std::clamp (1.0 - cmndf[(std::size_t) best], 0.0, 1.0);
            }
        }

        // Causal voicing hysteresis.
        const int hysteresis = std::max (1, settings.voicingHysteresisFrames);
        if (rawVoiced != voicedState)
        {
            if (++hysteresisRun >= hysteresis)
            {
                voicedState = rawVoiced;
                hysteresisRun = 0;
            }
        }
        else
            hysteresisRun = 0;

        Hop hop;
        hop.clarity = rawClarity;
        hop.voiced = voicedState && rawF0 > 0.0;
        if (! hop.voiced)
        {
            // The jump counter resets so re-entry re-arms cleanly.
            jumpRun = 0;
            hop.f0Hz = 0.0;
            return hop;
        }

        // Reject >600-cent jumps from the held estimate unless they persist — a
        // causal octave-blip guard.
        double accepted = rawF0;
        if (heldF0 > 0.0)
        {
            const double jumpCents = std::abs (1200.0 * std::log2 (rawF0 / heldF0));
            if (jumpCents > settings.jumpRejectCents)
            {
                if (++jumpRun < settings.jumpPersistFrames)
                    accepted = heldF0;
                else
                {
                    // An ACCEPTED persistent jump flushes the median ring. Its old
                    // majority would otherwise keep the median (and so heldF0) at the
                    // old pitch and re-reject the new one every persist window — a
                    // permanent latch that never follows a real octave step.
                    jumpRun = 0;
                    for (auto& value : medianRing)
                        value = accepted;
                }
            }
            else
                jumpRun = 0;
        }

        // Causal median over the last medianTaps accepted values.
        const int taps = std::clamp (settings.medianTaps, 1, 15);
        medianRing[medianNext] = accepted;
        medianNext = (medianNext + 1) % taps;
        medianCount = std::min (medianCount + 1, taps);
        double sorted[16];
        for (int i = 0; i < medianCount; ++i)
            sorted[i] = medianRing[i];
        std::sort (sorted, sorted + medianCount);
        hop.f0Hz = sorted[medianCount / 2];
        heldF0 = hop.f0Hz;
        return hop;
    }

    double rate = 0.0;
    Settings settings;
    int ringSize = 0;
    std::vector<float> ring;
    std::vector<float> windowScratch;
    std::vector<double> cmndf;
    std::uint64_t samplesSinceReset = 0;
    std::uint64_t nextHopAt = 0;
    double medianRing[16] = {};
    int medianCount = 0;
    int medianNext = 0;
    bool voicedState = false;
    int hysteresisRun = 0;
    double heldF0 = 0.0;
    int jumpRun = 0;
    Hop latest;
};
}
