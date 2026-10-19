#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "reimagine/ReImagineConform.h"
#include "reimagine/ReImagineSession.h"

#include <cmath>
#include <limits>
#include <vector>

using namespace mosh::reimagine;

namespace
{
SessionSnapshot eightBarSnapshot()
{
    SessionSnapshot s;
    s.id = "snap-1";
    s.instanceId = "inst-1";
    s.regionId = "region-1";
    s.sourceHash = juce::String::repeatedString ("a", 64);
    s.inputHash = s.sourceHash;
    s.inputRole = "source";
    s.sampleRate = 48000.0;
    s.channels = 2;
    s.frames = static_cast<int64_t> (48000.0 * 8 * 4 * 60.0 / 90.0); // eight 4/4 bars at 90 BPM
    s.ppqStart = 0.0;
    s.ppqEnd = 32.0;
    s.constantTempo = true;
    s.context.bpm = 90.0;
    s.context.bpmFrom = Provenance::host;
    s.context.meterNumerator = 4;
    s.context.meterFrom = Provenance::host;
    return s;
}

IntentionInput hazyKeys()
{
    IntentionInput in;
    in.request = "hazy sampled-keyboard loop, less busy performance";
    in.strength = 0.35f;
    in.candidateCount = 2;
    in.baseSeed = 100;
    return in;
}

// Click track: a 12 ms decaying 1 kHz burst on every beat. The tempo moves linearly from
// startBpm to endBpm across the clip (equal for a steady track).
std::vector<float> clickTrack (double startBpm, double endBpm, double seconds, double sampleRate,
                               double firstClickSeconds = 0.0)
{
    const auto frames = static_cast<size_t> (seconds * sampleRate);
    std::vector<float> data (frames, 0.0f);
    const auto burst = static_cast<size_t> (0.012 * sampleRate);
    double t = firstClickSeconds;
    while (t < seconds)
    {
        const auto start = static_cast<size_t> (std::llround (t * sampleRate));
        for (size_t i = 0; i < burst && start + i < frames; ++i)
        {
            const auto x = static_cast<double> (i) / sampleRate;
            data[start + i] += static_cast<float> (0.8 * std::exp (-x / 0.003) * std::sin (2.0 * 3.14159265358979 * 1000.0 * x));
        }
        const auto bpm = startBpm + (endBpm - startBpm) * (t / seconds);
        t += 60.0 / bpm;
    }
    return data;
}

SessionContext hostTempo (double bpm)
{
    SessionContext c;
    c.bpm = bpm;
    c.bpmFrom = Provenance::host;
    c.meterNumerator = 4;
    c.meterFrom = Provenance::host;
    return c;
}

TempoConformanceReport conformanceOf (const std::vector<float>& mono, double sampleRate, const SessionContext& c)
{
    const float* channels[] = { mono.data(), mono.data() };
    return checkTempoConformance (channels, 2, static_cast<int64_t> (mono.size()), sampleRate, c);
}

std::vector<float> sine (int frames, float amplitude)
{
    std::vector<float> data (static_cast<size_t> (frames));
    for (int i = 0; i < frames; ++i)
        data[static_cast<size_t> (i)] = amplitude * std::sin (2.0f * 3.14159265f * 220.0f * static_cast<float> (i) / 48000.0f);
    return data;
}
}

TEST_CASE ("Timed chord lists parse, reject junk, and round-trip", "[reimagine][session][context]")
{
    const auto ok = parseChordList ("1:Fm7 3:Db | 5:Abmaj7, 7:Eb/G 8.5:C7", 8.0);
    REQUIRE (ok.errors.isEmpty());
    REQUIRE (ok.chords.size() == 5);
    CHECK (ok.chords[3].symbol == "Eb/G");
    CHECK (ok.chords[4].bar == Catch::Approx (8.5));
    CHECK (formatChordList (ok.chords) == "1:Fm7 3:Db 5:Abmaj7 7:Eb/G 8.50:C7");

    CHECK (parseChordList ("Fm7 Db", 8.0).errors.size() == 2);          // no bar
    CHECK (parseChordList ("0:Fm7", 8.0).errors.size() == 1);           // before bar 1
    CHECK (parseChordList ("3:Fm7 2:Db", 8.0).errors.size() == 1);      // not increasing
    CHECK (parseChordList ("9:Fm7", 8.0).errors.size() == 1);           // after the region
    CHECK (parseChordList ("1:Hm7", 8.0).errors.size() == 1);           // not a chord
    CHECK (parseChordList ("1:rm -rf", 8.0).errors.size() >= 1);
    CHECK (parseChordList ("", 8.0).chords.empty());
}

TEST_CASE ("Host facts fill unknown context but never override the user", "[reimagine][session][context]")
{
    RegionFacts facts;
    facts.tempoMap = { { 0.0, 92.0 }, { 4.0, 92.0 } };
    facts.hostMeterNumerator = 3;

    const auto merged = mergeHostFacts ({}, facts);
    REQUIRE (merged.bpm.has_value());
    CHECK (*merged.bpm == Catch::Approx (92.0));
    CHECK (merged.bpmFrom == Provenance::host);
    CHECK (merged.meterNumerator == 3);
    CHECK (merged.meterFrom == Provenance::host);

    SessionContext user;
    user.bpm = 88.0;
    user.bpmFrom = Provenance::user;
    CHECK (*mergeHostFacts (user, facts).bpm == Catch::Approx (88.0));

    RegionFacts changing;
    changing.tempoMap = { { 0.0, 92.0 }, { 4.0, 100.0 } };
    const auto unknown = mergeHostFacts ({}, changing);
    CHECK_FALSE (unknown.bpm.has_value());
    CHECK (unknown.bpmFrom == Provenance::unknown);
    CHECK_FALSE (mergeHostFacts ({}, RegionFacts {}).bpm.has_value());     // no silent 120 BPM

    SessionContext assumed;
    assumed.tempoAssumed = true;                                          // import before host timing
    CHECK_FALSE (mergeHostFacts (assumed, facts).bpm.has_value());
    CHECK (contextFromVar (contextToVar (assumed)).tempoAssumed);
}

