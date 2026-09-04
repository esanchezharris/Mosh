#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "reimagine/ReImagineCore.h"
#include "reimagine/ReImagineService.h"
#include "audio/RealtimeAudioGuard.h"

#include <limits>

using namespace mosh::reimagine;

TEST_CASE ("Transfer capture follows a continuous forward host timeline", "[reimagine][transfer]")
{
    TransferCapture capture;
    capture.prepare (48000.0, 2, 4.0 * 60.0);
    capture.arm();

    HostPosition first { true, false, 0, 0.0, 120.0, 4.0 };
    REQUIRE (capture.beginOrContinue (first, 512, 2) == CaptureEvent::started);

    HostPosition next { true, false, 512, 512.0 / 24000.0, 120.0, 4.0 };
    CHECK (capture.beginOrContinue (next, 512, 2) == CaptureEvent::continued);

    auto seek = next;
    seek.samplePosition += 1024;
    CHECK (capture.beginOrContinue (seek, 512, 2) == CaptureEvent::abortedDiscontinuity);
    CHECK (capture.state() == CaptureState::aborted);
}

TEST_CASE ("Transfer capture permits tempo automation but aborts loop wraps and layout changes", "[reimagine][transfer]")
{
    TransferCapture capture;
    capture.prepare (48000.0, 2, 240.0);
    capture.arm();
    REQUIRE (capture.beginOrContinue ({ true, false, 0, 0.0, 120.0, 4.0 }, 480, 2) == CaptureEvent::started);
    CHECK (capture.beginOrContinue ({ true, false, 480, 0.02, 119.0, 4.0 }, 480, 2) == CaptureEvent::continued);
    CHECK (capture.beginOrContinue ({ true, false, 960, 0.04, 118.0, 4.0 }, 480, 1) == CaptureEvent::abortedLayoutChange);

    capture.arm();
    REQUIRE (capture.beginOrContinue ({ true, false, 5000, 8.0, 120.0, 4.0 }, 480, 2) == CaptureEvent::started);
    CHECK (capture.beginOrContinue ({ true, true, 5480, 0.0, 120.0, 4.0 }, 480, 2) == CaptureEvent::abortedLoopWrap);
}

TEST_CASE ("Transfer capture fails dry without host timing and stops at its cap", "[reimagine][transfer]")
{
    TransferCapture missing;
    missing.prepare (10.0, 1, 1.0);
    missing.arm();
    CHECK (missing.beginOrContinue (std::nullopt, 5, 1) == CaptureEvent::abortedMissingTiming);

    TransferCapture capped;
    capped.prepare (10.0, 1, 1.0);
    capped.arm();
    REQUIRE (capped.beginOrContinue ({ true, false, 0, 0.0, 120.0, 4.0 }, 6, 1)
             == CaptureEvent::started);
    CHECK (capped.beginOrContinue ({ true, false, 6, 1.2, 120.0, 4.0 }, 6, 1)
           == CaptureEvent::reachedCaptureCap);
    CHECK (capped.state() == CaptureState::complete);
    CHECK (capped.capturedSamples() == 10);
    CHECK (capped.endPpq() == Catch::Approx (2.0));
}

TEST_CASE ("Overlapping transfer requires an explicit replace or discard decision", "[reimagine][regions]")
{
    RegionCollection regions;
    TransferRegion a;
    a.id = "a";
    a.ppqStart = 4.0;
    a.ppqEnd = 8.0;
    CHECK (regions.offer (a) == RegionOffer::accepted);

    TransferRegion b;
    b.id = "b";
    b.ppqStart = 7.0;
    b.ppqEnd = 12.0;
    CHECK (regions.offer (b) == RegionOffer::needsOverlapDecision);
    REQUIRE (regions.pendingOverlap().has_value());
    regions.discardPending();
    CHECK (regions.regions().size() == 1);

    REQUIRE (regions.offer (b) == RegionOffer::needsOverlapDecision);
    regions.replaceOverlaps();
    REQUIRE (regions.regions().size() == 1);
    CHECK (regions.regions().front().id == "b");
}

