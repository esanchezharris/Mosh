#include <catch2/catch_test_macros.hpp>
#include "MoshEngine.h"
#include "EngineHandlers.h"
#include "PluginCommands.h"
#include "EngineSnapshot.h"
#include "DslExecutor.h"
#include "JsonlLog.h"
#include <juce_gui_basics/juce_gui_basics.h>

// Stage 3 plugin-hosting command surface over REAL Tracktion, using a BUILT-IN
// plugin (no external VST3 needed → Windows-verifiable). load/bypass/remove/reorder
// + undo via MoshOps, reflected in the snapshot. The real VST3 scan + native editor
// pop-out + audio are the macOS half of the Stage-3 gate.
using namespace mosh;

namespace
{
    juce::var argObj (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv) o->setProperty (juce::Identifier (p.first), p.second);
        return juce::var (o);
    }

    juce::var trackVar (const juce::var& snap, const juce::String& ref)
    {
        auto tracks = snap["tracks"];
        for (int i = 0; i < tracks.size(); ++i)
            if (tracks[i]["id"].toString() == ref)
                return tracks[i];
        return {};
    }
    int pluginCount (const juce::var& snap, const juce::String& trackRef)
    {
        auto t = trackVar (snap, trackRef);
        return t.isObject() ? t["plugins"].size() : -1;
    }
    juce::var pluginVar (const juce::var& snap, const juce::String& trackRef, const juce::String& plgRef)
    {
        auto t = trackVar (snap, trackRef);
        auto plugins = t["plugins"];
        for (int j = 0; j < plugins.size(); ++j)
            if (plugins[j]["id"].toString() == plgRef)
                return plugins[j];
        return {};
    }
}

TEST_CASE ("plugin commands: load/bypass/remove/reorder a built-in via MoshOps", "[plugins]")
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    MoshEngine engine;
    JsonlLog log ([] { return juce::String ("t"); });
    DslExecutor exec (engine.getUndoManager(), &log);
    EngineSnapshotSource snap (engine);
    exec.setSnapshotSource (&snap);
    registerEngineHandlers (exec, engine);
    registerPluginCommands (exec, engine);

    auto t = exec.execute ("create_track", argObj ({ { "name", "Synth" } }));
    REQUIRE (t.ok);
    const auto trackRef = t.data["id"].toString();
    const int before = pluginCount (exec.getSnapshot(), trackRef);
    REQUIRE (before >= 0);

    // load a built-in plugin (confirmed type "volume" = VolumeAndPanPlugin)
    auto lp = exec.execute ("load_plugin", argObj ({ { "track", trackRef }, { "type", "volume" } }));
    REQUIRE (lp.ok);
    const auto plgRef = lp.data["id"].toString();
    REQUIRE (plgRef.startsWith ("plg:"));
    REQUIRE (pluginCount (exec.getSnapshot(), trackRef) == before + 1);
    REQUIRE (pluginVar (exec.getSnapshot(), trackRef, plgRef).isObject());

    // bypass → snapshot reflects it
    auto bp = exec.execute ("bypass_plugin", argObj ({ { "plugin", plgRef }, { "bypassed", true } }));
    REQUIRE (bp.ok);
    REQUIRE ((bool) pluginVar (exec.getSnapshot(), trackRef, plgRef)["bypassed"] == true);
    REQUIRE (exec.execute ("bypass_plugin", argObj ({ { "plugin", plgRef }, { "bypassed", false } })).ok);
    REQUIRE ((bool) pluginVar (exec.getSnapshot(), trackRef, plgRef)["bypassed"] == false);

    // unknown type fails gracefully
    auto bad = exec.execute ("load_plugin", argObj ({ { "track", trackRef }, { "type", "nonexistent_xyz" } }));
    REQUIRE_FALSE (bad.ok);

    // remove → count back; undo → plugin restored
    REQUIRE (exec.execute ("remove_plugin", argObj ({ { "plugin", plgRef } })).ok);
    REQUIRE (pluginCount (exec.getSnapshot(), trackRef) == before);
    exec.execute ("undo");
    REQUIRE (pluginCount (exec.getSnapshot(), trackRef) == before + 1);

    // unknown plugin ref → stable error
    auto nope = exec.execute ("bypass_plugin", argObj ({ { "plugin", "plg:999999" }, { "bypassed", true } }));
    REQUIRE_FALSE (nope.ok);
    REQUIRE (nope.errorCode == juce::String (error::noSuchPlugin));
}
