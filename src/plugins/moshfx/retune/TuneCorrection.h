#pragma once

#include <algorithm>
#include <cmath>

// The correction DECISION for Mosh AutoTune (docs/AUTOTUNE-SCOPE-2026-10-01.md §6).
// Ported from the owner's Moshpit M009 TuneCorrection: scale snap with range and
// amount, hop-size-independent retune smoothing, hold across short unvoiced dips,
// and the anti-warble target hysteresis. Added here: the glide control (how much
// of a new note's correction lands at once) and a reset after a real gap, so a new
// phrase never starts with the previous phrase's correction. Pure arithmetic.

namespace mosh::moshfx::retune
{
class TuneCorrection
{
public:
    enum class Scale
    {
        chromatic,
        major,
        minor
    };

    struct Params
    {
        int rootSemitone = 0; // C
        Scale scale = Scale::chromatic;
        double retuneMs = 80.0; // <= 1 ms is hard tune
        double amount = 1.0;
        double maxCorrectionCents = 100.0;
        double glide = 1.0; // 0 snaps onto each new note, 1 eases in at the retune speed
        double hysteresisCents = 60.0;
    };

    struct Out
    {
        double ratio = 1.0;
        double correctionCents = 0.0;
        int targetNote = -1; // MIDI note, -1 before the first voiced hop
        bool active = false;
    };

    void prepare (double hopSecondsIn)
    {
        hopSeconds = std::max (1.0e-6, hopSecondsIn);
        gapHops = std::max (1, (int) std::ceil (kGapSeconds / hopSeconds));
        reset();
    }

    void reset()
    {
        smoothedCents = 0.0;
        heldNote = -1;
        heldRatio = 1.0;
        unvoicedRun = gapHops; // start as "after a gap"
    }

    [[nodiscard]] Out update (double f0Hz, bool voiced, const Params& params)
    {
        Out out;
        if (! voiced || f0Hz <= 0.0)
        {
            // Hold: a short dip inside a note resumes where it left off.
            unvoicedRun = std::min (unvoicedRun + 1, gapHops);
            out.ratio = heldRatio;
            out.correctionCents = smoothedCents;
            out.targetNote = heldNote;
            out.active = false;
            return out;
        }

        const bool afterGap = unvoicedRun >= gapHops;
        unvoicedRun = 0;
        if (afterGap)
        {
            heldNote = -1;
            smoothedCents = 0.0;
        }

        const double retuneSeconds = std::max (0.001, params.retuneMs * 0.001);
        const double response = std::clamp (1.0 - std::exp (-hopSeconds / retuneSeconds), 0.0, 1.0);
        const double amount = std::clamp (params.amount, 0.0, 1.0);
        const double cap = std::abs (params.maxCorrectionCents);
        const double glide = std::clamp (params.glide, 0.0, 1.0);

        const double midiCents = 6900.0 + 1200.0 * std::log2 (f0Hz / 440.0);
        const int nearest = nearestAllowedNote (midiCents, params.rootSemitone, params.scale);
        bool noteChanged = false;
        if (heldNote < 0 || ! scaleAllows (heldNote, params.rootSemitone, params.scale))
        {
            heldNote = nearest;
            noteChanged = true;
        }
        else if (nearest != heldNote)
        {
            // Commit only past the midpoint by half the deadband — the anti-warble
            // hysteresis.
            const double midpoint = (heldNote * 100.0 + nearest * 100.0) / 2.0;
            const double beyond = nearest > heldNote ? midiCents - midpoint : midpoint - midiCents;
            if (beyond >= params.hysteresisCents / 2.0)
            {
                heldNote = nearest;
                noteChanged = true;
            }
        }

        const double requested = std::clamp (heldNote * 100.0 - midiCents, -cap, cap) * amount;
        if (noteChanged)
            smoothedCents += (requested - smoothedCents) * (1.0 - glide);
        smoothedCents += (requested - smoothedCents) * response;
        out.correctionCents = smoothedCents;
        out.ratio = std::pow (2.0, smoothedCents / 1200.0);
        out.targetNote = heldNote;
        out.active = true;
        heldRatio = out.ratio;
        return out;
    }

    [[nodiscard]] static bool scaleAllows (int note, int rootSemitone, Scale scale) noexcept
    {
        if (scale == Scale::chromatic)
            return true;
        static constexpr int major[7] = { 0, 2, 4, 5, 7, 9, 11 };
        static constexpr int minor[7] = { 0, 2, 3, 5, 7, 8, 10 };
        const int pitchClass = ((note - rootSemitone) % 12 + 12) % 12;
        const int* intervals = scale == Scale::major ? major : minor;
        for (int i = 0; i < 7; ++i)
            if (intervals[i] == pitchClass)
                return true;
        return false;
    }

    [[nodiscard]] static int nearestAllowedNote (double midiCents, int rootSemitone, Scale scale) noexcept
    {
        const int centre = (int) std::llround (midiCents / 100.0);
        int bestNote = centre;
        double bestDistance = 1.0e18;
        for (int note = centre - 24; note <= centre + 24; ++note)
        {
            if (! scaleAllows (note, rootSemitone, scale))
                continue;
            const double distance = std::abs (note * 100.0 - midiCents);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                bestNote = note;
            }
        }
        return bestNote;
    }

    [[nodiscard]] static double noteToHz (int note) noexcept
    {
        return 440.0 * std::pow (2.0, (note - 69) / 12.0);
    }

private:
    static constexpr double kGapSeconds = 0.060;

    double hopSeconds = 0.005;
    int gapHops = 12;
    int unvoicedRun = 12;
    double smoothedCents = 0.0;
    int heldNote = -1;
    double heldRatio = 1.0;
};
}
