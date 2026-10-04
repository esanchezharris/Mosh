// Track-chain presets — the engine-free half: schema validation, the pinned processor
// table, and the unit adapter. See src/moshops/TrackPreset.h and
// docs/vocal-presets/AUDIT-2026-10-01.md. The engine-linked half (the table really does
// match the pinned Tracktion plugins; applying really is one undo step; the DSP really
// does what the numbers say) lives in src/app/selftest/VocalPresetSelfTest.cpp.
#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "moshops/TrackPreset.h"

using namespace mosh::trackpreset;
using Catch::Approx;

namespace
{
    // A valid schema-1 document, as a mutable tree: each rejection case below breaks
    // exactly ONE thing, so a failure names the rule rather than "something was wrong".
    juce::var validDoc()
    {
        return juce::JSON::parse (R"json({
          "kind": "mosh.track-chain", "schema": 1,
          "id": "mosh.test-chain", "revision": 3, "name": "Test Chain",
          "provenance": { "origin": "original" },
          "validation": { "listening": "not-run" },
          "target": { "trackType": "audio" },
          "stages": [
            { "processor": "lowpass", "state": { "mode": "highpass" }, "bypassed": false,
              "params": { "frequency": { "value": 80, "unit": "Hz" } } },
            { "processor": "compressor", "state": { "sidechainTrigger": false }, "bypassed": true,
              "params": {
                "threshold":   { "value": -24,  "unit": "dB" },
                "ratio":       { "value": 2.5,  "unit": ":1" },
                "attack":      { "value": 20,   "unit": "ms" },
                "release":     { "value": 150,  "unit": "ms" },
                "output gain": { "value": 0,    "unit": "dB" },
                "input gain":  { "value": 0,    "unit": "dB" } } }
          ] })json");
    }

    juce::DynamicObject& obj (const juce::var& v)
    {
        auto* o = v.getDynamicObject();
        REQUIRE (o != nullptr);
        return *o;
    }

    juce::var stage (const juce::var& doc, int index)   { return doc["stages"][index]; }

    const ParamSpec& comp (const char* id)
    {
        auto* p = findParam (*findProcessor ("compressor"), id);
        REQUIRE (p != nullptr);
        return *p;
    }
}

TEST_CASE ("a valid track-chain preset parses to stages in file order with native values resolved", "[track-preset]")
{
    const auto r = parseTrackPreset (validDoc());
    INFO (r.error);
    REQUIRE (r.ok);
    CHECK (r.preset.id == "mosh.test-chain");
    CHECK (r.preset.revision == 3);
    CHECK (r.preset.name == "Test Chain");
    CHECK (r.preset.targetTrackType == "audio");
    REQUIRE (r.preset.stages.size() == 2);

    const auto& hpf = r.preset.stages[0];
    CHECK (juce::String (hpf.processor->type) == "lowpass");
    CHECK_FALSE (hpf.bypassed);
    REQUIRE (hpf.params.size() == 1);
    CHECK (hpf.params[0].native == 80.0f);
    REQUIRE (hpf.state.size() == 1);
    CHECK (hpf.state[0].value.toString() == "highpass");

    const auto& c = r.preset.stages[1];
    CHECK (juce::String (c.processor->type) == "compressor");
    CHECK (c.bypassed);
    REQUIRE (c.params.size() == 6);
    // Parameters come back in the ENGINE's order, not the file's — the state builder
    // and the readback both walk this vector.
    CHECK (juce::String (c.params[0].spec->id) == "threshold");
    CHECK (c.params[0].native == Approx (0.0630957).epsilon (1e-5));   // -24 dB as linear gain
    CHECK (juce::String (c.params[1].spec->id) == "ratio");
    CHECK (c.params[1].native == Approx (0.4f));                       // 2.5:1 as slope
    CHECK (c.params[2].native == 20.0f);
    CHECK (c.params[3].native == 150.0f);
    CHECK (juce::String (c.params[4].spec->id) == "output gain");
    CHECK (juce::String (c.params[4].spec->stateProp) == "outputDb");
    CHECK (c.params[4].native == 0.0f);
    CHECK (juce::String (c.params[5].spec->stateProp) == "inputDb");
    REQUIRE (c.state.size() == 1);
    CHECK (c.state[0].value.isBool());
    CHECK_FALSE ((bool) c.state[0].value);
}

