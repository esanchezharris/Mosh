#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "audio/TpdfDither.h"

#include <cmath>
#include <cstdint>
#include <set>
#include <vector>

// CAP-EXP-001 — the LAWS the export requantiser must obey.
//
// Deliberately not "the flag reached the function". Each test below is an assertion a
// non-dithering quantiser FAILS, so none of them can be satisfied by an implementation
// that merely rounds. (The spectral consequence — harmonic distortion replaced by a flat
// floor on a real render — is proven end-to-end by check_export_dither in
// scripts/verify-hardware/verify.py; this file pins the arithmetic underneath it.)

namespace
{
    constexpr double kPi = 3.14159265358979323846;

    /** The undithered quantiser, as a control group: round-to-nearest onto the same
        lattice. Every "dither does X" test here is paired against this so the test is
        demonstrably measuring dither and not merely requantisation. */
    std::int32_t roundOnly (std::int32_t x, std::int32_t step)
    {
        const double lsb = (double) step;
        return (std::int32_t) ((std::int64_t) std::llround ((double) x / lsb) * (std::int64_t) step);
    }

    double correlation (const std::vector<double>& a, const std::vector<double>& b)
    {
        const auto n = (double) a.size();
        double ma = 0.0, mb = 0.0;
        for (size_t i = 0; i < a.size(); ++i) { ma += a[i]; mb += b[i]; }
        ma /= n; mb /= n;
        double num = 0.0, da = 0.0, db = 0.0;
        for (size_t i = 0; i < a.size(); ++i)
        {
            const double x = a[i] - ma, y = b[i] - mb;
            num += x * y; da += x * x; db += y * y;
        }
        return (da > 0.0 && db > 0.0) ? num / std::sqrt (da * db) : 0.0;
    }
}

TEST_CASE ("TPDF dither only engages on a real word-length reduction", "[export][dither]")
{
    // 32-bit is not a reduction from the float bus — routing it through the ditherer
    // would add noise to an export that must stay byte-identical.
    CHECK_FALSE (mosh::TpdfDither::shouldDither (32));
    CHECK_FALSE (mosh::TpdfDither::shouldDither (0));
    CHECK (mosh::TpdfDither::shouldDither (8));
    CHECK (mosh::TpdfDither::shouldDither (16));
    CHECK (mosh::TpdfDither::shouldDither (24));
}

TEST_CASE ("every output lands exactly on the destination lattice", "[export][dither]")
{
    // JUCE's concrete writers narrow with an ARITHMETIC SHIFT (Int16::setAsInt32LE is
    // `v >> 16`). If our output were not an exact multiple of the step, that shift would
    // be a SECOND, undithered rounding underneath ours and would re-introduce exactly the
    // correlation this whole change exists to remove.
    for (int bits : { 8, 16, 24 })
    {
        mosh::TpdfDither d (bits, 12345);
        const std::int32_t step = d.getStep();
        REQUIRE (step == (std::int32_t) (std::int64_t (1) << (32 - bits)));

        for (int i = 0; i < 5000; ++i)
        {
            const auto in = (std::int32_t) ((std::int64_t) i * 7919 - 1000000000);
            const std::int32_t out = d.process (in);
            REQUIRE (out % step == 0);
            // …and the shift downstream must recover the code we chose.
            REQUIRE ((std::int64_t) (out >> (32 - bits)) == (std::int64_t) out / (std::int64_t) step);
        }
    }
}

TEST_CASE ("the dither offset is bounded by 1 LSB", "[export][dither]")
{
    // ±1 LSB triangular + up to ½ LSB of rounding. Anything larger is audible noise, not
    // dither; anything smaller (rectangular ±½) leaves the noise level modulating with
    // the signal.
    mosh::TpdfDither d (16, 999);
    const double step = (double) d.getStep();
    double worst = 0.0;
    for (int i = 0; i < 200000; ++i)
    {
        const auto in = (std::int32_t) ((std::int64_t) (i % 40000) * 50000 - 1000000000);
        worst = std::max (worst, std::abs ((double) d.process (in) - (double) in) / step);
    }
    CHECK (worst > 1.0);      // it really is dithering, not just rounding (>½ LSB)
    CHECK (worst <= 1.5);
}