TEST_CASE ("The transform template compiles a bounded, honest request", "[reimagine][session][compile]")
{
    auto snapshot = eightBarSnapshot();
    snapshot.context.key = "F minor";
    snapshot.context.keyFrom = Provenance::user;
    snapshot.context.chords = parseChordList ("1:Fm7 3:Db 5:Ab 7:Eb", 8.0).chords;
    snapshot.context.chordsFrom = Provenance::user;
    snapshot.context.protectedChoices.add ("chord-change timing");

    const auto result = compileIntention (hazyKeys(), snapshot, "int-1", {}, 0);
    REQUIRE (result.errors.isEmpty());
    REQUIRE (result.request.has_value());
    const auto& r = *result.request;
    CHECK (r.prompt.startsWith ("hazy sampled-keyboard loop"));
    CHECK (r.prompt.contains ("in F minor"));
    CHECK (r.prompt.contains ("90 BPM"));
    CHECK (r.prompt.endsWith ("chords by bar: 1 Fm7, 3 Db, 5 Ab, 7 Eb"));
    CHECK (r.seeds == std::vector<int64_t> { 100, 101 });
    CHECK (r.durationSeconds == Catch::Approx (21.333).margin (0.001));
    CHECK (r.templateVersion == kTransformTemplateVersion);

    bool sawChords = false, sawProtected = false;
    for (const auto& entry : r.conditioning)
    {
        if (entry.field == "chords")
        {
            sawChords = true;
            CHECK (entry.sentAs == "text-prompt+structured");
            CHECK_FALSE (entry.enforced);
            CHECK (entry.note.contains ("1:Fm7 3:Db 5:Ab 7:Eb"));
            CHECK (entry.note.contains ("neither harmony nor change timing is enforced"));
        }
        if (entry.field == "protected-choices")
        {
            sawProtected = true;
            CHECK (entry.sentAs == "not-sent");
        }
        if (entry.field == "tempo")
            CHECK_FALSE (entry.enforced);
    }
    CHECK (sawChords);
    CHECK (sawProtected);
    CHECK (result.warnings.joinIntoString ("|").contains ("harmony is not enforced"));
    CHECK (validateRequest (r).isEmpty());
}

TEST_CASE ("Revisions continue the intention's seeds and require revision text", "[reimagine][session][compile]")
{
    auto in = hazyKeys();
    auto snapshot = eightBarSnapshot();
    snapshot.inputRole = "parent-take";
    snapshot.inputHash = juce::String::repeatedString ("b", 64);

    CHECK_FALSE (compileIntention (in, snapshot, "int-1", "take-B", 2).errors.isEmpty());   // no revision text
    in.revision = "roughen the texture";
    const auto result = compileIntention (in, snapshot, "int-1", "take-B", 2);
    REQUIRE (result.request.has_value());
    CHECK (result.request->parentTakeId == "take-B");
    CHECK (result.request->seeds == std::vector<int64_t> { 102, 103 });
    CHECK (result.request->prompt.contains ("roughen the texture"));
    CHECK (result.request->conditioning.front().field == "parent-take-audio");
}

TEST_CASE ("Compilation refuses missing context, bad ranges, and an exhausted budget", "[reimagine][session][compile]")
{
    const auto snapshot = eightBarSnapshot();

    auto empty = hazyKeys();
    empty.request = "   ";
    CHECK_FALSE (compileIntention (empty, snapshot, "i", {}, 0).request.has_value());

    auto noAudio = snapshot;
    noAudio.inputHash.clear();
    CHECK_FALSE (compileIntention (hazyKeys(), noAudio, "i", {}, 0).request.has_value());

    auto tooShort = snapshot;
    tooShort.frames = 48000;
    CHECK_FALSE (compileIntention (hazyKeys(), tooShort, "i", {}, 0).request.has_value());

    auto tempoChange = snapshot;
    tempoChange.constantTempo = false;
    const auto tc = compileIntention (hazyKeys(), tempoChange, "i", {}, 0);
    CHECK_FALSE (tc.request.has_value());
    CHECK (tc.errors.joinIntoString ("|").contains ("constant-tempo"));

    auto strong = hazyKeys();
    strong.strength = 0.9f;
    CHECK_FALSE (compileIntention (strong, snapshot, "i", {}, 0).request.has_value());
    strong.strength = std::numeric_limits<float>::quiet_NaN();
    CHECK_FALSE (compileIntention (strong, snapshot, "i", {}, 0).request.has_value());

    auto many = hazyKeys();
    many.candidateCount = 5;
    CHECK_FALSE (compileIntention (many, snapshot, "i", {}, 0).request.has_value());
    many.candidateCount = 0;
    CHECK_FALSE (compileIntention (many, snapshot, "i", {}, 0).request.has_value());

    CHECK (compileIntention (hazyKeys(), snapshot, "i", {}, 6).request.has_value());       // 6 + 2 == 8
    const auto over = compileIntention (hazyKeys(), snapshot, "i", {}, 7);                 // 7 + 2 > 8
    CHECK_FALSE (over.request.has_value());
    CHECK (over.errors.joinIntoString ("|").contains ("Budget"));

    auto verbose = hazyKeys();
    verbose.request = juce::String::repeatedString ("x", kMaxPromptChars + 1);
    CHECK_FALSE (compileIntention (verbose, snapshot, "i", {}, 0).request.has_value());
}

