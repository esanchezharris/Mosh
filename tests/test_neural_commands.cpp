#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "MoshEngine.h"
#include "EngineHandlers.h"
#include "NeuralCommands.h"
#include "NeuralInsertPlugin.h"
#include "EngineSnapshot.h"
#include "DslExecutor.h"
#include "JsonlLog.h"
#include <juce_gui_basics/juce_gui_basics.h>

// Stage 4 Tier-A command surface over REAL Tracktion: a custom NeuralInsertPlugin in
// the track's pluginList, driven by ASTD-clamped commands. Proves the ASTD clamp +
// Lab-mode unlock (one shared impl, both tiers) through the MoshOps command path —
// Windows-verifiable. The anira model inference + the PDC null test are the macOS gate.
using namespace mosh;
using Catch::Approx;

namespace
{
    juce::var argObj (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv) o->setProperty (juce::Identifier (p.first), p.second);
        return juce::var (o);
    }

    NeuralInsertPlugin* firstNeural (MoshEngine& engine)
    {
        for (auto* t : tracktion::getAudioTracks (engine.getEdit()))
            for (auto* p : t->pluginList.getPlugins())
                if (auto* ni = dynamic_cast<NeuralInsertPlugin*> (p))
                    return ni;
        return nullptr;
    }
}

TEST_CASE ("neural commands: add insert + ASTD clamp + Lab-mode unlock via MoshOps", "[neural]")
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    MoshEngine engine;
    JsonlLog log ([] { return juce::String ("t"); });
    DslExecutor exec (engine.getUndoManager(), &log);
    EngineSnapshotSource snap (engine);
    exec.setSnapshotSource (&snap);
    registerEngineHandlers (exec, engine);
    registerNeuralCommands (exec, engine);

    auto t = exec.execute ("create_track", argObj ({ { "name", "Gtr" } }));
    REQUIRE (t.ok);
    const auto trackRef = t.data["id"].toString();

    // add_neural_insert → a NeuralInsertPlugin is in the track's pluginList
    auto add = exec.execute ("add_neural_insert", argObj ({ { "track", trackRef }, { "model", "nam" } }));
    REQUIRE (add.ok);
    const auto plgRef = add.data["id"].toString();
    REQUIRE (plgRef.startsWith ("plg:"));

    auto* ni = firstNeural (engine);
    REQUIRE (ni != nullptr);
    REQUIRE (ni->getModelId() == "nam");

    // Normal mode: UI 100 clamps to the safe ceiling (raw 0.7), NOT the raw max 1.0.
    REQUIRE (exec.execute ("set_neural_param", argObj ({ { "plugin", plgRef }, { "param", "amount" }, { "value", 100.0 } })).ok);
    REQUIRE (ni->getAmount() == Approx (0.7f));

    // UI 50 → halfway up the safe range → 0.35.
    REQUIRE (exec.execute ("set_neural_param", argObj ({ { "plugin", plgRef }, { "param", "amount" }, { "value", 50.0 } })).ok);
    REQUIRE (ni->getAmount() == Approx (0.35f));

    // Lab mode unlocks the full raw range: UI 100 → raw max 1.0.
    REQUIRE (exec.execute ("set_neural_lab_mode", argObj ({ { "plugin", plgRef }, { "on", true } })).ok);
    REQUIRE (ni->isLabMode());
    REQUIRE (exec.execute ("set_neural_param", argObj ({ { "plugin", plgRef }, { "param", "amount" }, { "value", 100.0 } })).ok);
    REQUIRE (ni->getAmount() == Approx (1.0f));

    // Back to clamped: UI 100 → 0.7 again (defeatable, then re-locked).
    REQUIRE (exec.execute ("set_neural_lab_mode", argObj ({ { "plugin", plgRef }, { "on", false } })).ok);
    REQUIRE (exec.execute ("set_neural_param", argObj ({ { "plugin", plgRef }, { "param", "amount" }, { "value", 100.0 } })).ok);
    REQUIRE (ni->getAmount() == Approx (0.7f));

    // Passthrough shell reports zero latency → PDC trivially null (real delay arrives with anira).
    REQUIRE (ni->getLatencySeconds() == Approx (0.0));

    // bypass
    REQUIRE (exec.execute ("bypass_neural_insert", argObj ({ { "plugin", plgRef }, { "bypassed", true } })).ok);
    REQUIRE_FALSE (ni->isEnabled());

    // unknown plugin → stable error
    REQUIRE_FALSE (exec.execute ("set_neural_param", argObj ({ { "plugin", "plg:999" }, { "param", "amount" }, { "value", 50.0 } })).ok);
}
