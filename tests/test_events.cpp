#include <catch2/catch_test_macros.hpp>
#include "MoshEvent.h"

using namespace mosh;

// Events serialize to flat { type, ...fields } matching ui/src/bridge.ts exactly.
TEST_CASE ("Events serialize to the frontend's flat {type, ...fields} shape", "[events]")
{
    SECTION ("clip_moved {id, range:[start,end]}")
    {
        auto v = events::clipMoved ("clip:hook", 12.0, 16.0).toVar();
        REQUIRE (v["type"].toString() == "clip_moved");
        REQUIRE (v["id"].toString() == "clip:hook");
        REQUIRE (v["range"].isArray());
        REQUIRE ((double) v["range"][0] == 12.0);
        REQUIRE ((double) v["range"][1] == 16.0);
    }

    SECTION ("transport_position {pos} — the decimated playhead event")
    {
        auto v = events::transportPosition (4.5).toVar();
        REQUIRE (v["type"].toString() == "transport_position");
        REQUIRE ((double) v["pos"] == 4.5);
    }

    SECTION ("plugin_param_changed {pluginId, param, value}")
    {
        auto v = events::pluginParamChanged ("plg:1", "cutoff", 0.7).toVar();
        REQUIRE (v["type"].toString() == "plugin_param_changed");
        REQUIRE (v["pluginId"].toString() == "plg:1");
        REQUIRE (v["param"].toString() == "cutoff");
        REQUIRE ((double) v["value"] == 0.7);
    }

    SECTION ("snapshot_invalidated has only a type")
    {
        auto v = events::snapshotInvalidated().toVar();
        REQUIRE (v["type"].toString() == "snapshot_invalidated");
    }
}

// Decimation is mandatory for transport_position / meter_update (02 §4.2).
TEST_CASE ("Decimator throttles a stream to its target rate", "[events][decimation]")
{
    Decimator dec (60.0);   // 60 Hz → ~16.67 ms minimum interval

    REQUIRE (dec.shouldEmit ("transport", 0.0));      // first always passes
    REQUIRE_FALSE (dec.shouldEmit ("transport", 5.0)); // 5 ms later — dropped
    REQUIRE_FALSE (dec.shouldEmit ("transport", 16.0));// still under interval
    REQUIRE (dec.shouldEmit ("transport", 17.0));      // > 16.67 ms — passes
}

TEST_CASE ("Decimator throttles each keyed stream independently", "[events][decimation]")
{
    Decimator dec (60.0);
    REQUIRE (dec.shouldEmit ("meter:track:1", 0.0));
    REQUIRE (dec.shouldEmit ("meter:track:2", 0.0));   // different key, not throttled
    REQUIRE_FALSE (dec.shouldEmit ("meter:track:1", 1.0));
}
