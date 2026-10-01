#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "RetuneFixtures.h"
#include "audio/RealtimeAudioGuard.h"
#include "plugins/moshfx/MoshFxDsp.h"
#include "plugins/moshfx/retune/PitchTracker.h"
#include "plugins/moshfx/retune/RetuneCore.h"
#include "plugins/moshfx/retune/TuneCorrection.h"

#include <cmath>
#include <cstring>
#include <vector>

// Regression tests for the native AutoTune engine
// (docs/AUTOTUNE-SCOPE-2026-10-01.md). They prove the wiring and the stated
// properties on synthetic fixtures. They are NOT evidence of how it sounds on a
// real voice: Moshpit M009 passed a suite like this and was rejected by ear.

namespace
{
    using namespace mosh::moshfx::retune;
    namespace fx = mosh::tests::retune;

    struct TrackedHop
    {
        double f0Hz = 0.0;
        bool voiced = false;
    };

    std::vector<TrackedHop> streamFixture (const fx::VocalFixture& fixture, const std::vector<int>& blocks)
    {
        PitchTracker tracker;
        REQUIRE (tracker.prepare (fixture.sampleRate));
        std::vector<TrackedHop> hops;
        std::size_t at = 0, blockIndex = 0;
        while (at < fixture.samples.size())
        {
            const auto count = std::min ((std::size_t) blocks[blockIndex++ % blocks.size()], fixture.samples.size() - at);
            tracker.pushBlock (fixture.samples.data() + at, (int) count,
                               [&hops] (const PitchTracker::Hop& hop) { hops.push_back ({ hop.f0Hz, hop.voiced }); });
            at += count;
        }
        return hops;
    }

    // The time the evidence for hop `index` is centred on: the newest span of samples
    // and the same span one period earlier.
    double hopCentreSeconds (const fx::VocalFixture& fixture, std::size_t index, double f0Hz)
    {
        const auto s = PitchTracker::settingsFor (fixture.sampleRate);
        const double endSample = (double) s.windowFrames + (double) index * s.hopFrames;
        const double tau = f0Hz > 0.0 ? fixture.sampleRate / f0Hz : 0.0;
        return (endSample - s.span / 2.0 - tau / 2.0) / fixture.sampleRate;
    }

    // Ground-truth cents error per voiced hop, skipping a warm-up.
    std::vector<double> voicedErrors (const fx::VocalFixture& fixture, const std::vector<TrackedHop>& hops, int skipHops)
    {
        std::vector<double> errors;
        for (std::size_t i = (std::size_t) skipHops; i < hops.size(); ++i)
        {
            if (! hops[i].voiced || hops[i].f0Hz <= 0.0)
                continue;
            const double truth = fixture.f0At (hopCentreSeconds (fixture, i, hops[i].f0Hz));
            if (truth > 0.0)
                errors.push_back (fx::hzToCents (hops[i].f0Hz, truth));
        }
        return errors;
    }

    double hopSeconds48k()
    {
        const auto s = PitchTracker::settingsFor (48000.0);
        return (double) s.hopFrames / 48000.0;
    }

    double midiCentsToHz (double midiCents)
    {
        return 440.0 * std::pow (2.0, (midiCents - 6900.0) / 1200.0);
    }

    RetuneSettings hardChromatic()
    {
        RetuneSettings s;
        s.scale = 0;
        s.retuneMs = RetuneCore::kHardRetuneMs;
        s.amount = 1.0f;
        s.maxCorrectionCents = 100.0f;
        return s;
    }

    // Runs samples through a fresh core in fixed-size chunks.
    std::vector<float> render (const std::vector<float>& input, double sampleRate, const RetuneSettings& settings,
                               int chunk, std::vector<RetuneReadout>* readouts = nullptr)
    {
        RetuneCore core;
        REQUIRE (core.prepare (sampleRate));
        std::vector<float> out (input);
        for (std::size_t at = 0; at < out.size(); at += (std::size_t) chunk)
        {
            const int count = (int) std::min ((std::size_t) chunk, out.size() - at);
            const auto readout = core.process (out.data() + at, count, settings);
            if (readouts != nullptr)
                readouts->push_back (readout);
        }
        return out;
    }

    std::vector<float> lcgNoise (int samples, float gain)
    {
        std::vector<float> out ((std::size_t) samples);
        fx::detail::Lcg random (0x12345678u);
        for (auto& s : out)
            s = gain * (float) random.next();
        return out;
    }

