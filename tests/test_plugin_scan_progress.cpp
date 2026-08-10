// FIT-003 — plugin-scan progress event payload golden vectors. Pure/hermetic
// (juce_core/juce_data_structures only, no tracktion, no engine) — guards the
// 'plugin_scan_progress' event shape MoshOps.cpp's timerCallback() sampler and
// cmdRescanPlugins() both emit through makeScanProgressPayload().
#include <catch2/catch_test_macros.hpp>
#include "moshops/PluginScanPlan.h"
#include "moshops/ScanProgress.h"
#include "plugins/hosting/PluginScanWatchdog.h"

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
    auto payload = makeScanProgressPayload ("all", 42, true, 1500,
                                            { "WaveShell1-VST3 16.7.vst3" });
    REQUIRE (payload["format"].toString() == "all");
    REQUIRE ((bool) payload["done"] == true);
    REQUIRE ((int) payload["count"] == 42);
    REQUIRE ((int) payload["elapsedMs"] == 1500);
    auto* quarantined = payload["quarantined"].getArray();
    REQUIRE (quarantined != nullptr);
    REQUIRE (quarantined->size() == 1);
    REQUIRE ((*quarantined)[0].toString() == "WaveShell1-VST3 16.7.vst3");
}

TEST_CASE ("makeScanProgressPayload: all five keys are present (additive-contract guard)", "[plugin_scan_progress]")
{
    // The store (ui/src/store.ts) reads format/done/count/elapsedMs and forward-
    // compatibly ignores unknown fields; this pins the shape so the frontend can
    // rely on all five keys always being present, never omitted.
    auto payload = makeScanProgressPayload ("vst3", 3, false, 250);
    auto* obj = payload.getDynamicObject();
    REQUIRE (obj != nullptr);
    REQUIRE (obj->hasProperty ("format"));
    REQUIRE (obj->hasProperty ("done"));
    REQUIRE (obj->hasProperty ("count"));
    REQUIRE (obj->hasProperty ("elapsedMs"));
    REQUIRE (obj->hasProperty ("quarantined"));
    REQUIRE (payload["quarantined"].getArray()->isEmpty());
}

TEST_CASE ("plugin scan watchdog request is consumed exactly once", "[plugin_scan_watchdog]")
{
    PluginScanWatchdogState state;
    REQUIRE_FALSE (state.isAbortRequested());
    state.requestAbort();
    REQUIRE (state.isAbortRequested());
    REQUIRE (state.consumeAbortRequest());
    REQUIRE_FALSE (state.isAbortRequested());
    REQUIRE_FALSE (state.consumeAbortRequest());
}

TEST_CASE ("terminal scan event names only newly quarantined bundles", "[plugin_scan_progress]")
{
    const juce::StringArray before { "/Library/Audio/Plug-Ins/VST3/Old.vst3" };
    const juce::StringArray after {
        "/Library/Audio/Plug-Ins/VST3/Old.vst3",
        "/Library/Audio/Plug-Ins/VST3/WaveShell1-VST3 16.7.vst3",
    };

    const auto names = newlyQuarantinedPluginNames (before, after);
    REQUIRE (names == juce::StringArray { "WaveShell1-VST3 16.7.vst3" });
}

TEST_CASE ("deep VST3 scan stays AU-free and uses the async isolated worker", "[plugin_scan_plan]")
{
    const auto plan = planPluginScan (true, true, false, false, true);
    REQUIRE_FALSE (plan.runSynchronously);
    REQUIRE_FALSE (plan.preScanVST3);
    REQUIRE (plan.asyncClearFirst);
    REQUIRE (plan.asyncIncludeVST3);
    REQUIRE_FALSE (plan.asyncIncludeAU);
    REQUIRE (plan.asyncSlowVST3);
}

TEST_CASE ("ordinary VST3 scan keeps the existing fast synchronous path", "[plugin_scan_plan]")
{
    const auto plan = planPluginScan (false, true, false, false, false);
    REQUIRE (plan.runSynchronously);
    REQUIRE_FALSE (plan.asyncIncludeVST3);
    REQUIRE_FALSE (plan.asyncIncludeAU);
}

TEST_CASE ("wait AU scan preserves its fast VST3 pre-pass", "[plugin_scan_plan]")
{
    const auto plan = planPluginScan (true, true, true, true, false);
    REQUIRE_FALSE (plan.runSynchronously);
    REQUIRE (plan.preScanVST3);
    REQUIRE_FALSE (plan.asyncClearFirst);
    REQUIRE_FALSE (plan.asyncIncludeVST3);
    REQUIRE (plan.asyncIncludeAU);
}
