#pragma once

#include <cstdint>
#include <cmath>

namespace mosh
{

/**
    CAP-EXP-001 — deterministic TPDF (triangular probability density function) dither
    for the final requantisation of an export.

    WHY THIS EXISTS. Mosh's mix bus is 32-bit float. Writing a 16-bit file has to throw
    away word length, and *how* you throw it away decides whether the discarded part
    becomes distortion or becomes noise. Plain requantisation (round or truncate) makes
    an error that is a deterministic function of the input, so on a quiet, tonal signal
    it lands as harmonics of the signal — a fizzy, pitched ghost that follows the music
    and is far more audible than its level suggests. Adding a triangular-PDF random
    offset of ±1 LSB before rounding makes the error statistically independent of the
    input: the same energy is still there, but as a flat, steady, uncorrelated noise
    floor with no relationship to what is playing. That trade — a slightly higher floor
    for no signal-correlated distortion — is why every mastering chain dithers.

    ±1 LSB TRIANGULAR, specifically. Two independent uniforms subtracted give a
    triangular distribution over (−1, +1) LSB, which is the smallest dither that fully
    decorrelates BOTH the error's mean and its variance from the signal (a rectangular
    ±½ LSB dither decorrelates the mean but leaves the noise *level* modulating with the
    signal — audible as breathing on a fade). Noise shaping is deliberately NOT here: it
    is a separate, taste-laden choice about *where* in the spectrum to put the noise, and
    it does not belong in the same change as the decorrelation itself.

    LEFT-JUSTIFIED INT32 IS THE CURRENCY. juce::AudioFormatWriter::write() hands every
    fixed-point writer its samples as int32 spanning the full −2^31..2^31−1 range
    regardless of the file's real depth, and the concrete writer then narrows with an
    ARITHMETIC SHIFT (AudioData::Int16::setAsInt32LE is `(uint16) (v >> 16)`). So this
    class works in those units: it snaps each sample onto the target word's lattice
    (an exact multiple of `step`), and the shift downstream recovers exactly the code
    chosen here — no second, un-dithered rounding hiding behind ours.

    DETERMINISTIC BY DESIGN. The generator is a seeded xorshift64*, not rand(): the same
    session must export to the same bytes twice (goldens, caches, "did this change?"),
    and dither is only required to be uncorrelated with the SIGNAL, never unpredictable.

    Engine-free and header-only on purpose so tests/test_export_dither.cpp can exercise
    it in MoshTests, which links no audio modules at all.
*/
class TpdfDither
{
public:
    /** @param targetBits  destination word length, 2..31. Callers must gate on
                           shouldDither() — 32-bit is not a reduction and must not be
                           routed through here at all.
        @param seed        any non-zero value; 0 is replaced by a fixed constant. */
    TpdfDither (int targetBits, std::uint64_t seed) noexcept
        : bits (targetBits < 2 ? 2 : (targetBits > 31 ? 31 : targetBits)),
          state (seed != 0 ? seed : 0x9E3779B97F4A7C15ull)
    {
        step    = (std::int32_t) (std::int64_t (1) << (32 - bits));
        maxCode = (std::int64_t (1) << (bits - 1)) - 1;
        minCode = -(std::int64_t (1) << (bits - 1));
    }

    /** True when writing `bits` is a real word-length reduction from the float bus.
        32-bit (and anything wider) is not, so those exports stay byte-for-byte what
        they were before dither existed. */
    static bool shouldDither (int bits) noexcept    { return bits >= 2 && bits < 32; }

    /** Requantises one left-justified 32-bit sample onto the target lattice.
        The result is always an exact multiple of getStep(). */
    std::int32_t process (std::int32_t leftJustified) noexcept
    {
        const double lsb = (double) step;
        // u1 - u2 over two independent uniforms == triangular on (-1, +1) LSB.
        const double noise = (uniform() - uniform()) * lsb;
        // Every quantity here is well inside double's exact-integer range (|x| <= 2^31,
        // lsb >= 2), so the divide and the round carry no representation error of their own.
        std::int64_t code = (std::int64_t) std::llround (((double) leftJustified + noise) / lsb);

        if (code > maxCode) code = maxCode;      // full-scale clamp: dither must never wrap
        if (code < minCode) code = minCode;

        return (std::int32_t) (code * (std::int64_t) step);
    }

    int          getTargetBits() const noexcept  { return bits; }
    /** One target-word LSB expressed in left-justified int32 units. */
    std::int32_t getStep()       const noexcept  { return step; }

private:
    /** xorshift64* — small, fast, and (unlike rand()) reproducible and thread-private. */
    double uniform() noexcept
    {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        const std::uint64_t x = state * 0x2545F4914F6CDD1Dull;
        return (double) (x >> 11) * (1.0 / 9007199254740992.0);   // 53 bits -> [0, 1)
    }

    int           bits;
    std::uint64_t state;
    std::int32_t  step    = 1;
    std::int64_t  maxCode = 0;
    std::int64_t  minCode = 0;
};

/** Base seed for export dither. Per-channel streams offset from it (see
    DitheringAudioFormat) so left and right never share a noise sequence — correlated
    L/R dither collapses to a centre-panned mono hiss. */
inline constexpr std::uint64_t kExportDitherSeed = 0x4D4F53482D444954ull;   // "MOSH-DIT"

} // namespace mosh