    // Counts samples where out[i + latency] differs from in[i].
    int delayMismatches (const std::vector<float>& in, const std::vector<float>& out, int latency)
    {
        int mismatches = 0;
        for (std::size_t i = 0; i + (std::size_t) latency < in.size(); ++i)
            if (out[i + (std::size_t) latency] != in[i])
                ++mismatches;
        for (int i = 0; i < latency; ++i)
            if (out[(std::size_t) i] != 0.0f)
                ++mismatches;
        return mismatches;
    }
}

// ----------------------------------------------------------------------------
// Pitch tracker

TEST_CASE ("Retune tracker follows a steady detuned vowel within cents", "[retune][tracker]")
{
    const auto steady = fx::steadyDetunedFixture();
    const auto hops = streamFixture (steady, { 512 });
    REQUIRE (hops.size() > 20);
    const auto errors = voicedErrors (steady, hops, 6);
    REQUIRE (errors.size() > 10);
    const auto stats = fx::centsSeriesStats (errors);
    INFO ("median " << stats.median << " c, p95 " << stats.p95Abs << " c");
    CHECK (std::abs (stats.median) <= 5.0);
    CHECK (stats.p95Abs <= 20.0);
}

TEST_CASE ("Retune tracker hops are bit-identical under any chunking", "[retune][tracker]")
{
    const auto steady = fx::steadyDetunedFixture();
    const auto whole = streamFixture (steady, { (int) steady.samples.size() });
    for (const auto& blocks : { std::vector<int> { 128 }, std::vector<int> { 137 }, std::vector<int> { 512 },
                                std::vector<int> { 128, 137, 512, 64 } })
    {
        const auto chunked = streamFixture (steady, blocks);
        REQUIRE (chunked.size() == whole.size());
        bool identical = true;
        for (std::size_t i = 0; identical && i < chunked.size(); ++i)
            identical = chunked[i].f0Hz == whole[i].f0Hz && chunked[i].voiced == whole[i].voiced;
        CHECK (identical);
    }
}

TEST_CASE ("Retune tracker follows vibrato and a glissando", "[retune][tracker]")
{
    for (const auto& fixture : { fx::vibratoFixture(), fx::glissandoFixture() })
    {
        const auto errors = voicedErrors (fixture, streamFixture (fixture, { 256 }), 6);
        REQUIRE (errors.size() > 10);
        const auto stats = fx::centsSeriesStats (errors);
        INFO ("p95 " << stats.p95Abs << " c");
        CHECK (stats.p95Abs <= 30.0);
    }
}

TEST_CASE ("Retune tracker holds pitch on a breathy vowel", "[retune][tracker]")
{
    const auto breathy = fx::breathyFixture();
    const auto errors = voicedErrors (breathy, streamFixture (breathy, { 512 }), 6);
    REQUIRE (errors.size() > 10);
    CHECK (std::abs (fx::centsSeriesStats (errors).median) <= 10.0);
}

TEST_CASE ("Retune tracker marks a noise burst unvoiced and the vowels voiced", "[retune][tracker]")
{
    const auto phrase = fx::phraseFixture();
    const auto hops = streamFixture (phrase, { 512 });
    const auto s = PitchTracker::settingsFor (phrase.sampleRate);
    int truthVoiced = 0, agreed = 0, burstHops = 0, burstVoiced = 0;
    for (std::size_t i = 0; i < hops.size(); ++i)
    {
        // Judge only hops whose whole analysis window sits inside one region.
        const double end = ((double) s.windowFrames + (double) i * s.hopFrames) / phrase.sampleRate;
        const double start = end - (double) s.windowFrames / phrase.sampleRate;
        // The voicing hysteresis needs three more hops to follow a change.
        const double settle = 4.0 * s.hopFrames / phrase.sampleRate;
        if (phrase.voicedAt (start) && phrase.voicedAt (end) && phrase.voicedAt (start - settle)
            && (end < 0.4 || start - settle >= 0.52))
        {
            ++truthVoiced;
            agreed += hops[i].voiced ? 1 : 0;
        }
        if (start - settle >= 0.4 && end <= 0.52)
        {
            ++burstHops;
            burstVoiced += hops[i].voiced ? 1 : 0;
        }
    }
    REQUIRE (truthVoiced > 10);
    CHECK ((double) agreed / truthVoiced >= 0.8);
    // The burst is only 120 ms; any hop wholly inside it and past the hysteresis
    // must read unvoiced.
    CHECK (burstVoiced == 0);
    INFO ("burst hops judged: " << burstHops);
}