TEST_CASE ("the compressor threshold is stored as linear gain: dB endpoints land on the range, beyond them fails", "[track-preset][units]")
{
    const auto& t = comp ("threshold");
    auto top = toNative (t, 0.0);
    REQUIRE (top.ok);
    CHECK (top.native == 1.0f);

    auto bottom = toNative (t, -40.0);
    REQUIRE (bottom.ok);
    CHECK (bottom.native == 0.01f);              // exactly the parameter's minimum

    CHECK_FALSE (toNative (t, -40.1).ok);        // below the range: an error, NOT clamped to 0.01
    CHECK_FALSE (toNative (t, 0.1).ok);          // above unity gain
    CHECK (toNative (t, -40.1).error.contains ("outside"));

    CHECK (toNative (t, -6.0).native == Approx (0.5011872f).epsilon (1e-6));
    CHECK (toCanonical (t, toNative (t, -18.0).native) == Approx (-18.0).margin (1e-4));
}

TEST_CASE ("the compressor ratio is stored as the reciprocal slope: higher ratio means a SMALLER number", "[track-preset][units]")
{
    const auto& r = comp ("ratio");
    CHECK (toNative (r, 2.0).native == 0.5f);
    CHECK (toNative (r, 4.0).native == 0.25f);
    CHECK (toNative (r, 20.0).native == Approx (0.05f));
    // The trap the 2026-09-06 calibration fell into: a stored 0.76 is 1.3:1, not "76%".
    CHECK (toCanonical (r, 0.76f) == Approx (1.3158).epsilon (1e-4));

    // The parameter's ceiling is slope 0.95 (1.0526:1). 1:1 is unrepresentable.
    auto gentlest = toNative (r, 1.0 / 0.95);
    REQUIRE (gentlest.ok);
    CHECK (gentlest.native == 0.95f);
    CHECK_FALSE (toNative (r, 1.0).ok);
    CHECK_FALSE (toNative (r, 1.05).ok);

    CHECK_FALSE (toNative (r, 0.0).ok);          // 1/0
    CHECK_FALSE (toNative (r, -2.0).ok);
    CHECK_FALSE (toNative (r, std::numeric_limits<double>::infinity()).ok);
    CHECK_FALSE (toNative (r, std::numeric_limits<double>::quiet_NaN()).ok);

    CHECK (std::isinf (toCanonical (r, 0.0f)));  // slope 0 reads back as an infinite ratio
}

TEST_CASE ("identity-encoded parameters keep their unit and reject values outside the engine range", "[track-preset][units]")
{
    const auto& freq = *findParam (*findProcessor ("lowpass"), "frequency");
    CHECK (toNative (freq, 10.0).native == 10.0f);
    CHECK (toNative (freq, 22000.0).native == 22000.0f);
    CHECK_FALSE (toNative (freq, 9.9).ok);
    CHECK_FALSE (toNative (freq, 22000.5).ok);

    CHECK (toNative (comp ("attack"), 0.3).ok);
    CHECK_FALSE (toNative (comp ("attack"), 0.2).ok);
    CHECK_FALSE (toNative (comp ("release"), 301.0).ok);
    CHECK (toNative (comp ("output gain"), -10.0).ok);
    CHECK (toNative (comp ("output gain"), 24.0).ok);
    CHECK_FALSE (toNative (comp ("output gain"), 24.5).ok);
    CHECK (toCanonical (comp ("release"), 150.0f) == 150.0);
}