TEST_CASE ("Multiple non-overlapping regions remain sorted and independently addressable", "[reimagine][regions]")
{
    RegionCollection regions;
    TransferRegion later;
    later.id = "later";
    later.ppqStart = 12.0;
    later.ppqEnd = 16.0;
    TransferRegion earlier;
    earlier.id = "earlier";
    earlier.ppqStart = 2.0;
    earlier.ppqEnd = 6.0;
    REQUIRE (regions.offer (later) == RegionOffer::accepted);
    REQUIRE (regions.offer (earlier) == RegionOffer::accepted);
    REQUIRE (regions.regions().size() == 2);
    CHECK (regions.regions()[0].id == "earlier");
    CHECK (regions.regions()[1].id == "later");
}

TEST_CASE ("Render edits coalesce to the latest revision while one inference is active", "[reimagine][render]")
{
    RenderCoordinator coordinator;
    CHECK (coordinator.commitRequest ({ 1, "region-a", { "one" }, false }) == RenderAction::startNow);
    CHECK (coordinator.commitRequest ({ 2, "region-b", { "two" }, false }) == RenderAction::queuedLatest);
    CHECK (coordinator.commitRequest ({ 3, "region-c", { "three" }, true }) == RenderAction::queuedLatest);

    auto superseded = coordinator.finish (1, true);
    CHECK_FALSE (superseded.publish);
    REQUIRE (superseded.startRequest.has_value());
    CHECK (superseded.startRequest->revision == 3);
    CHECK (superseded.startRequest->regionId == "region-c");
    CHECK (superseded.startRequest->rack.prompt == "three");
    CHECK (superseded.startRequest->labEnabled);
    REQUIRE (coordinator.activeRequest().has_value());
    CHECK (coordinator.activeRequest()->regionId == "region-c");

    auto newest = coordinator.finish (3, true);
    CHECK (newest.publish);
    CHECK_FALSE (newest.startRequest.has_value());
}

TEST_CASE ("A removed active render target fails forward to the latest queued request", "[reimagine][render]")
{
    RenderCoordinator coordinator;
    REQUIRE (coordinator.commitRequest ({ 10, "removed-region", { "old" }, false })
             == RenderAction::startNow);
    REQUIRE (coordinator.commitRequest ({ 11, "restored-region", { "new" }, false })
             == RenderAction::queuedLatest);
    const auto completion = coordinator.finish (10, false);
    CHECK_FALSE (completion.publish);
    REQUIRE (completion.startRequest.has_value());
    CHECK (completion.startRequest->revision == 11);
    CHECK (completion.startRequest->regionId == "restored-region");
    REQUIRE (coordinator.activeRequest().has_value());
    CHECK (coordinator.activeRequest()->revision == 11);
}

TEST_CASE ("Tempo divergence marks a region stale", "[reimagine][tempo]")
{
    TempoMap map;
    map.push_back ({ 0.0, 120.0 });
    map.push_back ({ 4.0, 100.0 });
    CHECK (tempoMatches (map, 2.0, 120.0));
    CHECK (tempoMatches (map, 5.0, 100.0));
    CHECK_FALSE (tempoMatches (map, 5.0, 101.0));
}

TEST_CASE ("Equal-power substitution is dry outside the region and honors A B and Mix", "[reimagine][playback]")
{
    const auto outside = substitutionGainsForPosition (3.0, 4.0, 8.0, 0.1, 1.0f, false);
    CHECK (outside.dry == 1.0f);
    CHECK (outside.wet == 0.0f);
    const auto compare = substitutionGainsForPosition (6.0, 4.0, 8.0, 0.1, 1.0f, true);
    CHECK (compare.dry == 1.0f);
    CHECK (compare.wet == 0.0f);
    const auto mixed = substitutionGainsForPosition (6.0, 4.0, 8.0, 0.1, 0.25f, false);
    CHECK (mixed.dry * mixed.dry + mixed.wet * mixed.wet == Catch::Approx (1.0f).margin (0.0001));
    const auto boundary = substitutionGainsForPosition (4.05, 4.0, 8.0, 0.1, 1.0f, false);
    CHECK (boundary.dry == Catch::Approx (std::cos (juce::MathConstants<double>::halfPi * 0.5)).margin (0.001));
    CHECK (boundary.wet == Catch::Approx (std::sin (juce::MathConstants<double>::halfPi * 0.5)).margin (0.001));
    CHECK (boundary.dry * boundary.dry + boundary.wet * boundary.wet
           == Catch::Approx (1.0f).margin (0.0001));
}