TEST_CASE ("Retune tracker follows a real octave step instead of latching", "[retune][tracker]")
{
    // Phase-continuous 220 -> 440 Hz step: the jump guard must accept it once it
    // persists, and the median ring must not hold the old octave.
    const auto step = fx::renderVocal (1.2, [] (double t) { return t < 0.5 ? 220.0 : 440.0; });
    const auto hops = streamFixture (step, { 512 });
    double worstLate = 0.0;
    int lateVoiced = 0;
    for (std::size_t i = 0; i < hops.size(); ++i)
    {
        const double t = hopCentreSeconds (step, i, hops[i].f0Hz);
        if (t > 0.7 && t < 1.1 && hops[i].voiced)
        {
            ++lateVoiced;
            worstLate = std::max (worstLate, std::abs (fx::hzToCents (hops[i].f0Hz, 440.0)));
        }
    }
    REQUIRE (lateVoiced > 10);
    CHECK (worstLate <= 50.0);
}

TEST_CASE ("Retune tracker hears a quiet vowel and ignores silence", "[retune][tracker]")
{
    // Peak 0.02 is roughly -40 dBFS RMS: well above the -50 dBFS gate.
    const auto quiet = fx::renderVocal (1.0, [] (double) { return 220.0; }, -1000.0, 48000.0, 0.02f);
    const auto errors = voicedErrors (quiet, streamFixture (quiet, { 512 }), 6);
    REQUIRE (errors.size() > 10);
    CHECK (std::abs (fx::centsSeriesStats (errors).median) <= 5.0);

    fx::VocalFixture silence;
    silence.samples.assign (48000, 0.0f);
    silence.f0At = [] (double) { return 0.0; };
    for (const auto& hop : streamFixture (silence, { 512 }))
        CHECK_FALSE (hop.voiced);
}

TEST_CASE ("Retune tracker keeps a noisy sustained note voiced", "[retune][tracker]")
{
    // Formant-shaped noise at the fixture's +2 dB setting: the strict threshold alone
    // drops about one hop in eight here, so the continuity rescue near the held pitch
    // has to carry the note.
    const auto noisy = fx::renderVocal (2.0, [] (double) { return fx::centsToHz (220.0, 35.0); }, 2.0);
    const auto hops = streamFixture (noisy, { 512 });
    int dropouts = 0, voiced = 0;
    bool started = false;
    for (std::size_t i = 0; i + 12 < hops.size(); ++i) // ignore the fade-out
    {
        if (hops[i].voiced)
        {
            started = true;
            ++voiced;
        }
        else if (started)
            ++dropouts;
    }
    INFO ("voiced hops " << voiced << ", dropouts " << dropouts);
    REQUIRE (voiced > 100);
    CHECK (dropouts == 0);
    CHECK (std::abs (fx::centsSeriesStats (voicedErrors (noisy, hops, 6)).median) <= 15.0);
}

// ----------------------------------------------------------------------------
// Correction decision

TEST_CASE ("Retune correction snaps a detuned A3 to the chromatic grid", "[retune][correction]")
{
    TuneCorrection correction;
    correction.prepare (hopSeconds48k());
    TuneCorrection::Params params;
    params.retuneMs = 0.0;
    TuneCorrection::Out out;
    for (int i = 0; i < 20; ++i)
        out = correction.update (fx::centsToHz (220.0, 35.0), true, params);
    CHECK (out.active);
    CHECK (out.targetNote == 57);
    CHECK (out.correctionCents == Catch::Approx (-35.0).margin (0.1));
    CHECK (out.ratio == Catch::Approx (std::pow (2.0, -35.0 / 1200.0)).epsilon (1.0e-6));
}

TEST_CASE ("Retune correction respects the scale", "[retune][correction]")
{
    TuneCorrection correction;
    correction.prepare (hopSeconds48k());
    TuneCorrection::Params params;
    params.rootSemitone = 0; // C minor has no A natural
    params.scale = TuneCorrection::Scale::minor;
    params.retuneMs = 0.0;
    params.maxCorrectionCents = 200.0;
    TuneCorrection::Out out;
    for (int i = 0; i < 20; ++i)
        out = correction.update (fx::centsToHz (220.0, 35.0), true, params);
    CHECK (out.targetNote == 58); // A#3
    CHECK (out.correctionCents == Catch::Approx (65.0).margin (0.1));
}