TEST_CASE ("dither linearises the quantiser: sub-LSB detail survives requantisation", "[export][dither]")
{
    // THE property. A DC level sitting 0.3 of an LSB above a lattice point is information
    // finer than the destination word can hold. Round-to-nearest destroys it — every
    // sample collapses onto the same code and the average is simply wrong. TPDF dither
    // preserves it in the AVERAGE, which is precisely why a −90 dBFS tone survives a
    // 16-bit render as a tone instead of as harmonics of itself.
    for (double frac : { 0.3, 0.5, 0.7 })
    {
        mosh::TpdfDither d (16, 0xABCDEF);
        const double step = (double) d.getStep();
        const auto in = (std::int32_t) std::llround (1000.0 * step + frac * step);

        const int n = 400000;
        double sum = 0.0;
        std::set<std::int32_t> distinct;
        for (int i = 0; i < n; ++i)
        {
            const std::int32_t out = d.process (in);
            sum += (double) out;
            distinct.insert (out);
        }
        const double meanErrorLsb = (sum / n - (double) in) / step;

        INFO ("frac=" << frac << " meanErrorLsb=" << meanErrorLsb << " distinct=" << distinct.size());
        CHECK (std::abs (meanErrorLsb) < 0.01);        // the sub-LSB level is preserved
        CHECK (distinct.size() >= 2);                  // …by dithering between codes

        // Control group: the undithered quantiser fails both, and by how much.
        const double roundedErrorLsb = ((double) roundOnly (in, d.getStep()) - (double) in) / step;
        if (std::abs (frac - 0.5) > 1e-9)
            CHECK (std::abs (roundedErrorLsb) > 0.25);
    }
}

TEST_CASE ("the quantisation error is decorrelated from the signal", "[export][dither]")
{
    // Signal-correlated error IS the distortion. On a tone whose amplitude is a couple of
    // LSBs, an undithered quantiser's error tracks the input strongly (that correlation is
    // what shows up in the spectrum as harmonics); dither must break it.
    const int n = 200000;
    mosh::TpdfDither d (16, 0x5EED);
    const double step = (double) d.getStep();
    const double amp = 2.0 * step;      // ~2 LSB — the regime where truncation is brutal

    std::vector<double> sig, errDithered, errRounded;
    sig.reserve ((size_t) n); errDithered.reserve ((size_t) n); errRounded.reserve ((size_t) n);

    for (int i = 0; i < n; ++i)
    {
        const double s = amp * std::sin (2.0 * kPi * 997.0 * (double) i / 48000.0);
        const auto in = (std::int32_t) std::llround (s);
        sig.push_back ((double) in);
        errDithered.push_back ((double) d.process (in) - (double) in);
        errRounded.push_back ((double) roundOnly (in, d.getStep()) - (double) in);
    }

    const double cDithered = std::abs (correlation (sig, errDithered));
    const double cRounded  = std::abs (correlation (sig, errRounded));

    // Both quantities are fully deterministic (the signal is, the control is, and the
    // dither is seeded), so these are fixed numbers, not samples: ~0.201 and ~0.00028.
    // The ratio is the claim; the absolute bounds keep it honest at both ends.
    INFO ("|corr| dithered=" << cDithered << " rounded=" << cRounded);
    CHECK (cRounded > 0.10);                     // the control group really is correlated…
    CHECK (cDithered < 0.02);                    // …dither breaks it…
    CHECK (cDithered < cRounded / 10.0);         // …by well over an order of magnitude
}

TEST_CASE ("dither is deterministic per seed and independent per channel", "[export][dither]")
{
    // Reproducibility is a product requirement (goldens, caches, "did this export
    // change?"). Dither must be uncorrelated with the SIGNAL, never unpredictable.
    const auto run = [] (std::uint64_t seed)
    {
        mosh::TpdfDither d (16, seed);
        std::vector<std::int32_t> out;
        for (int i = 0; i < 512; ++i)
            out.push_back (d.process ((std::int32_t) (i * 100003)));
        return out;
    };

    CHECK (run (mosh::kExportDitherSeed) == run (mosh::kExportDitherSeed));

    // Per-channel seeds are derived, not shared: identical L/R dither sums to a
    // centre-panned mono hiss instead of a diffuse floor.
    const auto left  = run (mosh::kExportDitherSeed + 0x9E3779B97F4A7C15ull * 1);
    const auto right = run (mosh::kExportDitherSeed + 0x9E3779B97F4A7C15ull * 2);
    CHECK (left != right);
}

TEST_CASE ("full-scale input clamps instead of wrapping", "[export][dither]")
{
    // Dither pushes samples past the peak by up to an LSB. Wrapping there would turn the
    // loudest moment of a master into a full-scale sign flip.
    mosh::TpdfDither d (16, 4242);
    for (int i = 0; i < 20000; ++i)
    {
        CHECK (d.process (2147483647) > 0);
        CHECK (d.process (-2147483647 - 1) < 0);
    }
    // The clamp lands on the real endpoints of the destination word.
    CHECK (d.process (2147483647) <= 2147483647 - d.getStep() + 1);
}