TEST_CASE ("Paused transport does not substitute a rendered take", "[reimagine][playback]")
{
    const HostPosition paused { false, false, 48000, 1.0, 120.0, 4.0 };
    const HostPosition playing { true, false, 48000, 1.0, 120.0, 4.0 };
    CHECK_FALSE (shouldRenderSelected (paused, false));
    CHECK (shouldRenderSelected (playing, false));
    CHECK (shouldRenderSelected (paused, true));
}

TEST_CASE ("Plugin state round-trips metadata without embedding audio", "[reimagine][state]")
{
    PluginStateV1 state;
    state.selectedRegionId = "region-1";
    state.rack.prompt = "broken glass percussion";
    state.rack.reimagine = 0.72f;
    state.labEnabled = true;
    state.mix = 0.63f;

    TransferRegion region;
    region.id = "region-1";
    region.ppqStart = 4.0;
    region.ppqEnd = 8.0;
    region.sourceHash = "source-sha";
    region.selectedTakeId = "take-1";
    RenderTake take;
    take.id = "take-1";
    take.assetHash = "render-sha";
    take.seed = 42;
    take.parameters = state.rack;
    region.takes.push_back (take);
    state.regions.push_back (region);

    const auto json = serializeState (state);
    CHECK_FALSE (json.containsIgnoreCase ("RIFF"));
    CHECK_FALSE (json.containsIgnoreCase ("audioData"));

    auto restored = deserializeState (json);
    REQUIRE (restored.has_value());
    CHECK (restored->selectedRegionId == "region-1");
    REQUIRE (restored->regions.size() == 1);
    REQUIRE (restored->regions.front().takes.size() == 1);
    CHECK (restored->regions.front().takes.front().assetHash == "render-sha");
    CHECK (restored->rack.prompt == "broken glass percussion");
    CHECK (restored->mix == Catch::Approx (0.63f));
}

TEST_CASE ("Service request maps Mosh rack controls to the existing SA3 protocol", "[reimagine][service]")
{
    RackSettings rack;
    rack.prompt = "metallic drums";
    rack.reimagine = 0.42f;
    rack.seed = 77;
    rack.colors.push_back ({ "grit", 83.0f });
    rack.loras.push_back ({ "owner-breaks", 0.65f });

    const auto params = serviceParamsForRack (rack, true);
    CHECK (params.getProperty ("prompt", {}).toString() == "metallic drums");
    CHECK (static_cast<float> (params.getProperty ("nl", 0.0)) == Catch::Approx (0.42f));
    CHECK (static_cast<juce::int64> (params.getProperty ("seed", 0)) == 77);
    CHECK (static_cast<bool> (params.getProperty ("lab", false)));
    const auto* colors = params.getProperty ("colors", {}).getArray();
    REQUIRE (colors != nullptr);
    REQUIRE (colors->size() == 1);
    CHECK ((*colors)[0].getProperty ("name", {}).toString() == "grit");
    CHECK (static_cast<float> ((*colors)[0].getProperty ("value", 0.0)) == Catch::Approx (83.0f));
    const auto* loras = params.getProperty ("loras", {}).getArray();
    REQUIRE (loras != nullptr);
    REQUIRE (loras->size() == 1);
    CHECK ((*loras)[0].getProperty ("name", {}).toString() == "owner-breaks");
    CHECK (static_cast<float> ((*loras)[0].getProperty ("value", 0.0)) == Catch::Approx (65.0f));
}

TEST_CASE ("LoRA catalog keeps valid service adapters and their human labels", "[reimagine][service][loras]")
{
    auto* response = new juce::DynamicObject();
    juce::Array<juce::var> rows;
    auto addRow = [&rows] (juce::String name, juce::String displayName,
                           juce::String trigger, juce::String family, bool valid)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("name", std::move (name));
        row->setProperty ("displayName", std::move (displayName));
        row->setProperty ("trigger", std::move (trigger));
        row->setProperty ("family", std::move (family));
        row->setProperty ("valid", valid);
        rows.add (juce::var (row));
    };
    addRow ("bro-sa3", "Brother (BWPOM era)", "brozr", "library", true);
    addRow ("broken", "Broken adapter", {}, "library", false);
    addRow ("lab-take", {}, "labz", "lab", true);
    response->setProperty ("ok", true);
    response->setProperty ("loras", rows);

    const auto catalog = loraCatalogFromResponse (juce::var (response));

    REQUIRE (catalog.size() == 2);
    CHECK (catalog[0].id == "bro-sa3");
    CHECK (catalog[0].displayName == "Brother (BWPOM era)");
    CHECK (catalog[0].trigger == "brozr");
    CHECK_FALSE (catalog[0].isLab);
    CHECK (catalog[1].id == "lab-take");
    CHECK (catalog[1].displayName == "lab-take");
    CHECK (catalog[1].isLab);
}