TEST_CASE ("Unknown tempo is surfaced, not defaulted", "[reimagine][session][compile]")
{
    auto snapshot = eightBarSnapshot();
    snapshot.context.bpm.reset();
    snapshot.context.bpmFrom = Provenance::unknown;
    snapshot.constantTempo = false;
    const auto result = compileIntention (hazyKeys(), snapshot, "i", {}, 0);
    REQUIRE (result.request.has_value());
    CHECK_FALSE (result.request->prompt.contains ("BPM"));
    CHECK (result.warnings.joinIntoString ("|").contains ("not verified"));
}

TEST_CASE ("Malformed controller requests are rejected before submission", "[reimagine][session][validate]")
{
    const auto good = *compileIntention (hazyKeys(), eightBarSnapshot(), "i", {}, 0).request;
    REQUIRE (validateRequest (good).isEmpty());

    auto r = good;
    r.backend = "hosted_gary";
    CHECK_FALSE (validateRequest (r).isEmpty());
    r = good;
    r.task = "shell";
    CHECK_FALSE (validateRequest (r).isEmpty());
    r = good;
    r.seeds = { 5, 5 };
    CHECK_FALSE (validateRequest (r).isEmpty());
    r = good;
    r.prompt = {};
    CHECK_FALSE (validateRequest (r).isEmpty());
    r = good;
    r.strength = std::numeric_limits<float>::infinity();
    CHECK_FALSE (validateRequest (r).isEmpty());
    r = good;
    r.attemptsBefore = 7;
    CHECK_FALSE (validateRequest (r).isEmpty());
    r = good;
    r.loras = { { "x", 9.0f } };
    CHECK_FALSE (validateRequest (r).isEmpty());
}

TEST_CASE ("Direct service params satisfy the explicit no-fallback render contract", "[reimagine][session][service]")
{
    const auto r = *compileIntention (hazyKeys(), eightBarSnapshot(), "i", {}, 0).request;
    const auto hash = juce::String::repeatedString ("c", 64);
    const auto params = directServiceParams (r, 1, hash, "i:1");
    CHECK (params["decision_policy"].toString() == "explicit");
    CHECK (params["mode"].toString() == "reimagine");
    CHECK (params["coverage"].toString() == "single");
    CHECK_FALSE (static_cast<bool> (params["lab"]));
    CHECK (params["seed"].isInt64());
    CHECK (static_cast<juce::int64> (params["seed"]) == 101);
    CHECK (params["source_sha256"].toString() == hash);
    CHECK (params["request_id"].toString() == "i:1");
    CHECK (static_cast<double> (params["duration_s"]) == Catch::Approx (r.durationSeconds));
    CHECK (static_cast<double> (params["nl"]) == Catch::Approx (0.35));
}

TEST_CASE ("Chord change timing reaches the request as structured data, not enforced", "[reimagine][session][service]")
{
    auto snapshot = eightBarSnapshot();
    snapshot.context.chords = parseChordList ("1:Fm7 3:Db 4.5:Eb/G", 8.0).chords;
    snapshot.context.chordsFrom = Provenance::user;
    const auto r = *compileIntention (hazyKeys(), snapshot, "i", {}, 0).request;
    CHECK (r.prompt == "hazy sampled-keyboard loop, less busy performance, 90 BPM, chords by bar: 1 Fm7, 3 Db, 4.50 Eb/G");
    REQUIRE (r.chordTiming.size() == 3);
    CHECK (r.chordTimingFrom == Provenance::user);

    // The service body carries the same list with provenance, and claims no enforcement.
    const auto params = directServiceParams (r, 0, juce::String::repeatedString ("c", 64), "i:0");
    const auto timing = params["chord_timing"];
    REQUIRE (timing.isObject());
    CHECK (timing["unit"].toString() == "bar");
    CHECK (timing["origin"].toString() == "region-start");
    CHECK (timing["provenance"].toString() == "user");
    CHECK_FALSE (static_cast<bool> (timing["enforced"]));
    REQUIRE (timing["events"].size() == 3);
    CHECK (static_cast<double> (timing["events"][2]["bar"]) == Catch::Approx (4.5));
    CHECK (timing["events"][2]["symbol"].toString() == "Eb/G");
    CHECK (compiledRequestToVar (r)["chordTiming"]["events"].size() == 3);

    // Deterministic: the same snapshot compiles to the same prompt and body.
    const auto again = *compileIntention (hazyKeys(), snapshot, "i", {}, 0).request;
    CHECK (again.prompt == r.prompt);
    CHECK (juce::JSON::toString (directServiceParams (again, 0, juce::String::repeatedString ("c", 64), "i:0"))
           == juce::JSON::toString (params));

    // No chords: the field is absent, so older service builds see an unchanged body.
    const auto plain = *compileIntention (hazyKeys(), eightBarSnapshot(), "i", {}, 0).request;
    CHECK_FALSE (directServiceParams (plain, 0, juce::String::repeatedString ("c", 64), "i:0")
                     .getDynamicObject()->hasProperty ("chord_timing"));
    CHECK_FALSE (plain.prompt.contains ("chords"));

    // A hand-edited request with bad timing is refused before submission.
    auto bad = r;
    bad.chordTiming = { { 3.0, "Fm7" }, { 2.0, "Db" } };
    CHECK_FALSE (validateRequest (bad).isEmpty());
    bad.chordTiming = { { 1.0, "rm -rf" } };
    CHECK_FALSE (validateRequest (bad).isEmpty());
}