TEST_CASE ("Retune correction does not warble at a note midpoint", "[retune][correction]")
{
    TuneCorrection correction;
    correction.prepare (hopSeconds48k());
    TuneCorrection::Params params;
    params.retuneMs = 0.0;
    (void) correction.update (midiCentsToHz (5700.0), true, params);
    for (int i = 0; i < 40; ++i)
    {
        const auto out = correction.update (midiCentsToHz (i % 2 == 0 ? 5749.0 : 5751.0), true, params);
        CHECK (out.targetNote == 57);
    }
    // A committed push past the deadband does move the target.
    CHECK (correction.update (midiCentsToHz (5785.0), true, params).targetNote == 58);
}

TEST_CASE ("Retune correction holds across a short dip and clears after a gap", "[retune][correction]")
{
    const double hop = hopSeconds48k();
    TuneCorrection::Params params;
    params.retuneMs = 300.0;

    auto settled = [&] (TuneCorrection& correction)
    {
        correction.prepare (hop);
        TuneCorrection::Out out;
        for (int i = 0; i < (int) (5.0 / hop); ++i)
            out = correction.update (midiCentsToHz (5735.0), true, params);
        return out;
    };

    SECTION ("an unvoiced hop returns the held ratio")
    {
        TuneCorrection correction;
        const auto before = settled (correction);
        const auto held = correction.update (0.0, false, params);
        CHECK_FALSE (held.active);
        CHECK (held.ratio == before.ratio);
        CHECK (held.correctionCents == before.correctionCents);
        CHECK (held.targetNote == before.targetNote);
    }

    SECTION ("a 20 ms dip resumes where it left off")
    {
        TuneCorrection correction;
        const auto before = settled (correction);
        for (int i = 0; i < (int) std::ceil (0.020 / hop); ++i)
            (void) correction.update (0.0, false, params);
        const auto after = correction.update (midiCentsToHz (5735.0), true, params);
        CHECK (after.correctionCents == Catch::Approx (before.correctionCents).margin (0.5));
    }

    SECTION ("a 100 ms gap starts the next phrase from zero correction")
    {
        TuneCorrection correction;
        (void) settled (correction);
        for (int i = 0; i < (int) std::ceil (0.100 / hop); ++i)
            (void) correction.update (0.0, false, params);
        const auto after = correction.update (midiCentsToHz (5980.0), true, params);
        CHECK (after.targetNote == 60);
        CHECK (std::abs (after.correctionCents) < 2.0); // eases in from zero, not from -35
    }
}

TEST_CASE ("Retune correction speed, amount and range", "[retune][correction]")
{
    const double hop = hopSeconds48k();
    const double f0 = fx::centsToHz (220.0, 35.0);

    SECTION ("hard tune lands in one hop, a slow retune eases in")
    {
        TuneCorrection hard, slow;
        hard.prepare (hop);
        slow.prepare (hop);
        TuneCorrection::Params hardParams, slowParams;
        hardParams.retuneMs = 0.0;
        slowParams.retuneMs = 300.0;
        CHECK (hard.update (f0, true, hardParams).correctionCents < -33.0);
        const auto first = slow.update (f0, true, slowParams).correctionCents;
        CHECK (first > -2.0);
        TuneCorrection::Out out;
        for (int i = 0; i < (int) (0.3 / hop); ++i)
            out = slow.update (f0, true, slowParams);
        // One time constant in: about 63% of the way.
        CHECK (out.correctionCents == Catch::Approx (-35.0 * (1.0 - std::exp (-1.0))).margin (2.0));
    }

    SECTION ("amount scales and range caps the correction")
    {
        TuneCorrection half, capped;
        half.prepare (hop);
        capped.prepare (hop);
        TuneCorrection::Params halfParams, cappedParams;
        halfParams.retuneMs = 0.0;
        halfParams.amount = 0.5;
        cappedParams.retuneMs = 0.0;
        cappedParams.maxCorrectionCents = 20.0;
        TuneCorrection::Out a, b;
        for (int i = 0; i < 20; ++i)
        {
            a = half.update (f0, true, halfParams);
            b = capped.update (f0, true, cappedParams);
        }
        CHECK (a.correctionCents == Catch::Approx (-17.5).margin (0.1));
        CHECK (b.correctionCents == Catch::Approx (-20.0).margin (0.1));
    }
}