TEST_CASE ("State migration defaults additive Mix and preserves unlimited take history", "[reimagine][state]")
{
    PluginStateV1 state;
    TransferRegion region;
    region.id = "history";
    region.ppqStart = 0.0;
    region.ppqEnd = 4.0;
    for (int i = 0; i < 256; ++i)
    {
        RenderTake take;
        take.id = "take-" + juce::String (i);
        take.assetHash = juce::String::repeatedString ("a", 64);
        region.takes.push_back (std::move (take));
    }
    state.regions.push_back (std::move (region));
    auto legacy = juce::JSON::parse (serializeState (state));
    REQUIRE (legacy.getDynamicObject() != nullptr);
    legacy.getDynamicObject()->removeProperty ("mix");
    const auto restored = deserializeState (juce::JSON::toString (legacy));
    REQUIRE (restored.has_value());
    CHECK (restored->mix == 1.0f);
    REQUIRE (restored->regions.size() == 1);
    CHECK (restored->regions.front().takes.size() == 256);
}

TEST_CASE ("Asset relink is content-addressed and refuses a hash mismatch", "[reimagine][assets]")
{
    auto root = juce::File::createTempFile ("mosh-reimagine-assets");
    root.deleteFile();
    root.createDirectory();
    struct Cleanup { juce::File root; ~Cleanup() { root.deleteRecursively(); } } cleanup { root };
    AssetStore assets (root);
    const auto candidate = root.getChildFile ("candidate.wav");
    REQUIRE (candidate.replaceWithText ("hash-verified-test-audio"));
    juce::FileInputStream stream (candidate);
    REQUIRE (stream.openedOk());
    const auto expected = juce::SHA256 (stream).toHexString();
    juce::String error;
    REQUIRE (assets.relink (candidate, expected, false, error));
    CHECK (assets.verify (assets.renderFile (expected), expected));
    TransferRegion region;
    region.sourceHash = expected;
    region.selectedTakeId = "take";
    RenderTake take;
    take.id = "take";
    take.assetHash = expected;
    region.takes.push_back (take);
    CHECK_FALSE (assets.selectedAssetsAvailable (region));
    REQUIRE (assets.relink (candidate, expected, true, error));
    CHECK (assets.selectedAssetsAvailable (region));
    CHECK_FALSE (assets.relink (candidate, juce::String::repeatedString ("0", 64), true, error));
    CHECK (error.containsIgnoreCase ("hash"));
}

TEST_CASE ("Transfer and playback mapping helpers allocate nothing in an RT scope", "[reimagine][rtguard]")
{
    TransferCapture capture;
    capture.prepare (48000.0, 2, 240.0);
    capture.arm();
    TempoMap tempo { { 0.0, 120.0 }, { 4.0, 100.0 } };
    const auto before = mosh::rtguard::violationCount();
    CaptureEvent event = CaptureEvent::none;
    bool tempoMatched = false;
    CrossfadeGains gains;
    {
        mosh::rtguard::ScopedRealtime realtime;
        event = capture.beginOrContinue ({ true, false, 0, 0.0, 120.0, 4.0 }, 512, 2);
        tempoMatched = tempoMatches (tempo, 2.0, 120.0);
        gains = substitutionGainsForPosition (4.05, 4.0, 8.0, 0.1, 1.0f, false);
    }
    CHECK (event == CaptureEvent::started);
    CHECK (tempoMatched);
    CHECK (gains.wet > 0.0f);
    CHECK (mosh::rtguard::violationCount() == before);
}

// ── IMP-001 — imported takes ──────────────────────────────────────────────────────
TEST_CASE ("ppqForBar counts 1-based bars in quarter notes", "[reimagine][import]")
{
    CHECK (ppqForBar (1.0, 4.0) == Catch::Approx (0.0));
    CHECK (ppqForBar (5.0, 4.0) == Catch::Approx (16.0));      // bars 1-4 = 16 quarters
    CHECK (ppqForBar (3.0, 3.0) == Catch::Approx (6.0));       // 3/4: 3 quarters a bar
    CHECK (ppqForBar (2.0, 6.0, 8.0) == Catch::Approx (3.0));  // 6/8: six eighths = 3 quarters
    CHECK (ppqForBar (2.5, 4.0) == Catch::Approx (6.0));       // fractional bars are allowed
    CHECK (ppqForBar (1.0, 0.0) == 0.0);                       // junk signature -> bar 1
}