TEST_CASE ("Context and intentions round-trip and keep unknown as unknown", "[reimagine][session][state]")
{
    SessionContext c;
    c.key = "F minor";
    c.keyFrom = Provenance::user;
    c.chords = { { 1.0, "Fm7" }, { 3.0, "Db" } };
    c.chordsFrom = Provenance::user;
    c.sectionLabel = "Verse 1";
    c.protectedChoices.add ("chord-change timing");
    const auto back = contextFromVar (juce::JSON::parse (juce::JSON::toString (contextToVar (c))));
    CHECK_FALSE (back.bpm.has_value());
    CHECK (back.bpmFrom == Provenance::unknown);
    CHECK (back.key == "F minor");
    CHECK (back.keyFrom == Provenance::user);
    REQUIRE (back.chords.size() == 2);
    CHECK (back.chords[1].symbol == "Db");
    CHECK (back.protectedChoices[0] == "chord-change timing");

    IntentionRecord i;
    i.id = "int-1";
    i.regionId = "r";
    i.request = "hazy keys";
    i.revisions.add ("roughen");
    i.attempts = 5;
    i.failures = 1;
    const auto j = intentionFromVar (juce::JSON::parse (juce::JSON::toString (intentionToVar (i))));
    CHECK (j.attempts == 5);
    CHECK (j.failures == 1);
    CHECK (remainingAttempts (j) == 3);
    CHECK (j.revisions[0] == "roughen");
    CHECK (intentionFromVar ({}).maxAttempts == kDefaultMaxAttemptsPerIntention);
}

TEST_CASE ("Technical checks pass good audio and fail deliberately bad fixtures", "[reimagine][session][checks]")
{
    const int frames = 48000 * 4;
    auto left = sine (frames, 0.5f), right = sine (frames, 0.5f);
    const float* good[] = { left.data(), right.data() };
    const auto ok = checkCandidate (measureAudio (good, 2, frames, 48000.0), 4.0, 2);
    CHECK (ok.usable);
    CHECK (ok.warnings.isEmpty());

    std::vector<float> zeros (static_cast<size_t> (frames), 0.0f);
    const float* silent[] = { zeros.data(), zeros.data() };
    CHECK_FALSE (checkCandidate (measureAudio (silent, 2, frames, 48000.0), 4.0, 2).usable);

    auto broken = left;
    broken[100] = std::numeric_limits<float>::quiet_NaN();
    broken[200] = std::numeric_limits<float>::infinity();
    const float* nonFinite[] = { broken.data(), right.data() };
    const auto nf = checkCandidate (measureAudio (nonFinite, 2, frames, 48000.0), 4.0, 2);
    CHECK_FALSE (nf.usable);
    CHECK (nf.failures[0].contains ("2 non-finite"));

    CHECK_FALSE (checkCandidate (measureAudio (good, 2, 0, 48000.0), 4.0, 2).usable);

    auto hot = sine (frames, 1.0f);
    const float* clipped[] = { hot.data() };
    const auto clip = checkCandidate (measureAudio (clipped, 1, frames, 48000.0), 3.0, 2);
    CHECK (clip.usable);
    CHECK (clip.warnings.size() == 3);   // clipping, channel count, length
    CHECK (clip.durationDeltaSeconds == Catch::Approx (1.0));
}

TEST_CASE ("Tempo conformance: a steady click at the session tempo conforms", "[reimagine][session][tempo-conformance]")
{
    for (const auto rate : { 48000.0, 44100.0 })
        for (const auto bpm : { 90.0, 120.0, 143.0 })
        {
            CAPTURE (rate, bpm);
            const auto report = conformanceOf (clickTrack (bpm, bpm, 16.0, rate, 0.0137), rate, hostTempo (bpm));
            CHECK (report.verdict == TempoVerdict::conforms);
            REQUIRE (report.estimatedBpm.has_value());
            CHECK (*report.estimatedBpm == Catch::Approx (bpm).margin (0.1));
            CHECK (std::abs (report.driftMsPerBar) < 2.0);
            CHECK (report.pulseStrength >= kTempoMinPulseStrength);
            CHECK (describeTempoConformance (report).startsWith ("conforms to "));
        }

    // A short 4 s take (8 beats at 120) still measures within tolerance.
    CHECK (conformanceOf (clickTrack (120.0, 120.0, 4.0, 48000.0), 48000.0, hostTempo (120.0)).verdict
           == TempoVerdict::conforms);
    // Clicks over a sustained low pad (55 + 220 Hz) still measure: the pad is not a pulse.
    auto padded = clickTrack (120.0, 120.0, 16.0, 48000.0);
    for (size_t i = 0; i < padded.size(); ++i)
    {
        const auto t = static_cast<double> (i) / 48000.0;
        padded[i] += static_cast<float> (0.3 * std::sin (2.0 * 3.14159265358979 * 55.0 * t)
                                         + 0.2 * std::sin (2.0 * 3.14159265358979 * 220.0 * t));
    }
    CHECK (conformanceOf (padded, 48000.0, hostTempo (120.0)).verdict == TempoVerdict::conforms);
    CHECK (conformanceOf (padded, 48000.0, hostTempo (121.0)).verdict == TempoVerdict::drifts);

    // Half-time material (a hit every other beat) conforms through the 2-beat lag.
    CHECK (conformanceOf (clickTrack (60.0, 60.0, 16.0, 48000.0), 48000.0, hostTempo (120.0)).verdict
           == TempoVerdict::conforms);
}

