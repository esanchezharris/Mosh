#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

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
    CHECK (r.prompt.contains ("chords Fm7 Db Ab Eb"));
    CHECK (r.seeds == std::vector<int64_t> { 100, 101 });
    CHECK (r.durationSeconds == Catch::Approx (21.333).margin (0.001));
    CHECK (r.templateVersion == kTransformTemplateVersion);

    bool sawChords = false, sawProtected = false;
    for (const auto& entry : r.conditioning)
    {
        if (entry.field == "chords")
        {
            sawChords = true;
            CHECK (entry.sentAs == "text-prompt");
            CHECK_FALSE (entry.enforced);
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