TEST_CASE ("schema 1 is strict: every malformed or unsupported document is rejected with a reason", "[track-preset][schema]")
{
    SECTION ("not JSON at all")
    {
        const auto r = parseTrackPresetText ("{ this is not json");
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("not valid JSON"));
    }
    SECTION ("valid JSON that is not an object")
    {
        CHECK_FALSE (parseTrackPresetText ("[1, 2, 3]").ok);
        CHECK_FALSE (parseTrackPresetText ("42").ok);
    }
    SECTION ("a 4OSC instrument patch is not a track-chain preset")
    {
        const auto r = parseTrackPresetText (R"({"waveShapes":[3,3,0,0],"params":{"Level 1":0.8}})");
        CHECK_FALSE (r.ok);
    }
    SECTION ("wrong kind")
    {
        auto d = validDoc(); obj (d).setProperty ("kind", "mosh.other");
        const auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("kind"));
    }
    SECTION ("a newer schema is refused rather than half-read")
    {
        auto d = validDoc(); obj (d).setProperty ("schema", 2);
        const auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("schema"));

        // 2^32 + 1 truncates to 1 as a 32-bit int; it must not pass as schema 1.
        CHECK_FALSE (parseTrackPresetText (juce::JSON::toString (validDoc())
                                               .replace ("\"schema\": 1", "\"schema\": 4294967297")).ok);
        d = validDoc(); obj (d).setProperty ("schema", (juce::int64) 4294967297LL);
        CHECK_FALSE (parseTrackPreset (d).ok);
        d = validDoc(); obj (d).setProperty ("schema", 1.0);        // a whole-number double is still schema 1
        CHECK (parseTrackPreset (d).ok);
    }
    SECTION ("a pathologically nested document is refused before the parser recurses into it")
    {
        const auto r = parseTrackPresetText (juce::String::repeatedString ("[", 5000));
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("nested too deeply"));
        // Brackets inside strings do not count, and a real preset is well inside the limit.
        CHECK (detail::maxNestingDepth (R"({"a":"[[[[[[[[[[[[[[[[[[[[","b":[{"c":[1]}]})") == 4);
        CHECK (detail::maxNestingDepth (R"({"a":"a \"quoted\" [[[[ bracket"})") == 1);
        CHECK (detail::maxNestingDepth (juce::JSON::toString (validDoc())) <= 5);
        CHECK (parseTrackPresetText (juce::JSON::toString (validDoc())).ok);
    }
    SECTION ("unknown top-level key")
    {
        auto d = validDoc(); obj (d).setProperty ("macros", juce::var (juce::Array<juce::var>()));
        const auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("macros"));
    }
    SECTION ("missing top-level key")
    {
        auto d = validDoc(); obj (d).removeProperty ("provenance");
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
    SECTION ("bad id / revision / name / target")
    {
        auto d = validDoc(); obj (d).setProperty ("id", "Has Spaces");
        CHECK_FALSE (parseTrackPreset (d).ok);
        d = validDoc(); obj (d).setProperty ("id", "");
        CHECK_FALSE (parseTrackPreset (d).ok);
        d = validDoc(); obj (d).setProperty ("revision", -1);
        CHECK_FALSE (parseTrackPreset (d).ok);
        d = validDoc(); obj (d).setProperty ("revision", 1.5);
        CHECK_FALSE (parseTrackPreset (d).ok);
        d = validDoc(); obj (d).setProperty ("name", "   ");
        CHECK_FALSE (parseTrackPreset (d).ok);
        d = validDoc(); obj (d["target"]).setProperty ("trackType", "drum");
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
    SECTION ("no stages / too many stages")
    {
        auto d = validDoc(); obj (d).setProperty ("stages", juce::var (juce::Array<juce::var>()));
        CHECK_FALSE (parseTrackPreset (d).ok);

        d = validDoc();
        juce::Array<juce::var> many;
        for (int i = 0; i < kMaxStages + 1; ++i) many.add (stage (validDoc(), 0));
        obj (d).setProperty ("stages", many);
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
    SECTION ("an unsupported processor is named, not substituted")
    {
        auto d = validDoc(); obj (stage (d, 0)).setProperty ("processor", "DeEss");
        const auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("DeEss"));

        // Registered in the engine, but not qualified into the table: still refused.
        d = validDoc(); obj (stage (d, 0)).setProperty ("processor", "reverb");
        CHECK_FALSE (parseTrackPreset (d).ok);
        // The Mosh alias is not an engine type id either.
        d = validDoc(); obj (stage (d, 0)).setProperty ("processor", "highpass");
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
    SECTION ("an unknown parameter id is rejected")
    {
        auto d = validDoc();
        obj (stage (d, 1)["params"]).setProperty ("knee", obj (stage (d, 1)["params"]).getProperty ("attack"));
        const auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("knee"));
    }
    SECTION ("a missing parameter is rejected — a preset must pin every parameter")
    {
        auto d = validDoc(); obj (stage (d, 1)["params"]).removeProperty ("input gain");
        const auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("input gain"));
    }
    SECTION ("a wrong or missing unit is rejected — a bare number is ambiguous")
    {
        auto d = validDoc(); obj (stage (d, 1)["params"]["threshold"]).setProperty ("unit", "gain");
        auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("dB"));

        d = validDoc(); obj (stage (d, 1)["params"]["threshold"]).removeProperty ("unit");
        CHECK_FALSE (parseTrackPreset (d).ok);

        // A normalized 0..1 copy alongside the canonical value is not allowed.
        d = validDoc(); obj (stage (d, 1)["params"]["threshold"]).setProperty ("normalized", 0.1);
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
    SECTION ("a non-numeric or out-of-range value is rejected, never clamped")
    {
        auto d = validDoc(); obj (stage (d, 1)["params"]["threshold"]).setProperty ("value", "-24");
        CHECK_FALSE (parseTrackPreset (d).ok);

        d = validDoc(); obj (stage (d, 1)["params"]["threshold"]).setProperty ("value", -60);
        auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("threshold"));

        d = validDoc(); obj (stage (d, 1)["params"]["ratio"]).setProperty ("value", 1.0);
        CHECK_FALSE (parseTrackPreset (d).ok);

        d = validDoc(); obj (stage (d, 0)["params"]["frequency"]).setProperty ("value", 5);
        CHECK_FALSE (parseTrackPreset (d).ok);

        d = validDoc();
        obj (stage (d, 1)["params"]["attack"]).setProperty ("value", std::numeric_limits<double>::quiet_NaN());
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
    SECTION ("typed state is required and checked")
    {
        auto d = validDoc(); obj (stage (d, 0)["state"]).setProperty ("mode", "bandpass");
        auto r = parseTrackPreset (d);
        CHECK_FALSE (r.ok);
        CHECK (r.error.contains ("mode"));

        d = validDoc(); obj (stage (d, 0)["state"]).removeProperty ("mode");
        CHECK_FALSE (parseTrackPreset (d).ok);

        d = validDoc(); obj (stage (d, 1)["state"]).setProperty ("sidechainTrigger", "no");
        CHECK_FALSE (parseTrackPreset (d).ok);

        d = validDoc(); obj (stage (d, 0)["state"]).setProperty ("slope", 24);
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
    SECTION ("bypass must be an explicit boolean")
    {
        auto d = validDoc(); obj (stage (d, 0)).setProperty ("bypassed", 0);
        CHECK_FALSE (parseTrackPreset (d).ok);
        d = validDoc(); obj (stage (d, 0)).removeProperty ("bypassed");
        CHECK_FALSE (parseTrackPreset (d).ok);
    }
}

TEST_CASE ("the bundled Mosh Clean Lead v0 preset is a valid, dry, two-stage original chain", "[track-preset][bundled]")
{
    // WORKING_DIRECTORY is the repo root for the MoshTests ctest entry, the same
    // resolution test_multiplayer_lock_manager.cpp's ledger test relies on.
    const auto file = juce::File::getCurrentWorkingDirectory()
                          .getChildFile ("resources/presets/track-chain/mosh-clean-lead-v0.json");
    REQUIRE (file.existsAsFile());

    const auto r = parseTrackPresetText (file.loadFileAsString());
    INFO (r.error);
    REQUIRE (r.ok);
    CHECK (r.preset.id == "mosh.clean-lead");
    CHECK (r.preset.name == "Mosh Clean Lead v0");
    CHECK (r.preset.revision == 0);

    REQUIRE (r.preset.stages.size() == 2);
    const auto& hpf = r.preset.stages[0];
    CHECK (juce::String (hpf.processor->type) == "lowpass");
    CHECK (hpf.state[0].value.toString() == "highpass");
    CHECK_FALSE (hpf.bypassed);
    CHECK (hpf.params[0].native == 80.0f);

    const auto& c = r.preset.stages[1];
    CHECK (juce::String (c.processor->type) == "compressor");
    CHECK_FALSE (c.bypassed);
    CHECK_FALSE ((bool) c.state[0].value);          // no sidechain trigger
    // Conservative by construction: a gentle ratio and no gain stage that adds level.
    // (That is a statement about gain, not peaks: a high-pass rotates phase and can move
    // a waveform's peak either way, which the audition report measures per recording.)
    CHECK (toCanonical (*c.params[1].spec, c.params[1].native) <= 4.0);
    CHECK (c.params[4].native <= 0.0f);              // output gain: no makeup
    CHECK (c.params[5].native == 0.0f);              // input (sidechain) gain untouched

    // Provenance and status travel with the file and must not overclaim.
    CHECK (r.preset.provenance["origin"].toString() == "original");
    CHECK (r.preset.validation["listening"].toString() == "not-run");
}

// ── Mosh AutoTune as a preset stage (docs/AUTOTUNE-SCOPE-2026-10-01.md section 8) ─────
namespace
{
    juce::var autoTuneStage()
    {
        return juce::JSON::parse (R"json({
          "processor": "moshAutoTune", "state": {}, "bypassed": false,
          "params": {
            "root":      { "value": 9,   "unit": "semitones above C" },
            "scale":     { "value": 2,   "unit": "scale index" },
            "retune":    { "value": 5,   "unit": "ms" },
            "amount":    { "value": 75,  "unit": "%" },
            "range":     { "value": 200, "unit": "cents" },
            "mix":       { "value": 50,  "unit": "%" },
            "output":    { "value": -3,  "unit": "dB" },
            "glide":     { "value": 25,  "unit": "%" },
            "lookahead": { "value": 12,  "unit": "ms" } } })json");
    }

    juce::var docWithStage (const juce::var& stageVar)
    {
        auto doc = validDoc();
        doc["stages"].getArray()->clearQuick();
        doc["stages"].getArray()->add (stageVar);
        return doc;
    }

    ParseResult withAutoTuneParam (const char* id, double value)
    {
        auto s = autoTuneStage();
        obj (s["params"][id]).setProperty ("value", value);
        return parseTrackPreset (docWithStage (s));
    }
}

TEST_CASE ("an AutoTune stage parses: percentages become fractions, choices stay whole", "[track-preset][autotune]")
{
    const auto r = parseTrackPreset (docWithStage (autoTuneStage()));
    INFO (r.error);
    REQUIRE (r.ok);
    REQUIRE (r.preset.stages.size() == 1);
    const auto& stage = r.preset.stages[0];
    CHECK (juce::String (stage.processor->type) == "moshAutoTune");
    CHECK (stage.state.empty());
    REQUIRE (stage.params.size() == 9);

    // In the plugin's own parameter order, each under the property the plugin saves it as.
    const char* ids[] = { "root", "scale", "retune", "amount", "range", "mix", "output", "glide", "lookahead" };
    const float natives[] = { 9.0f, 2.0f, 5.0f, 0.75f, 200.0f, 0.5f, -3.0f, 0.25f, 12.0f };
    for (int i = 0; i < 9; ++i)
    {
        INFO (ids[i]);
        CHECK (juce::String (stage.params[(size_t) i].spec->id) == ids[i]);
        CHECK (stage.params[(size_t) i].native == Approx (natives[i]));
        CHECK (juce::String (stage.params[(size_t) i].spec->stateProp).startsWith ("moshAutoTune"));
    }
    // Readback converts the other way.
    CHECK (toCanonical (*stage.params[3].spec, 0.75f) == Approx (75.0));
    CHECK (toCanonical (*stage.params[0].spec, 9.0f) == Approx (9.0));
}

TEST_CASE ("an AutoTune stage is as strict as the rest of schema 1", "[track-preset][autotune]")
{
    // A choice cannot be fractional: there is no note between A and A#.
    CHECK_FALSE (withAutoTuneParam ("root", 9.5).ok);
    CHECK_FALSE (withAutoTuneParam ("scale", 1.5).ok);
    CHECK (withAutoTuneParam ("root", 11).ok);
    CHECK_FALSE (withAutoTuneParam ("root", 12).ok);
    CHECK_FALSE (withAutoTuneParam ("scale", 3).ok);

    // Ranges are the plugin's, in the file's units.
    CHECK_FALSE (withAutoTuneParam ("amount", 101).ok);
    CHECK_FALSE (withAutoTuneParam ("glide", -1).ok);
    CHECK_FALSE (withAutoTuneParam ("retune", 4).ok);
    CHECK_FALSE (withAutoTuneParam ("lookahead", 12.5).ok);
    CHECK (withAutoTuneParam ("lookahead", 0).ok);

    // Every parameter is required, in its own unit, and no typed state is accepted.
    {
        auto s = autoTuneStage();
        obj (s["params"]).removeProperty ("glide");
        CHECK_FALSE (parseTrackPreset (docWithStage (s)).ok);
    }
    {
        auto s = autoTuneStage();
        obj (s["params"]["amount"]).setProperty ("unit", "ratio");
        CHECK_FALSE (parseTrackPreset (docWithStage (s)).ok);
    }
    {
        auto s = autoTuneStage();
        obj (s["state"]).setProperty ("mode", "highpass");
        CHECK_FALSE (parseTrackPreset (docWithStage (s)).ok);
    }
}

TEST_CASE ("the bundled Mosh Tuned Lead v0 preset is AutoTune ahead of the Clean Lead chain", "[track-preset][bundled][autotune]")
{
    const auto dir = juce::File::getCurrentWorkingDirectory().getChildFile ("resources/presets/track-chain");
    const auto tunedFile = dir.getChildFile ("mosh-tuned-lead-v0.json");
    const auto cleanFile = dir.getChildFile ("mosh-clean-lead-v0.json");
    REQUIRE (tunedFile.existsAsFile());
    REQUIRE (cleanFile.existsAsFile());

    const auto tuned = parseTrackPresetText (tunedFile.loadFileAsString());
    const auto clean = parseTrackPresetText (cleanFile.loadFileAsString());
    INFO (tuned.error);
    REQUIRE (tuned.ok);
    REQUIRE (clean.ok);
    CHECK (tuned.preset.id == "mosh.tuned-lead");
    CHECK (tuned.preset.id != clean.preset.id); // each preset owns its own tagged group
    CHECK (tuned.preset.name == "Mosh Tuned Lead v0");

    REQUIRE (tuned.preset.stages.size() == 3);
    const auto& tune = tuned.preset.stages[0];
    CHECK (juce::String (tune.processor->type) == "moshAutoTune"); // first: it hears the voice uncompressed
    CHECK_FALSE (tune.bypassed);
    auto native = [&tune] (const char* id)
    {
        for (const auto& p : tune.params)
            if (juce::String (p.spec->id) == id)
                return p.native;
        FAIL ("no such AutoTune parameter: " << id);
        return 0.0f;
    };
    CHECK (native ("scale") == 0.0f);     // chromatic: a preset cannot know the song's key
    CHECK (native ("lookahead") == 0.0f); // safe to sing through
    CHECK (native ("amount") == 1.0f);
    CHECK (native ("mix") == 1.0f);

    // The rest IS the Clean Lead chain: same processors, same values.
    REQUIRE (clean.preset.stages.size() == 2);
    for (size_t i = 0; i < 2; ++i)
    {
        const auto& a = tuned.preset.stages[i + 1];
        const auto& b = clean.preset.stages[i];
        CHECK (a.processor == b.processor);
        CHECK (a.bypassed == b.bypassed);
        REQUIRE (a.params.size() == b.params.size());
        for (size_t p = 0; p < a.params.size(); ++p)
            CHECK (a.params[p].native == b.params[p].native);
        REQUIRE (a.state.size() == b.state.size());
        for (size_t st = 0; st < a.state.size(); ++st)
            CHECK (a.state[st].value == b.state[st].value);
    }

    CHECK (tuned.preset.provenance["origin"].toString() == "original");
    CHECK (tuned.preset.validation["listening"].toString() == "not-run");
}