TEST_CASE ("Tempo conformance: a click at another tempo, or accelerating, drifts", "[reimagine][session][tempo-conformance]")
{
    // 121 BPM against a 120 BPM session: (60/121 - 0.5) s x 4 beats = -16.5 ms per bar.
    const auto faster = conformanceOf (clickTrack (121.0, 121.0, 16.0, 48000.0), 48000.0, hostTempo (120.0));
    CHECK (faster.verdict == TempoVerdict::drifts);
    CHECK (faster.driftMsPerBar == Catch::Approx (-16.53).margin (1.0));
    REQUIRE (faster.estimatedBpm.has_value());
    CHECK (*faster.estimatedBpm == Catch::Approx (121.0).margin (0.2));
    CHECK (describeTempoConformance (faster).contains ("faster than 120.00 BPM (host)"));

    // 3/4 meter: drift scales with the bar. 118 BPM vs 120: (60/118 - 0.5) x 3 = +25.4 ms per bar.
    auto threeFour = hostTempo (120.0);
    threeFour.meterNumerator = 3;
    const auto slower = conformanceOf (clickTrack (118.0, 118.0, 16.0, 48000.0), 48000.0, threeFour);
    CHECK (slower.verdict == TempoVerdict::drifts);
    CHECK (slower.driftMsPerBar == Catch::Approx (25.42).margin (1.5));
    CHECK (describeTempoConformance (slower).contains ("slower"));

    // A take that speeds up from 120 to 128 BPM never reports conforming.
    const auto accelerating = conformanceOf (clickTrack (120.0, 128.0, 16.0, 48000.0), 48000.0, hostTempo (120.0));
    CHECK (accelerating.verdict != TempoVerdict::conforms);
}

TEST_CASE ("Tempo conformance stays undetermined without a trustworthy tempo or pulse", "[reimagine][session][tempo-conformance]")
{
    const auto clicks = clickTrack (120.0, 120.0, 16.0, 48000.0);

    SessionContext unknown;
    const auto noBpm = conformanceOf (clicks, 48000.0, unknown);
    CHECK (noBpm.verdict == TempoVerdict::undetermined);
    CHECK_FALSE (noBpm.estimatedBpm.has_value());
    CHECK (noBpm.reason.contains ("BPM unknown"));

    // A BPM value whose provenance is unknown is not evidence.
    auto unproven = hostTempo (120.0);
    unproven.bpmFrom = Provenance::unknown;
    CHECK (conformanceOf (clicks, 48000.0, unproven).verdict == TempoVerdict::undetermined);

    // tempoMapAssumed wins even when a BPM is present.
    auto assumed = hostTempo (120.0);
    assumed.tempoAssumed = true;
    const auto assumedReport = conformanceOf (clicks, 48000.0, assumed);
    CHECK (assumedReport.verdict == TempoVerdict::undetermined);
    CHECK (assumedReport.reason.contains ("assumed"));
    CHECK (tempoConformanceToVar (assumedReport)["driftMsPerBar"].isVoid());

    // Steady tone, silence, noise and a too-short clip have no measurable beat grid.
    CHECK (conformanceOf (sine (48000 * 8, 0.5f), 48000.0, hostTempo (120.0)).verdict == TempoVerdict::undetermined);
    CHECK (conformanceOf (std::vector<float> (48000 * 8, 0.0f), 48000.0, hostTempo (120.0)).verdict
           == TempoVerdict::undetermined);
    std::vector<float> noise (48000 * 8);
    juce::Random random (42);
    for (auto& v : noise)
        v = random.nextFloat() * 0.6f - 0.3f;
    CHECK (conformanceOf (noise, 48000.0, hostTempo (120.0)).verdict == TempoVerdict::undetermined);
    CHECK (conformanceOf (clickTrack (120.0, 120.0, 1.5, 48000.0), 48000.0, hostTempo (120.0)).verdict
           == TempoVerdict::undetermined);
    // A pulse far from the session tempo (90 vs 120 BPM) is not forced onto it.
    CHECK (conformanceOf (clickTrack (90.0, 90.0, 16.0, 48000.0), 48000.0, hostTempo (120.0)).verdict
           != TempoVerdict::conforms);

    // Unknown meter: 4 beats per bar is assumed and said so.
    auto noMeter = hostTempo (120.0);
    noMeter.meterNumerator.reset();
    noMeter.meterFrom = Provenance::unknown;
    const auto assumedMeter = conformanceOf (clicks, 48000.0, noMeter);
    CHECK (assumedMeter.meterAssumed);
    CHECK (describeTempoConformance (assumedMeter).contains ("4 beats/bar assumed"));
}

TEST_CASE ("Tempo conformance is stored on the take and old states still load", "[reimagine][session][tempo-conformance][state]")
{
    const auto report = conformanceOf (clickTrack (121.0, 121.0, 16.0, 48000.0), 48000.0, hostTempo (120.0));
    PluginStateV1 state;
    TransferRegion region;
    region.id = "r";
    region.sourceHash = "src";
    RenderTake take;
    take.id = "t";
    take.assetHash = juce::String::repeatedString ("d", 64);
    setLineage (take, { "int-1", {}, "candidate", false, false });
    take.manifest["m1"].getDynamicObject()->setProperty ("tempoConformance", tempoConformanceToVar (report));
    region.takes.push_back (take);
    state.regions.push_back (region);

    const auto back = deserializeState (serializeState (state));
    REQUIRE (back.has_value());
    const auto stored = back->regions.front().takes.front().manifest["m1"]["tempoConformance"];
    CHECK (stored["verdict"].toString() == "drifts");
    CHECK (stored["kind"].toString().contains ("not a taste judgement"));
    CHECK_FALSE (static_cast<bool> (stored["phaseChecked"]));
    CHECK (describeStoredTempoConformance (stored) == describeTempoConformance (report));
    CHECK (lineageOf (back->regions.front().takes.front()).intentionId == "int-1");

    // A take written before the check has no field and says so instead of guessing.
    const auto legacy = deserializeState (
        "{\"schemaVersion\": 1, \"regions\": [{\"id\": \"r\", \"takes\": [{\"id\": \"t\", \"assetHash\": \"x\", "
        "\"manifest\": {\"m1\": {\"intentionId\": \"int-1\", \"role\": \"candidate\"}}}]}]}");
    REQUIRE (legacy.has_value());
    REQUIRE (legacy->regions.front().takes.size() == 1);
    CHECK (describeStoredTempoConformance (legacy->regions.front().takes.front().manifest["m1"]["tempoConformance"])
           == "not measured (version predates the check)");
}