TEST_CASE ("Retune glide blends between snapping and easing onto a new note", "[retune][correction]")
{
    const double hop = hopSeconds48k();

    // Settle on A3 + 35 c (correction -35), then jump to C4 - 20 c (wants +20).
    auto afterNoteChange = [hop] (double glide)
    {
        TuneCorrection correction;
        correction.prepare (hop);
        TuneCorrection::Params params;
        params.retuneMs = 300.0;
        params.glide = glide;
        for (int i = 0; i < (int) (5.0 / hop); ++i)
            (void) correction.update (midiCentsToHz (5735.0), true, params);
        const auto out = correction.update (midiCentsToHz (5980.0), true, params);
        REQUIRE (out.targetNote == 60);
        return out.correctionCents;
    };

    CHECK (afterNoteChange (0.0) == Catch::Approx (20.0).margin (1.0));   // snapped
    CHECK (afterNoteChange (1.0) == Catch::Approx (-35.0).margin (1.5));  // still easing in
    CHECK (afterNoteChange (0.5) == Catch::Approx (-7.5).margin (2.0));   // half way
}

// ----------------------------------------------------------------------------
// The composed core

TEST_CASE ("Retune core pulls a detuned vowel to pitch and keeps its harmonics", "[retune][core]")
{
    const auto vowel = fx::steadyDetunedFixture (2.0);
    const double inputHz = fx::centsToHz (220.0, 35.0);
    const auto out = render (vowel.samples, vowel.sampleRate, hardChromatic(), 512);

    const int from = 48000, length = 24000; // 1.0 s .. 1.5 s
    const auto measured = mosh::moshfx::estimateMonophonicPitch (out.data() + from, length, vowel.sampleRate, 180.0, 260.0);
    REQUIRE (measured.voiced);
    INFO ("output " << measured.frequencyHz << " Hz, " << fx::hzToCents (measured.frequencyHz, 220.0) << " c from A3");
    CHECK (std::abs (fx::hzToCents (measured.frequencyHz, 220.0)) <= 5.0);

    // The engine moves the formants with the pitch, so each harmonic keeps its
    // level by harmonic number. The sine core this replaced had only a fundamental.
    for (int harmonic = 1; harmonic <= 8; ++harmonic)
    {
        const double in = fx::toneLevel (vowel.samples.data() + from, length, vowel.sampleRate, harmonic * inputHz);
        const double tuned = fx::toneLevel (out.data() + from, length, vowel.sampleRate, harmonic * measured.frequencyHz);
        INFO ("harmonic " << harmonic << ": in " << 20.0 * std::log10 (in) << " dB, out " << 20.0 * std::log10 (tuned) << " dB");
        CHECK (std::abs (20.0 * std::log10 (tuned / in)) <= 2.0);
    }
}

TEST_CASE ("Retune core delays a click by exactly its reported latency", "[retune][core]")
{
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
    {
        RetuneCore core;
        REQUIRE (core.prepare (rate));
        const int latency = core.latencySamples();
        INFO ("rate " << rate << ", latency " << latency);
        CHECK (latency > 0);
        CHECK (latency < (int) (0.005 * rate)); // low-latency design: under 5 ms

        std::vector<float> click (8000, 0.0f);
        click[1000] = 0.5f;
        auto out = click;
        core.process (out.data(), (int) out.size(), hardChromatic());
        CHECK (delayMismatches (click, out, latency) == 0);
    }
}

TEST_CASE ("Retune core passes noise and silence untouched at its latency", "[retune][core]")
{
    const auto noise = lcgNoise (48000, 0.1f);
    RetuneCore core;
    REQUIRE (core.prepare (48000.0));
    const int latency = core.latencySamples();

    const auto out = render (noise, 48000.0, hardChromatic(), 512);
    CHECK (delayMismatches (noise, out, latency) == 0);

    const std::vector<float> silence (24000, 0.0f);
    for (const float s : render (silence, 48000.0, hardChromatic(), 512))
        REQUIRE (s == 0.0f);
}

TEST_CASE ("Retune core output is bit-identical under any chunking", "[retune][core]")
{
    const auto phrase = fx::phraseFixture();
    const auto reference = render (phrase.samples, phrase.sampleRate, hardChromatic(), 4096);
    for (const int chunk : { 64, 128, 137, 512 })
    {
        const auto chunked = render (phrase.samples, phrase.sampleRate, hardChromatic(), chunk);
        REQUIRE (chunked.size() == reference.size());
        CHECK (std::memcmp (chunked.data(), reference.data(), reference.size() * sizeof (float)) == 0);
    }
    for (const float s : reference)
        REQUIRE (std::isfinite (s));
}

