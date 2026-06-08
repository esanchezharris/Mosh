#include <catch2/catch_test_macros.hpp>
#include "DslExecutor.h"
#include "GenerativeCommands.h"
#include "JsonlLog.h"
#include <vector>

// The Stage-5 Fake gate's "full loop via commands" — create → render (progress
// events, cache hit/miss) → param change → dirty → re-render → accept/reject as
// JSONL taste labels. In-process FakeAdapter (deterministic, no service spawn);
// the C++↔service path is proven separately in mosh_service_tests.
using namespace mosh;

namespace
{
    juce::var argObj (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv) o->setProperty (juce::Identifier (p.first), p.second);
        return juce::var (o);
    }
    int countType (const std::vector<MoshEvent>& evs, const juce::String& t)
    {
        int n = 0; for (auto& e : evs) if (e.type == t) ++n; return n;
    }
    struct Collector : MoshEventListener
    {
        std::vector<MoshEvent> events;
        void onMoshEvent (const MoshEvent& e) override { events.push_back (e); }
    };
}

TEST_CASE ("generative commands: full Fake loop via the command surface", "[gcommands]")
{
    juce::UndoManager um;
    JsonlLog log ([] { return juce::String ("t"); });
    DslExecutor exec (um, &log);
    RenderLayerStore store;
    FakeAdapter adapter;
    RenderCache cache;
    registerGenerativeCommands (exec, store, adapter, cache);
    Collector col; exec.addListener (&col);

    // create_render_layer
    auto r1 = exec.execute ("create_render_layer", argObj ({ { "mode", "generate" }, { "prompt", "warm grit" }, { "seed", 42 } }));
    REQUIRE (r1.ok);
    const auto rl = r1.data["id"].toString();
    REQUIRE (rl.startsWith ("rl:"));
    REQUIRE (store.size() == 1);

    // render_layer → cache MISS: progress events + layer_rendered
    col.events.clear();
    auto r2 = exec.execute ("render_layer", argObj ({ { "layer", rl }, { "sourceHash", "srcA" } }));
    REQUIRE (r2.ok);
    REQUIRE_FALSE ((bool) r2.data["fromCache"]);
    REQUIRE (countType (col.events, "layer_render_progress") >= 1);
    REQUIRE (countType (col.events, "layer_rendered") == 1);
    REQUIRE (adapter.renderCount == 1);

    // render again, same fingerprint → cache HIT (adapter NOT called)
    auto r3 = exec.execute ("render_layer", argObj ({ { "layer", rl }, { "sourceHash", "srcA" } }));
    REQUIRE (r3.ok);
    REQUIRE ((bool) r3.data["fromCache"]);
    REQUIRE (adapter.renderCount == 1);

    // set_render_param (seed) → dirty → render → MISS
    REQUIRE (exec.execute ("set_render_param", argObj ({ { "layer", rl }, { "seed", 43 }, { "sourceHash", "srcA" } })).ok);
    auto r4 = exec.execute ("render_layer", argObj ({ { "layer", rl }, { "sourceHash", "srcA" } }));
    REQUIRE (r4.ok);
    REQUIRE_FALSE ((bool) r4.data["fromCache"]);
    REQUIRE (adapter.renderCount == 2);

    // accept_render / reject_render → captured as JSONL taste labels (logged for free)
    REQUIRE (exec.execute ("accept_render", argObj ({ { "layer", rl } })).ok);
    REQUIRE (exec.execute ("reject_render", argObj ({ { "layer", rl } })).ok);

    bool hasAccept = false, hasReject = false;
    for (const auto& line : log.lines())
    {
        auto v = juce::JSON::parse (line);
        if (v["cmd"].toString() == "accept_render") { hasAccept = true; REQUIRE (v["args"]["layer"].toString() == rl); }
        if (v["cmd"].toString() == "reject_render") hasReject = true;
    }
    REQUIRE (hasAccept);
    REQUIRE (hasReject);

    // unknown layer → stable error
    auto bad = exec.execute ("render_layer", argObj ({ { "layer", "rl:999" } }));
    REQUIRE_FALSE (bad.ok);
    REQUIRE (bad.errorCode == juce::String (error::noSuchLayer));
}