TEST_CASE ("Lineage lives in the take manifest without mutating shared copies", "[reimagine][session][versions]")
{
    TransferRegion region;
    region.id = "r";
    region.sourceHash = "src";
    RenderTake a;
    a.id = "A";
    a.assetHash = "1234567890abcdef";
    a.seed = 100;
    a.manifest = juce::JSON::parse ("{\"backend\":\"mlx\"}");
    setLineage (a, { "int-1", {}, "candidate", false, false });
    auto copy = a;
    RenderTake b;
    b.id = "B";
    b.assetHash = "fedcba0987654321";
    setLineage (b, { "int-1", "A", "revision", false, false });
    region.takes = { a, b };

    auto kept = lineageOf (region.takes[0]);
    kept.kept = true;
    setLineage (region.takes[0], kept);
    CHECK (lineageOf (region.takes[0]).kept);
    CHECK_FALSE (lineageOf (copy).kept);                       // the earlier copy is untouched
    CHECK (region.takes[0].manifest["backend"].toString() == "mlx");

    CHECK (takeLabel (region, 0) == "v1 seed 100 - KEPT");
    CHECK (takeLabel (region, 1) == "v2 rev of v1");

    SessionContext ctx;
    ctx.bpm = 90.0;
    ctx.sectionLabel = "Verse 1/keys";
    region.ppqStart = 16.0;
    CHECK (exportFileName (region, region.takes[1], ctx, 4) == "Verse-1keys_bar5_90bpm_fedcba09.wav");
    const auto sidecar = exportSidecar (region, region.takes[1], ctx, 44100.0, 44100 * 4, 4);
    CHECK (sidecar["hostPlacement"].toString() == "unobserved");
    CHECK (static_cast<double> (sidecar["seconds"]) == Catch::Approx (4.0));
    CHECK (static_cast<double> (sidecar["startBar"]) == Catch::Approx (5.0));
    CHECK (sidecar["lineage"]["parentTakeId"].toString() == "A");
}

TEST_CASE ("Experience log appends one JSON object per line and tags the signal", "[reimagine][session][log]")
{
    const auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                         .getNonexistentChildFile ("mosh-experience", "", false);
    const ExperienceLog log (dir.getChildFile ("nested/experience.jsonl"));
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("takeId", "A");
    REQUIRE (log.append ("version.kept", "explicit", "inst-1", juce::var (payload)));
    REQUIRE (log.append ("version.exported", "implicit", "inst-1", {}));
    juce::StringArray lines;
    lines.addLines (log.file().loadFileAsString());
    lines.removeEmptyStrings();
    REQUIRE (lines.size() == 2);
    const auto first = juce::JSON::parse (lines[0]);
    CHECK (first["event"].toString() == "version.kept");
    CHECK (first["signal"].toString() == "explicit");
    CHECK (first["payload"]["takeId"].toString() == "A");
    CHECK (juce::JSON::parse (lines[1])["signal"].toString() == "implicit");
    dir.deleteRecursively();
}

TEST_CASE ("Plugin state carries region context and intentions additively", "[reimagine][session][state]")
{
    PluginStateV1 state;
    TransferRegion region;
    region.id = "r";
    region.sourceHash = "src";
    SessionContext c;
    c.key = "F minor";
    c.keyFrom = Provenance::user;
    region.context = contextToVar (c);
    state.regions.push_back (region);
    IntentionRecord i;
    i.id = "int-1";
    i.attempts = 3;
    state.intentions.add (intentionToVar (i));

    const auto back = deserializeState (serializeState (state));
    REQUIRE (back.has_value());
    CHECK (contextFromVar (back->regions.front().context).key == "F minor");
    REQUIRE (back->intentions.size() == 1);
    CHECK (intentionFromVar (back->intentions[0]).attempts == 3);

    // A state written before M1 has neither field and still loads.
    const auto legacy = deserializeState ("{\"schemaVersion\": 1, \"regions\": [{\"id\": \"r\", \"takes\": []}]}");
    REQUIRE (legacy.has_value());
    CHECK (legacy->intentions.isEmpty());
    CHECK (legacy->regions.front().context.isVoid());
}

namespace
{
TempoConformanceReport drifting (double sessionBpm, double measuredBpm)
{
    TempoConformanceReport r;
    r.verdict = TempoVerdict::drifts;
    r.sessionBpm = sessionBpm;
    r.bpmFrom = Provenance::host;
    r.estimatedBpm = measuredBpm;
    r.beatsPerBar = 4.0;
    r.driftMsPerBar = (60.0 / measuredBpm - 60.0 / sessionBpm) * 4.0 * 1000.0;
    return r;
}

juce::AudioBuffer<float> stereoOf (const std::vector<float>& mono)
{
    juce::AudioBuffer<float> b (2, static_cast<int> (mono.size()));
    for (int c = 0; c < 2; ++c)
        b.copyFrom (c, 0, mono.data(), static_cast<int> (mono.size()));
    return b;
}
}