TEST_CASE ("an imported take spans the WAV length at the host tempo", "[reimagine][import]")
{
    // 2 s at 48 kHz, 120 BPM: 2 s * 2 beats/s = 4 quarters.
    const auto region = regionForImportedTake ("abc123", 96000, 48000.0, 16.0, 120.0);
    REQUIRE (region.has_value());
    CHECK (region->ppqStart == Catch::Approx (16.0));
    CHECK (region->ppqEnd == Catch::Approx (20.0));
    CHECK (region->sourceHash == "abc123");
    CHECK (region->status == RegionStatus::ready);
    REQUIRE (region->tempoMap.size() == 1);
    CHECK (region->tempoMap[0].ppq == Catch::Approx (16.0));
    CHECK (region->tempoMap[0].bpm == Catch::Approx (120.0));
    CHECK (region->id.isNotEmpty());
    // The single tempo point satisfies the stale-tempo guard inside the region and a
    // changed host tempo trips it, exactly as a transferred region behaves.
    CHECK (tempoMatches (region->tempoMap, 17.0, 120.0));
    CHECK_FALSE (tempoMatches (region->tempoMap, 17.0, 90.0));
    // And it is an ordinary region to the collection: it can be offered and overlaps
    // are still the producer's decision.
    RegionCollection regions;
    CHECK (regions.offer (*region) == RegionOffer::accepted);
    const auto overlapping = regionForImportedTake ("def456", 48000, 48000.0, 18.0, 120.0);
    REQUIRE (overlapping.has_value());
    CHECK (regions.offer (*overlapping) == RegionOffer::needsOverlapDecision);
}

TEST_CASE ("an imported take refuses junk rather than inventing a region", "[reimagine][import]")
{
    CHECK_FALSE (regionForImportedTake ("", 96000, 48000.0, 0.0, 120.0).has_value());
    CHECK_FALSE (regionForImportedTake ("h", 0, 48000.0, 0.0, 120.0).has_value());
    CHECK_FALSE (regionForImportedTake ("h", 96000, 0.0, 0.0, 120.0).has_value());
    CHECK_FALSE (regionForImportedTake ("h", 96000, 48000.0, 0.0, 0.0).has_value());
    CHECK_FALSE (regionForImportedTake ("h", 96000, 48000.0, -1.0, 120.0).has_value());
    CHECK_FALSE (regionForImportedTake ("h", 96000, 48000.0, std::numeric_limits<double>::quiet_NaN(), 120.0).has_value());
}

TEST_CASE ("an imported take is a RenderTake the existing paths understand", "[reimagine][import]")
{
    const auto take = importedTake ("abc123", "2026-09-01T00:00:00Z", "vocal-take-3.wav");
    CHECK (take.id.isNotEmpty());
    CHECK (take.assetHash == "abc123");
    CHECK (take.timestampIso8601 == "2026-09-01T00:00:00Z");
    CHECK (take.parameters.prompt == "import:vocal-take-3.wav");
    CHECK (take.parameters.reimagine == 0.0f);
    CHECK (take.manifest.getProperty ("source", juce::var()).toString() == "import");
    CHECK (take.manifest.getProperty ("fileName", juce::var()).toString() == "vocal-take-3.wav");

    // Survives the plug-in state round trip like any other take.
    PluginStateV1 state;
    auto region = regionForImportedTake ("abc123", 96000, 48000.0, 0.0, 120.0);
    REQUIRE (region.has_value());
    region->takes.push_back (take);
    region->selectedTakeId = take.id;
    state.regions.push_back (*region);
    state.selectedRegionId = region->id;
    const auto restored = deserializeState (serializeState (state));
    REQUIRE (restored.has_value());
    REQUIRE (restored->regions.size() == 1);
    REQUIRE (restored->regions[0].takes.size() == 1);
    CHECK (restored->regions[0].takes[0].assetHash == "abc123");
    CHECK (restored->regions[0].selectedTakeId == take.id);
    CHECK (restored->regions[0].takes[0].manifest.getProperty ("source", juce::var()).toString() == "import");
}
