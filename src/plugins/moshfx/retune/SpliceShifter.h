// SpliceShifter.h -- time-varying pitch shifter for the native retuner.
//
// Behavioural spec: docs/AUTOTUNE-SCOPE-2026-10-01.md section 7.
//
// The input is written to a ring buffer and read back through a fractional delay `d`
// that is pushed by (1 - r) every sample, so a ratio r > 1 raises the pitch. When the
// read head drifts out of its window the shifter jumps by one pitch period with a
// raised-cosine crossfade, which keeps the output continuous and the formants moving
// with the pitch.
//
// Header-only, standard library only (no JUCE). prepare() is the only call that
// allocates. process() performs no allocation, locking, logging or IO, advances all of
// its state per sample (so output is bit-identical under any block chunking), and
// is safe when `in` and `out` are the same buffer.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace mosh::moshfx::retune
{

class SpliceShifter
{
public:
    // ---- Interface (spec section 7) --------------------------------------------------

    // Allocates. Never call on the audio thread. Leaves the shifter unvoiced with
    // d = latencySamples().
    void prepare (double sampleRate)
    {
        fs_ = sampleRate >= 8000.0 ? sampleRate : 8000.0;  // also rejects NaN

        // D = half the interpolator + 1 + the furthest the old read head can close on
        // the write head during the longest crossfade at the largest ratio + 4.
        const double travel = kMaxCrossfadeSeconds * fs_ * (kMaxRatio - 1.0);
        latency_ = kReach + 1 + (int) std::ceil (travel) + 4;

        minPeriod_ = fs_ / 1200.0;
        maxPeriod_ = fs_ / 55.0;

        // The ring must hold the deepest read (D + 1.5 P plus a crossfade's drift, rounded
        // up to 2.6 P) plus the correlation segment and the older candidate's reach.
        const double needed = (double) latency_ + 2.6 * maxPeriod_ + 0.010 * fs_ + 32.0;
        std::size_t size = 64;
        while ((double) size < needed)
            size <<= 1;
        ring_.assign (size, 0.0f);
        mask_ = (std::uint32_t) (size - 1);
        ringSize_ = (int) size;
        maxReadDelay_ = (double) (ringSize_ - 2 * kReach);

        ratioCoef_ = 1.0 - std::exp (-1.0 / (kRatioTimeConstantSeconds * fs_));
        recentreLength_ = std::max (1, (int) std::lround (kRecentreSeconds * fs_));
        minXfade_ = std::max (1, (int) std::lround (0.002 * fs_));
        maxXfade_ = std::max (minXfade_, (int) std::lround (kMaxCrossfadeSeconds * fs_));
        minSegment_ = minXfade_;
        maxSegment_ = std::max (minSegment_, (int) std::lround (0.010 * fs_));
        searchStride_ = std::max (1, (int) std::lround (fs_ / 48000.0));

        buildKernelTable();
        reset();
    }

    // Clears audio and control state. No allocation. Back to unvoiced, d = D, r = 1.
    void reset() noexcept
    {
        std::fill (ring_.begin(), ring_.end(), 0.0f);
        head_ = 0;
        newest_ = 0;
        d_ = (double) latency_;
        dIncoming_ = d_;
        ratio_ = 1.0;
        targetRatio_ = 1.0;
        period_ = 0.0;
        voiced_ = false;
        splicing_ = false;
        crossfadePos_ = 0;
        crossfadeLength_ = 0;
        spliceCount_ = 0;
        recentreCount_ = 0;
        guardTrips_ = 0;
    }

    // Constant after prepare().
    int latencySamples() const noexcept { return latency_; }

    // Takes effect from the next processed sample. periodSamples outside
    // [fs/1200, fs/55] (including <= 0 and NaN) means unvoiced, which forces ratio 1.
    // ratio > 1 raises the pitch; it is clamped to +/- 4 semitones.
    void setTarget (double periodSamples, double ratio) noexcept
    {
        voiced_ = periodSamples >= minPeriod_ && periodSamples <= maxPeriod_;
        if (! voiced_)
        {
            period_ = 0.0;
            targetRatio_ = 1.0;
            return;
        }
        period_ = periodSamples;
        targetRatio_ = std::isfinite (ratio) ? std::min (std::max (ratio, kMinRatio), kMaxRatio) : 1.0;
    }

    // in and out may be the same buffer.
    void process (const float* in, float* out, int numSamples) noexcept
    {
        if (ring_.empty())
        {
            for (int i = 0; i < numSamples; ++i)
                out[i] = 0.0f;
            return;
        }

        for (int i = 0; i < numSamples; ++i)
        {
            // Read in[i] before touching out[i] so in == out is safe.
            newest_ = head_++;
            ring_[newest_ & mask_] = in[i];

            stepRatio();
            decideSplice();

            if (splicing_)
            {
                const double g = 0.5 * (1.0 - std::cos (kPi * (double) crossfadePos_ / (double) crossfadeLength_));
                const double oldValue = (double) readAt (d_);
                const double newValue = (double) readAt (dIncoming_);
                out[i] = (float) ((1.0 - g) * oldValue + g * newValue);
            }
            else
            {
                out[i] = readAt (d_);
            }

            advance();
        }
    }

    // ---- Diagnostics: for tests and tooling only; not used by the DSP ----------------

    // The half-width of the interpolator: d may never go below this.
    static constexpr int interpolatorReach() noexcept { return kReach; }
    // Delay (samples behind the newest written sample) of the read head.
    double delaySamples() const noexcept { return d_; }
    // Delay of the head being crossfaded in; equals delaySamples() when not splicing.
    double incomingDelaySamples() const noexcept { return splicing_ ? dIncoming_ : d_; }
    bool isSplicing() const noexcept { return splicing_; }
    // Period splices started since reset() (excludes unvoiced recentres).
    std::uint32_t spliceCount() const noexcept { return spliceCount_; }
    std::uint32_t recentreCount() const noexcept { return recentreCount_; }
    // Smoothed ratio currently applied.
    double currentRatio() const noexcept { return ratio_; }
    int ringSize() const noexcept { return ringSize_; }
    // Times a protective clamp fired (a delay forced back into the ring, or a
    // correlation search skipped because it would have left the ring). The design
    // bounds mean this stays zero for any plausible control sequence.
    std::uint32_t guardTrips() const noexcept { return guardTrips_; }

private:
    static constexpr double kPi = 3.14159265358979323846;
    static constexpr int kTaps = 16;
    static constexpr int kReach = kTaps / 2;  // newest tap sits 8 samples after the read point
    static constexpr int kPhases = 256;
    static constexpr double kKaiserBeta = 8.0;

    static constexpr double kMinRatio = 0.79370052598409973738;  // 2^(-4/12)
    static constexpr double kMaxRatio = 1.25992104989487316476;  // 2^(+4/12)
    static constexpr double kRatioTimeConstantSeconds = 0.002;
    // The ratio snaps to its target once this close (0.017 cent). The spec says 1e-7, but
    // with a 2 ms time constant that takes ~29.5 ms from the largest ratio, and the 4 ms
    // recentre then misses the 30 ms "back to exact identity" property (measured 31.8 to
    // 33.5 ms at 200 and 400 cents). At 1e-5 the worst case is ~24.5 ms.
    static constexpr double kRatioSnap = 1.0e-5;
    static constexpr double kMaxCrossfadeSeconds = 0.006;
    static constexpr double kRecentreSeconds = 0.004;

    // ---- Interpolator ----------------------------------------------------------------

    static double besselI0 (double x) noexcept
    {
        double sum = 1.0, term = 1.0;
        const double q = 0.25 * x * x;
        for (int k = 1; k < 80; ++k)
        {
            term *= q / ((double) k * (double) k);
            sum += term;
            if (term < 1.0e-18 * sum)
                break;
        }
        return sum;
    }

    // Row p, tap j holds h(t) with t = (j - 7) - p / 256: the weight of the sample j - 7
    // positions after the integer part of the read point, when the read point sits
    // p / 256 of the way from that integer to the next one.
    void buildKernelTable()
    {
        table_.assign ((std::size_t) (kPhases + 1) * kTaps, 0.0f);
        const double norm = 1.0 / besselI0 (kKaiserBeta);

        for (int p = 1; p < kPhases; ++p)
        {
            double row[kTaps];
            double sum = 0.0;
            for (int j = 0; j < kTaps; ++j)
            {
                const double t = (double) (j - (kReach - 1)) - (double) p / (double) kPhases;
                const double u = t / (double) kReach;
                const double window = std::fabs (u) < 1.0 ? besselI0 (kKaiserBeta * std::sqrt (1.0 - u * u)) * norm : 0.0;
                const double sinc = std::fabs (t) < 1.0e-12 ? 1.0 : std::sin (kPi * t) / (kPi * t);
                row[j] = sinc * window;
                sum += row[j];
            }
            for (int j = 0; j < kTaps; ++j)
                table_[(std::size_t) p * kTaps + (std::size_t) j] = (float) (row[j] / sum);
        }

        // Fraction 0 and 1 are exact unit impulses, so an integer delay is bit-exact.
        table_[(std::size_t) 0 * kTaps + (kReach - 1)] = 1.0f;
        table_[(std::size_t) kPhases * kTaps + kReach] = 1.0f;
    }

    // The ring interpolated `delay` samples behind the newest written sample.
    // Requires kReach <= delay <= maxReadDelay_ (advance() and the splice setup clamp).
    float readAt (double delay) const noexcept
    {
        const double whole = std::floor (delay);
        const double frac = delay - whole;
        std::uint32_t base = newest_ - (std::uint32_t) whole;

        if (frac == 0.0)
            return ring_[base & mask_];

        // The read point lies (1 - frac) after the sample one step older than `whole`.
        --base;
        const double phasePos = (1.0 - frac) * (double) kPhases;
        int p = (int) phasePos;
        float a = (float) (phasePos - (double) p);
        if (p >= kPhases)  // (1 - frac) rounded up to 1
        {
            p = kPhases - 1;
            a = 1.0f;
        }

        const float* row0 = &table_[(std::size_t) p * kTaps];
        const float* row1 = row0 + kTaps;
        const std::uint32_t first = base - (std::uint32_t) (kReach - 1);

        float acc = 0.0f;
        for (int j = 0; j < kTaps; ++j)
            acc += ring_[(first + (std::uint32_t) j) & mask_] * (row0[j] + a * (row1[j] - row0[j]));
        return acc;
    }

    // ---- Per-sample control ----------------------------------------------------------

    void stepRatio() noexcept
    {
        const double error = targetRatio_ - ratio_;
        if (error == 0.0)
            return;
        if (std::fabs (error) < kRatioSnap)
            ratio_ = targetRatio_;
        else
            ratio_ += error * ratioCoef_;
    }

    void decideSplice() noexcept
    {
        if (splicing_)
            return;

        const double centre = (double) latency_;
        if (voiced_)
        {
            if (d_ < centre)
                beginPeriodSplice (true);
            else if (d_ > centre + 1.5 * period_)
                beginPeriodSplice (false);
        }
        else if (ratio_ == 1.0 && d_ != centre)
        {
            beginRecentre();
        }
    }

    void advance() noexcept
    {
        const double step = 1.0 - ratio_;
        d_ += step;
        if (splicing_)
        {
            dIncoming_ += step;
            if (++crossfadePos_ >= crossfadeLength_)
            {
                d_ = dIncoming_;
                splicing_ = false;
            }
        }
        d_ = guarded (d_);
        if (splicing_)
            dIncoming_ = guarded (dIncoming_);
    }

    // Keeps a delay where readAt() can service it. Never fires for any control sequence
    // inside the design bounds; the counter lets tests prove that.
    double guarded (double delay) noexcept
    {
        if (delay < (double) kReach)
        {
            ++guardTrips_;
            return (double) kReach;
        }
        if (delay > maxReadDelay_)
        {
            ++guardTrips_;
            return maxReadDelay_;
        }
        return delay;
    }

    // ---- Splices ---------------------------------------------------------------------

    // One period back (older audio, new head at d + P*) when d fell below D, or one
    // period forward (newer audio, new head at d - P*) when it passed D + 1.5 P.
    void beginPeriodSplice (bool back) noexcept
    {
        const double jump = refinedPeriod (period_, back);
        dIncoming_ = guarded (back ? d_ + jump : d_ - jump);
        crossfadeLength_ = std::min (std::max ((int) std::lround (period_), minXfade_), maxXfade_);
        crossfadePos_ = 0;
        splicing_ = true;
        ++spliceCount_;
    }

    // Unvoiced and settled: crossfade to a head at exactly d = D.
    void beginRecentre() noexcept
    {
        dIncoming_ = (double) latency_;
        crossfadeLength_ = recentreLength_;
        crossfadePos_ = 0;
        splicing_ = true;
        ++recentreCount_;
    }

    float sampleAtDelay (int delay) const noexcept
    {
        return ring_[(newest_ - (std::uint32_t) delay) & mask_];
    }

    // Normalised cross-correlation of the N input samples just behind the read point with
    // the N samples `lag` away (older when `older`, newer otherwise), summing every
    // `stride`-th sample. `energyA` is the (stride-matched) energy of the first segment.
    double normalisedCorrelation (int de, int segment, int lag, int stride, bool older, double energyA) const noexcept
    {
        double ab = 0.0, bb = 0.0;
        for (int j = 0; j < segment; j += stride)
        {
            const double a = (double) sampleAtDelay (de + j);
            const double b = (double) sampleAtDelay (older ? de + j + lag : de + j - lag);
            ab += a * b;
            bb += b * b;
        }
        return ab / std::sqrt (energyA * bb + 1.0e-30);
    }

    double segmentEnergy (int de, int segment, int stride) const noexcept
    {
        double aa = 0.0;
        for (int j = 0; j < segment; j += stride)
        {
            const double a = (double) sampleAtDelay (de + j);
            aa += a * a;
        }
        return aa;
    }

    // The tracker's period is several milliseconds stale, so measure the jump against
    // the audio: the best normalised cross-correlation lag in [0.9 P, 1.1 P], refined by a
    // parabolic fit. Falls back to P when the audio is not periodic enough (< 0.5).
    double refinedPeriod (double period, bool older) noexcept
    {
        const int segment = std::min (std::max ((int) std::lround (period), minSegment_), maxSegment_);
        const int lagLow = std::max (2, (int) std::ceil (0.9 * period));
        const int lagHigh = std::max (lagLow, (int) std::floor (1.1 * period));
        const int de = (int) std::ceil (d_);  // delay of the newest sample at or before the read point

        // Every delay the search touches must be inside the ring and not in the future.
        const int reachLag = lagHigh + searchStride_ + 1;  // coarse winner + refinement + parabola
        const int deepest = older ? de + segment + reachLag : de + segment + 1;
        const int shallowest = older ? de : de - reachLag;
        if (shallowest < 0 || deepest >= ringSize_)
        {
            ++guardTrips_;
            return period;
        }

        int best = lagLow;
        if (searchStride_ > 1)
        {
            const double energy = segmentEnergy (de, segment, searchStride_);
            double bestValue = -2.0;
            for (int lag = lagLow; lag <= lagHigh; lag += searchStride_)
            {
                const double c = normalisedCorrelation (de, segment, lag, searchStride_, older, energy);
                if (c > bestValue)
                {
                    bestValue = c;
                    best = lag;
                }
            }
            // Refine around the coarse winner at stride 1.
            const double fullEnergy = segmentEnergy (de, segment, 1);
            int refined = std::max (2, best - searchStride_);
            const int refinedEnd = best + searchStride_;
            bestValue = -2.0;
            for (int lag = refined; lag <= refinedEnd; ++lag)
            {
                const double c = normalisedCorrelation (de, segment, lag, 1, older, fullEnergy);
                if (c > bestValue)
                {
                    bestValue = c;
                    refined = lag;
                }
            }
            best = refined;
        }
        else
        {
            const double energy = segmentEnergy (de, segment, 1);
            double bestValue = -2.0;
            for (int lag = lagLow; lag <= lagHigh; ++lag)
            {
                const double c = normalisedCorrelation (de, segment, lag, 1, older, energy);
                if (c > bestValue)
                {
                    bestValue = c;
                    best = lag;
                }
            }
        }

        const double energy = segmentEnergy (de, segment, 1);
        const double before = normalisedCorrelation (de, segment, best - 1, 1, older, energy);
        const double centre = normalisedCorrelation (de, segment, best, 1, older, energy);
        const double after = normalisedCorrelation (de, segment, best + 1, 1, older, energy);
        if (! (centre >= 0.5))  // also rejects NaN
            return period;

        const double curvature = before - 2.0 * centre + after;
        double offset = 0.0;
        if (curvature < 0.0)
            offset = std::min (std::max (0.5 * (before - after) / curvature, -1.0), 1.0);
        return (double) best + offset;
    }

    // ---- State -----------------------------------------------------------------------

    double fs_ = 48000.0;
    int latency_ = 0;
    double minPeriod_ = 1.0;  // empty range until prepare(): nothing is voiced
    double maxPeriod_ = 0.0;

    std::vector<float> ring_;
    std::vector<float> table_;
    std::uint32_t mask_ = 0;
    int ringSize_ = 0;
    double maxReadDelay_ = 0.0;
    std::uint32_t head_ = 0;    // count of samples written (wraps; ring size divides 2^32)
    std::uint32_t newest_ = 0;  // index of the newest written sample

    double ratioCoef_ = 0.0;
    int recentreLength_ = 0;
    int minXfade_ = 0;
    int maxXfade_ = 0;
    int minSegment_ = 0;
    int maxSegment_ = 0;
    int searchStride_ = 1;

    double d_ = 0.0;           // read head delay
    double dIncoming_ = 0.0;   // second head, valid while splicing_
    double ratio_ = 1.0;       // smoothed
    double targetRatio_ = 1.0;
    double period_ = 0.0;
    bool voiced_ = false;
    bool splicing_ = false;
    int crossfadePos_ = 0;
    int crossfadeLength_ = 0;

    std::uint32_t spliceCount_ = 0;
    std::uint32_t recentreCount_ = 0;
    std::uint32_t guardTrips_ = 0;
};

}  // namespace mosh::moshfx::retune