TEST_CASE ("Conform ratio: measured BPM over session BPM, within +-8%", "[reimagine][session][conform]")
{
    const auto session = hostTempo (120.0);
    const auto faster = planConform (drifting (120.0, 121.0), session);
    REQUIRE (faster.allowed);
    CHECK (faster.stretchRatio == Catch::Approx (121.0 / 120.0));   // longer: slows 121 to 120
    CHECK (faster.fromBpm == Catch::Approx (121.0));
    CHECK (faster.toBpm == Catch::Approx (120.0));
    CHECK (faster.driftMsPerBar == Catch::Approx (-16.53).margin (0.05));

    const auto slower = planConform (drifting (120.0, 115.0), session);
    REQUIRE (slower.allowed);
    CHECK (slower.stretchRatio == Catch::Approx (115.0 / 120.0));   // shorter: speeds 115 up to 120

    // The bound is inclusive at 8% and refuses beyond it, either way.
    CHECK (planConform (drifting (120.0, 129.6), session).allowed);
    const auto tooFar = planConform (drifting (120.0, 130.0), session);
    CHECK_FALSE (tooFar.allowed);
    CHECK (tooFar.stretchRatio == 1.0);
    CHECK (tooFar.refusal.contains ("limit +-8%"));
    CHECK_FALSE (planConform (drifting (120.0, 110.0), session).allowed);

    const auto stored = conformPlanToVar (faster);
    CHECK (static_cast<double> (stored["stretchRatio"]) == Catch::Approx (121.0 / 120.0));
    CHECK (stored["kind"].toString().contains ("timing only"));
    CHECK (stored["refusal"].isVoid());
}

TEST_CASE ("Conform refuses without a trustworthy tempo or a measurable drift", "[reimagine][session][conform]")
{
    const auto drift = drifting (120.0, 121.0);

    auto assumed = hostTempo (120.0);
    assumed.tempoAssumed = true;
    CHECK (planConform (drift, assumed).refusal.contains ("assumed"));
    CHECK (conformContextRefusal (assumed).contains ("assumed"));

    auto unproven = hostTempo (120.0);
    unproven.bpmFrom = Provenance::unknown;
    CHECK (planConform (drift, unproven).refusal == "session BPM provenance unknown");

    SessionContext unknown;
    CHECK (planConform (drift, unknown).refusal == "session BPM unknown");
    CHECK (conformContextRefusal (hostTempo (120.0)).isEmpty());

    // A user-set BPM is acceptable provenance.
    auto userBpm = hostTempo (120.0);
    userBpm.bpmFrom = Provenance::user;
    CHECK (planConform (drift, userBpm).allowed);

    TempoConformanceReport undetermined;
    undetermined.reason = "no clear periodic pulse";
    const auto noPulse = planConform (undetermined, hostTempo (120.0));
    CHECK_FALSE (noPulse.allowed);
    CHECK (noPulse.refusal.contains ("undetermined (no clear periodic pulse)"));

    auto conforms = drifting (120.0, 120.05);
    conforms.verdict = TempoVerdict::conforms;
    CHECK (planConform (conforms, hostTempo (120.0)).refusal.contains ("already conforms"));

    // Measured against 121 but the session is now 120: measure again, never stretch blind.
    CHECK (planConform (drifting (121.0, 122.0), hostTempo (120.0)).refusal.contains ("different session BPM"));

    // Real audio: an assumed tempo map stays undetermined, so conform refuses it.
    auto assumedReal = hostTempo (120.0);
    assumedReal.tempoAssumed = true;
    const auto measured = conformanceOf (clickTrack (121.0, 121.0, 16.0, 48000.0), 48000.0, assumedReal);
    CHECK_FALSE (planConform (measured, assumedReal).allowed);
}

TEST_CASE ("Conform: a 121 BPM click stretched to a 120 BPM session now conforms", "[reimagine][session][conform][tempo-conformance]")
{
    for (const auto rate : { 48000.0, 44100.0 })
        for (const auto takeBpm : { 121.0, 118.0, 126.0 })
        {
            CAPTURE (rate, takeBpm);
            const auto session = hostTempo (120.0);
            const auto click = clickTrack (takeBpm, takeBpm, 16.0, rate, 0.0137);
            const auto before = conformanceOf (click, rate, session);
            REQUIRE (before.verdict == TempoVerdict::drifts);
            const auto plan = planConform (before, session);
            REQUIRE (plan.allowed);
            CHECK (plan.stretchRatio == Catch::Approx (takeBpm / 120.0).margin (0.001));

            const auto input = stereoOf (click);
            juce::AudioBuffer<float> output;
            juce::String error;
            REQUIRE (stretchForConform (input, rate, plan.stretchRatio, output, error));
            CHECK (error.isEmpty());
            CHECK (output.getNumChannels() == 2);
            CHECK (output.getNumSamples() == static_cast<int> (std::llround (click.size() * plan.stretchRatio)));

            const auto after = checkTempoConformance (output.getArrayOfReadPointers(), 2, output.getNumSamples(), rate, session);
            CHECK (after.verdict == TempoVerdict::conforms);
            REQUIRE (after.estimatedBpm.has_value());
            CHECK (*after.estimatedBpm == Catch::Approx (120.0).margin (0.15));
            // The original buffer is untouched (a conform makes a new version).
            CHECK (input.getSample (0, static_cast<int> (std::llround (0.0137 * rate)) + 10) == click[static_cast<size_t> (std::llround (0.0137 * rate)) + 10]);
        }

    juce::AudioBuffer<float> out;
    juce::String error;
    CHECK_FALSE (stretchForConform (juce::AudioBuffer<float> (2, 0), 48000.0, 1.01, out, error));
    CHECK_FALSE (stretchForConform (stereoOf (sine (4800, 0.5f)), 48000.0, std::numeric_limits<double>::quiet_NaN(), out, error));
}

