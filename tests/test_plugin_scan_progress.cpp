// FIT-003 — plugin-scan progress event payload golden vectors. Pure/hermetic
// (juce_core/juce_data_structures only, no tracktion, no engine) — guards the
// 'plugin_scan_progress' event shape MoshOps.cpp's timerCallback() sampler and
// cmdRescanPlugins() both emit through makeScanProgressPayload().
#include <catch2/catch_test_macros.hpp>
#include "moshops/ScanProgress.h"

using namespace mosh;

TEST_CASE ("makeScanProgressPayload: start-of-sweep shape", "[plugin_scan_progress]")
{
    auto payload = makeScanProgressPayload ("vst3", 0, false, 0);
    REQUIRE (payload["format"].toString() == "vst3");
    REQUIRE ((bool) payload["done"] == false);
    REQUIRE ((int) payload["count"] == 0);
    REQUIRE ((int) payload["elapsedMs"] == 0);
}

TEST_CASE ("makeScanProgressPayload: mid-sweep running-count sample", "[plugin_scan_progress]")
{
    auto payload = makeScanProgressPayload ("au", 17, false, 4200);
    REQUIRE (payload["format"].toString() == "au");
    REQUIRE ((bool) payload["done"] == false);
    REQUIRE ((int) payload["count"] == 17);
    REQUIRE ((int) payload["elapsedMs"] == 4200);
}

TEST_CASE ("makeScanProgressPayload: terminal done event", "[plugin_scan_progress]")
{
    auto payload = makeScanProgressPayload ("all", 42, true, 1500);
    REQUIRE (payload["format"].toString() == "all");
    REQUIRE ((bool) payload["done"] == true);
    REQUIRE ((int) payload["count"] == 42);
    REQUIRE ((int) payload["elapsedMs"] == 1500);
}

TEST_CASE ("makeScanProgressPayload: all four keys are present (additive-contract guard)", "[plugin_scan_progress]")
{
    // The store (ui/src/store.ts) reads format/done/count/elapsedMs and forward-
    // compatibly ignores unknown fields; this pins the shape so the frontend can
    // rely on all four keys always being present, never omitted.
    auto payload = makeScanProgressPayload ("vst3", 3, false, 250);
    auto* obj = payload.getDynamicObject();
    REQUIRE (obj != nullptr);
    REQUIRE (obj->hasProperty ("format"));
    REQUIRE (obj->hasProperty ("done"));
    REQUIRE (obj->hasProperty ("count"));
    REQUIRE (obj->hasProperty ("elapsedMs"));
}
