// MoshIR vocabulary lockstep (phase0 §3): the C++ executor's closed op list
// (src/moshir/MoshIRVocab.h) must match moshir/moshir-0.2.schema.json exactly —
// same kinds, same order. The Python side validates against the schema file,
// the executor validates against the header; this test is what stops them
// drifting apart silently. MOSH_MOSHIR_DIR is injected by CMake.

#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>
#include "moshir/MoshIRVocab.h"

using namespace juce;

static var loadJson (const String& name)
{
    File f = File (MOSH_MOSHIR_DIR).getChildFile (name);
    REQUIRE (f.existsAsFile());
    auto parsed = JSON::parse (f.loadFileAsString());
    REQUIRE (! parsed.isVoid());
    return parsed;
}

static StringArray schemaKinds()
{
    auto schema = loadJson ("moshir-0.2.schema.json");
    auto oneOf = schema["$defs"]["op"]["oneOf"];
    REQUIRE (oneOf.isArray());
    StringArray kinds;
    for (auto& ref : *oneOf.getArray())
    {
        auto r = ref.getProperty ("$ref", var()).toString();
        kinds.add (r.fromLastOccurrenceOf ("/", false, false));
    }
    return kinds;
}

TEST_CASE ("MoshIR vocabulary: schema and executor are in lockstep", "[moshir]")
{
    auto fromSchema = schemaKinds();
    REQUIRE (fromSchema.size() == mosh::ir::kNumOpKinds);
    for (int i = 0; i < mosh::ir::kNumOpKinds; ++i)
        CHECK (fromSchema[i] == String (mosh::ir::kOpKinds[i]));
}

TEST_CASE ("MoshIR fixtures: full coverage uses only (and all of) the vocabulary", "[moshir]")
{
    auto ops = loadJson ("fixtures/valid_full_coverage.json");
    REQUIRE (ops.isArray());

    StringArray vocab;
    for (auto* k : mosh::ir::kOpKinds) vocab.add (k);

    StringArray seen;
    for (auto& op : *ops.getArray())
    {
        const auto kind = op.getProperty ("kind", var()).toString();
        CHECK (vocab.contains (kind));
        seen.addIfNotAlreadyThere (kind);
    }
    for (const auto& k : vocab)
        CHECK (seen.contains (k));     // every op kind exercised at least once
}

TEST_CASE ("MoshIR fixtures: the spec 3.5 worked example parses with 7 ops", "[moshir]")
{
    auto step = loadJson ("fixtures/valid_worked_example_s7.json");
    auto ops = step["ops"];
    REQUIRE (ops.isArray());
    CHECK (ops.size() == 7);
    CHECK (ops[0].getProperty ("kind", var()).toString() == "asset.resolve");
    CHECK (ops[0].getProperty ("out", var()).toString() == "asset_3f9c");
}