TEST_CASE ("Conform lineage is stored on the new version and states round-trip", "[reimagine][session][conform][state]")
{
    PluginStateV1 state;
    TransferRegion region;
    region.id = "r";
    region.sourceHash = "src";
    RenderTake parent;
    parent.id = "P";
    parent.assetHash = juce::String::repeatedString ("a", 64);
    parent.seed = 7;
    setLineage (parent, { "int-1", {}, "candidate", true, false });
    // A non-conform take gets no conform keys at all.
    CHECK_FALSE (parent.manifest["m1"].getDynamicObject()->hasProperty ("conformedFrom"));
    CHECK_FALSE (parent.manifest["m1"].getDynamicObject()->hasProperty ("stretchRatio"));

    RenderTake conformed;
    conformed.id = "C";
    conformed.assetHash = juce::String::repeatedString ("b", 64);
    conformed.manifest = parent.manifest.clone();
    auto lineage = lineageOf (parent);
    lineage.parentTakeId = "P";
    lineage.role = "conform";
    lineage.kept = false;
    lineage.conformedFrom = "P";
    lineage.stretchRatio = 121.0 / 120.0;
    setLineage (conformed, lineage);
    region.takes = { parent, conformed };
    state.regions.push_back (region);

    CHECK (lineageOf (region.takes[0]).kept);                   // the parent is untouched
    CHECK (lineageOf (region.takes[0]).role == "candidate");
    CHECK (takeLabel (region, 1) == "v2 conform of v1 x1.0083");

    const auto back = deserializeState (serializeState (state));
    REQUIRE (back.has_value());
    REQUIRE (back->regions.front().takes.size() == 2);
    const auto restored = lineageOf (back->regions.front().takes[1]);
    CHECK (restored.role == "conform");
    CHECK (restored.parentTakeId == "P");
    CHECK (restored.conformedFrom == "P");
    REQUIRE (restored.stretchRatio.has_value());
    CHECK (*restored.stretchRatio == Catch::Approx (121.0 / 120.0));
    CHECK (restored.intentionId == "int-1");
    CHECK_FALSE (restored.kept);

    // A state saved before conform existed loads with no conform lineage.
    const auto legacy = deserializeState (
        "{\"schemaVersion\": 1, \"regions\": [{\"id\": \"r\", \"takes\": [{\"id\": \"t\", \"assetHash\": \"x\", "
        "\"manifest\": {\"m1\": {\"intentionId\": \"int-1\", \"role\": \"revision\", \"parentTakeId\": \"q\"}}}]}]}");
    REQUIRE (legacy.has_value());
    const auto old = lineageOf (legacy->regions.front().takes.front());
    CHECK (old.conformedFrom.isEmpty());
    CHECK_FALSE (old.stretchRatio.has_value());
    CHECK (old.role == "revision");
}

TEST_CASE ("Free audition: starts only with a version and never alongside host-synced playback", "[reimagine][session][audition]")
{
    FreeAudition a;
    CHECK_FALSE (a.playing());
    CHECK (a.lastStop() == AuditionStop::none);
    CHECK (a.advance (512, 48000, false).count == 0);           // idle outputs nothing

    CHECK (a.start (false, false) == FreeAudition::StartResult::noVersion);
    CHECK (a.start (true, true) == FreeAudition::StartResult::hostSyncedActive);
    CHECK_FALSE (a.playing());

    REQUIRE (a.start (true, false) == FreeAudition::StartResult::started);
    CHECK (a.playing());
    auto block = a.advance (512, 1200, false);
    CHECK (block.start == 0);
    CHECK (block.count == 512);
    block = a.advance (512, 1200, false);
    CHECK (block.start == 512);
    CHECK (block.count == 512);
    block = a.advance (512, 1200, false);                        // the tail, then it finishes
    CHECK (block.start == 1024);
    CHECK (block.count == 176);
    CHECK_FALSE (a.playing());
    CHECK (a.lastStop() == AuditionStop::finished);
    CHECK (a.advance (512, 1200, false).count == 0);

    // The host starting playback stops the preview in that very block: never two copies.
    REQUIRE (a.start (true, false) == FreeAudition::StartResult::started);
    CHECK (a.position() == 0);
    CHECK (a.advance (256, 48000, false).count == 256);
    CHECK (a.advance (256, 48000, true).count == 0);
    CHECK_FALSE (a.playing());
    CHECK (a.lastStop() == AuditionStop::hostTookOver);
    CHECK (auditionStopName (a.lastStop()).contains ("host"));

    // A user stop, a selection change and missing audio each stop it with their reason.
    REQUIRE (a.start (true, false) == FreeAudition::StartResult::started);
    a.stop();
    CHECK (a.lastStop() == AuditionStop::user);
    REQUIRE (a.start (true, false) == FreeAudition::StartResult::started);
    a.stop (AuditionStop::selectionChanged);
    CHECK (a.lastStop() == AuditionStop::selectionChanged);
    a.stop (AuditionStop::user);                                  // stopping when stopped keeps the reason
    CHECK (a.lastStop() == AuditionStop::selectionChanged);
    REQUIRE (a.start (true, false) == FreeAudition::StartResult::started);
    CHECK (a.lastStop() == AuditionStop::none);
    CHECK (a.advance (256, 0, false).count == 0);
    CHECK (a.lastStop() == AuditionStop::nothingLoaded);
}