TEST_CASE ("Retune core retune time changes how fast the correction lands", "[retune][core]")
{
    const auto vowel = fx::steadyDetunedFixture (1.0);
    auto correctionAt = [&vowel] (float retuneMs, double seconds)
    {
        auto settings = hardChromatic();
        settings.retuneMs = retuneMs;
        std::vector<RetuneReadout> readouts;
        (void) render (vowel.samples, vowel.sampleRate, settings, 64, &readouts);
        return readouts[(std::size_t) (seconds * vowel.sampleRate / 64.0)].correctionCents;
    };

    const double hardEarly = correctionAt (RetuneCore::kHardRetuneMs, 0.2);
    const double slowEarly = correctionAt (250.0f, 0.2);
    const double slowLate = correctionAt (250.0f, 0.9);
    INFO ("hard@0.2s " << hardEarly << ", slow@0.2s " << slowEarly << ", slow@0.9s " << slowLate);
    CHECK (hardEarly < -30.0);
    CHECK (slowEarly > -25.0);
    CHECK (slowEarly < -3.0);
    CHECK (slowLate < slowEarly - 5.0);
}

TEST_CASE ("Retune core Mix and Amount at zero return the delayed input", "[retune][core]")
{
    const auto vowel = fx::steadyDetunedFixture (1.0);
    RetuneCore core;
    REQUIRE (core.prepare (vowel.sampleRate));
    const int latency = core.latencySamples();

    auto dry = hardChromatic();
    dry.mix = 0.0f;
    CHECK (delayMismatches (vowel.samples, render (vowel.samples, vowel.sampleRate, dry, 512), latency) == 0);

    auto noCorrection = hardChromatic();
    noCorrection.amount = 0.0f;
    CHECK (delayMismatches (vowel.samples, render (vowel.samples, vowel.sampleRate, noCorrection, 512), latency) == 0);
}

TEST_CASE ("Retune core reports what it hears", "[retune][core]")
{
    const auto vowel = fx::steadyDetunedFixture (1.0);
    std::vector<RetuneReadout> readouts;
    (void) render (vowel.samples, vowel.sampleRate, hardChromatic(), 512, &readouts);
    const auto& late = readouts[(std::size_t) (0.6 * vowel.sampleRate / 512.0)];
    CHECK (late.voiced);
    CHECK (std::abs (fx::hzToCents (late.inputHz, fx::centsToHz (220.0, 35.0))) <= 5.0);
    CHECK (late.targetHz == Catch::Approx (220.0).epsilon (1.0e-9));
    CHECK (late.correctionCents == Catch::Approx (-35.0).margin (5.0));
    CHECK (late.confidence > 0.8f);
}

TEST_CASE ("Retune core holds the correction through a short dropout", "[retune][core]")
{
    // vowel / unvoiced burst / vowel, with the burst shorter or longer than the
    // 60 ms hold. Releasing on the short one would blip the pitch back to
    // uncorrected and force a recentre crossfade in the middle of a note.
    auto recentresWithBurst = [] (double burstSeconds)
    {
        const double rate = 48000.0;
        auto vowel = fx::renderVocal (0.5, [] (double) { return fx::centsToHz (220.0, 35.0); });
        std::vector<float> input (vowel.samples.begin(), vowel.samples.end() - 1440); // drop the fade-out
        fx::detail::Lcg random (5);
        for (int i = 0; i < (int) (burstSeconds * rate); ++i)
            input.push_back (0.05f * (float) random.next());
        input.insert (input.end(), vowel.samples.begin() + 1440, vowel.samples.end() - 1440);

        RetuneCore core;
        REQUIRE (core.prepare (rate));
        core.process (input.data(), (int) input.size(), hardChromatic());
        return core.shifterForDiagnostics().recentreCount();
    };

    CHECK (recentresWithBurst (0.020) == 0);
    CHECK (recentresWithBurst (0.200) >= 1);
}

TEST_CASE ("Retune core never allocates while processing", "[retune][core][rtguard]")
{
    const auto phrase = fx::phraseFixture();
    RetuneCore core;
    REQUIRE (core.prepare (phrase.sampleRate));
    auto buffer = phrase.samples;
    const auto settings = hardChromatic();

    mosh::rtguard::setViolationHandler ([] {});
    const long before = mosh::rtguard::violationCount();
    {
        mosh::rtguard::ScopedRealtime realtime; // no Catch2 macros inside: they allocate
        for (std::size_t at = 0; at + 128 <= buffer.size(); at += 128)
            core.process (buffer.data() + at, 128, settings);
    }
    CHECK (mosh::rtguard::violationCount() == before);
}
