#include <catch2/catch_test_macros.hpp>

#include "engine_contract/MaolanProcessBackend.h"
#include "engine_contract/MoshEngineBackend.h"

using namespace mosh;

TEST_CASE ("engine contract capability reports structured support")
{
    auto cap = makeEngineCapability ("renderExport", "process", "maolan-render-smoke");

    REQUIRE (cap.getProperty ("operation", {}).toString() == "renderExport");
    REQUIRE (cap.getProperty ("status", {}).toString() == "process");
    REQUIRE ((bool) cap.getProperty ("supported", false));
    REQUIRE (cap.getProperty ("notes", {}).toString() == "maolan-render-smoke");
}

TEST_CASE ("engine contract error is structured")
{
    auto diagnostics = makeEngineDiagnostics ("maolan", "setTransport");
    auto err = makeEngineError ("maolan", "setTransport", "unsupported_by_backend",
                                "transport is not available in the process slice",
                                diagnostics);

    REQUIRE_FALSE ((bool) err.getProperty ("ok", true));
    REQUIRE (err.getProperty ("backend", {}).toString() == "maolan");
    REQUIRE (err.getProperty ("commandId", {}).toString() == "setTransport");

    auto* errorObject = err.getProperty ("error", {}).getDynamicObject();
    REQUIRE (errorObject != nullptr);
    REQUIRE (errorObject->getProperty ("code").toString() == "unsupported_by_backend");
    REQUIRE (errorObject->getProperty ("message").toString().contains ("transport"));
    REQUIRE (engineResultMessage (err).startsWith ("unsupported_by_backend:"));
}

TEST_CASE ("maolan process backend manages MOSH-owned session graph operations")
{
    auto outputDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                         .getNonexistentChildFile ("mosh-maolan-contract-unit", {});
    outputDir.createDirectory();

    EngineBackendContext context;
    context.sessionDir = outputDir.getChildFile ("session");
    context.repoRoot = juce::File::getCurrentWorkingDirectory();

    MaolanProcessBackend backend (context);

    auto* createArgs = new juce::DynamicObject();
    createArgs->setProperty ("outputDir", outputDir.getFullPathName());
    auto created = backend.createSession (juce::var (createArgs));
    REQUIRE ((bool) created.getProperty ("ok", false));
    REQUIRE (outputDir.getChildFile ("session-graph.json").existsAsFile());

    auto selected = backend.selectAudioDevice (juce::var());
    REQUIRE ((bool) selected.getProperty ("ok", false));
    REQUIRE (selected.getProperty ("data", {}).getProperty ("device", {}).toString() == "coreaudio:default");

    auto* trackArgs = new juce::DynamicObject();
    trackArgs->setProperty ("trackId", "track-unit");
    trackArgs->setProperty ("name", "Unit Track");
    auto track = backend.createTrack (juce::var (trackArgs));
    REQUIRE ((bool) track.getProperty ("ok", false));
    REQUIRE (track.getProperty ("data", {}).getProperty ("trackId", {}).toString() == "track-unit");

    auto initialBlocklist = backend.getPluginBlocklist (juce::var());
    REQUIRE ((bool) initialBlocklist.getProperty ("ok", false));
    REQUIRE (initialBlocklist.getProperty ("data", {}).getProperty ("blocklist", {}).isArray());
    REQUIRE (initialBlocklist.getProperty ("data", {}).getProperty ("blocklist", {}).size() == 0);

    auto* blockArgs = new juce::DynamicObject();
    blockArgs->setProperty ("pluginId", "jampilot-test-gain-vst3");
    auto blocked = backend.blockPlugin (juce::var (blockArgs));
    REQUIRE ((bool) blocked.getProperty ("ok", false));
    REQUIRE (blocked.getProperty ("data", {}).getProperty ("blocklist", {}).size() == 1);

    auto blockedScan = backend.scanPlugins (juce::var());
    REQUIRE ((bool) blockedScan.getProperty ("ok", false));
    REQUIRE ((int) blockedScan.getProperty ("data", {}).getProperty ("count", -1) == 0);
    REQUIRE (blockedScan.getProperty ("data", {}).getProperty ("plugins", {}).size() == 0);

    auto* blockedLoadArgs = new juce::DynamicObject();
    blockedLoadArgs->setProperty ("trackId", "track-unit");
    blockedLoadArgs->setProperty ("pluginId", "jampilot-test-gain-vst3");
    blockedLoadArgs->setProperty ("pluginPath", "/Users/emiliosanchez-harris/Library/Audio/Plug-Ins/VST3/JamPilotTestGain.vst3");
    auto blockedLoad = backend.loadPlugin (juce::var (blockedLoadArgs));
    REQUIRE_FALSE ((bool) blockedLoad.getProperty ("ok", true));
    REQUIRE (blockedLoad.getProperty ("error", {}).getProperty ("code", {}).toString() == "blocked_plugin");

    auto clearedBlocklist = backend.clearPluginBlocklist (juce::var());
    REQUIRE ((bool) clearedBlocklist.getProperty ("ok", false));
    REQUIRE (clearedBlocklist.getProperty ("data", {}).getProperty ("blocklist", {}).size() == 0);
    REQUIRE (backend.sessionGraph().getProperty ("pluginBlocklist", {}).isArray());
    REQUIRE (backend.sessionGraph().getProperty ("pluginBlocklist", {}).size() == 0);

    auto* renameArgs = new juce::DynamicObject();
    renameArgs->setProperty ("trackId", "track-unit");
    renameArgs->setProperty ("name", "Renamed Unit Track");
    auto renamed = backend.renameTrack (juce::var (renameArgs));
    REQUIRE ((bool) renamed.getProperty ("ok", false));
    REQUIRE (renamed.getProperty ("data", {}).getProperty ("name", {}).toString() == "Renamed Unit Track");

    auto* volumeArgs = new juce::DynamicObject();
    volumeArgs->setProperty ("trackId", "track-unit");
    volumeArgs->setProperty ("db", -7.5);
    auto volume = backend.setTrackVolume (juce::var (volumeArgs));
    REQUIRE ((bool) volume.getProperty ("ok", false));
    REQUIRE ((double) volume.getProperty ("data", {}).getProperty ("volumeDb", 0.0) == -7.5);

    auto* panArgs = new juce::DynamicObject();
    panArgs->setProperty ("trackId", "track-unit");
    panArgs->setProperty ("pan", 2.0);
    auto pan = backend.setTrackPan (juce::var (panArgs));
    REQUIRE ((bool) pan.getProperty ("ok", false));
    REQUIRE ((double) pan.getProperty ("data", {}).getProperty ("pan", 0.0) == 1.0);

    auto* muteArgs = new juce::DynamicObject();
    muteArgs->setProperty ("trackId", "track-unit");
    muteArgs->setProperty ("mute", true);
    auto mute = backend.setTrackMute (juce::var (muteArgs));
    REQUIRE ((bool) mute.getProperty ("ok", false));
    REQUIRE ((bool) mute.getProperty ("data", {}).getProperty ("mute", false));

    auto* soloArgs = new juce::DynamicObject();
    soloArgs->setProperty ("trackId", "track-unit");
    soloArgs->setProperty ("solo", true);
    auto solo = backend.setTrackSolo (juce::var (soloArgs));
    REQUIRE ((bool) solo.getProperty ("ok", false));
    REQUIRE ((bool) solo.getProperty ("data", {}).getProperty ("solo", false));

    auto* meterArgs = new juce::DynamicObject();
    meterArgs->setProperty ("trackId", "track-unit");
    auto meterEnabled = backend.enableTrackMeter (juce::var (meterArgs));
    REQUIRE ((bool) meterEnabled.getProperty ("ok", false));
    REQUIRE ((bool) meterEnabled.getProperty ("data", {}).getProperty ("meterEnabled", false));
    REQUIRE ((bool) backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("meterEnabled", false));

    auto allMeters = backend.enableAllMeters (juce::var());
    REQUIRE ((bool) allMeters.getProperty ("ok", false));
    REQUIRE ((int) allMeters.getProperty ("data", {}).getProperty ("count", 0) == 1);

    auto* meterDisableArgs = new juce::DynamicObject();
    meterDisableArgs->setProperty ("trackId", "track-unit");
    auto meterDisabled = backend.disableTrackMeter (juce::var (meterDisableArgs));
    REQUIRE ((bool) meterDisabled.getProperty ("ok", false));
    REQUIRE_FALSE ((bool) meterDisabled.getProperty ("data", {}).getProperty ("meterEnabled", true));

    auto* masterVolumeArgs = new juce::DynamicObject();
    masterVolumeArgs->setProperty ("db", -4.0);
    auto masterVolume = backend.setMasterVolume (juce::var (masterVolumeArgs));
    REQUIRE ((bool) masterVolume.getProperty ("ok", false));
    REQUIRE ((double) masterVolume.getProperty ("data", {}).getProperty ("volumeDb", 0.0) == -4.0);

    auto* masterPanArgs = new juce::DynamicObject();
    masterPanArgs->setProperty ("pan", -2.0);
    auto masterPan = backend.setMasterPan (juce::var (masterPanArgs));
    REQUIRE ((bool) masterPan.getProperty ("ok", false));
    REQUIRE ((double) masterPan.getProperty ("data", {}).getProperty ("pan", 0.0) == -1.0);

    auto* busArgs = new juce::DynamicObject();
    busArgs->setProperty ("name", "Unit Bus");
    auto createdBus = backend.createBus (juce::var (busArgs));
    REQUIRE ((bool) createdBus.getProperty ("ok", false));
    REQUIRE ((int) createdBus.getProperty ("data", {}).getProperty ("bus", -1) == 0);
    REQUIRE_FALSE ((bool) createdBus.getProperty ("data", {}).getProperty ("applied", true));

    auto* sendArgs = new juce::DynamicObject();
    sendArgs->setProperty ("trackId", "track-unit");
    sendArgs->setProperty ("bus", 0);
    sendArgs->setProperty ("db", -9.0);
    auto addedSend = backend.addSend (juce::var (sendArgs));
    REQUIRE ((bool) addedSend.getProperty ("ok", false));
    REQUIRE_FALSE ((bool) addedSend.getProperty ("data", {}).getProperty ("applied", true));

    auto* duplicateSendArgs = new juce::DynamicObject();
    duplicateSendArgs->setProperty ("trackId", "track-unit");
    duplicateSendArgs->setProperty ("bus", 0);
    duplicateSendArgs->setProperty ("db", -9.0);
    auto duplicateSend = backend.addSend (juce::var (duplicateSendArgs));
    REQUIRE_FALSE ((bool) duplicateSend.getProperty ("ok", true));
    REQUIRE (duplicateSend.getProperty ("error", {}).getProperty ("code", {}).toString() == "invalid_argument");

    auto* sendLevelArgs = new juce::DynamicObject();
    sendLevelArgs->setProperty ("trackId", "track-unit");
    sendLevelArgs->setProperty ("bus", 0);
    sendLevelArgs->setProperty ("db", -12.0);
    sendLevelArgs->setProperty ("mute", true);
    auto sendLevel = backend.setSendLevel (juce::var (sendLevelArgs));
    REQUIRE ((bool) sendLevel.getProperty ("ok", false));
    REQUIRE ((double) sendLevel.getProperty ("data", {}).getProperty ("db", 0.0) == -12.0);
    REQUIRE ((bool) sendLevel.getProperty ("data", {}).getProperty ("mute", false));

    auto secondBus = backend.createBus (juce::var());
    REQUIRE ((bool) secondBus.getProperty ("ok", false));
    auto* removeBusArgs = new juce::DynamicObject();
    removeBusArgs->setProperty ("bus", (int) secondBus.getProperty ("data", {}).getProperty ("bus", -1));
    auto removedBus = backend.removeBus (juce::var (removeBusArgs));
    REQUIRE ((bool) removedBus.getProperty ("ok", false));

    auto* inputArgs = new juce::DynamicObject();
    inputArgs->setProperty ("trackId", "track-unit");
    inputArgs->setProperty ("deviceID", "input-1-2");
    auto input = backend.setTrackInput (juce::var (inputArgs));
    REQUIRE ((bool) input.getProperty ("ok", false));
    REQUIRE_FALSE ((bool) input.getProperty ("data", {}).getProperty ("applied", true));
    REQUIRE (input.getProperty ("data", {}).getProperty ("deviceID", {}).toString() == "input-1-2");

    auto* armArgs = new juce::DynamicObject();
    armArgs->setProperty ("trackId", "track-unit");
    armArgs->setProperty ("armed", true);
    auto armed = backend.armTrack (juce::var (armArgs));
    REQUIRE ((bool) armed.getProperty ("ok", false));
    REQUIRE ((bool) armed.getProperty ("data", {}).getProperty ("armed", false));
    REQUIRE_FALSE ((bool) armed.getProperty ("data", {}).getProperty ("applied", true));

    auto* monitorArgs = new juce::DynamicObject();
    monitorArgs->setProperty ("trackId", "track-unit");
    monitorArgs->setProperty ("mode", "on");
    auto monitor = backend.setInputMonitor (juce::var (monitorArgs));
    REQUIRE ((bool) monitor.getProperty ("ok", false));
    REQUIRE (monitor.getProperty ("data", {}).getProperty ("mode", {}).toString() == "on");

    auto* badMonitorArgs = new juce::DynamicObject();
    badMonitorArgs->setProperty ("trackId", "track-unit");
    badMonitorArgs->setProperty ("mode", "banana");
    auto badMonitor = backend.setInputMonitor (juce::var (badMonitorArgs));
    REQUIRE_FALSE ((bool) badMonitor.getProperty ("ok", true));
    REQUIRE (badMonitor.getProperty ("error", {}).getProperty ("code", {}).toString() == "invalid_argument");

    auto stoppedRecording = backend.stopRecording (juce::var());
    REQUIRE ((bool) stoppedRecording.getProperty ("ok", false));
    REQUIRE_FALSE ((bool) stoppedRecording.getProperty ("data", {}).getProperty ("applied", true));
    REQUIRE (stoppedRecording.getProperty ("data", {}).getProperty ("clips", {}).isArray());

    auto* tempoArgs = new juce::DynamicObject();
    tempoArgs->setProperty ("bpm", 137.5);
    auto tempo = backend.setTempo (juce::var (tempoArgs));
    REQUIRE ((bool) tempo.getProperty ("ok", false));
    REQUIRE ((double) tempo.getProperty ("data", {}).getProperty ("bpm", 0.0) == 137.5);
    REQUIRE (tempo.getProperty ("data", {}).getProperty ("tempoMap", {}).size() == 1);

    auto* insertTempoArgs = new juce::DynamicObject();
    insertTempoArgs->setProperty ("time", 8.0);
    insertTempoArgs->setProperty ("bpm", 90.0);
    auto insertedTempo = backend.insertTempoChange (juce::var (insertTempoArgs));
    REQUIRE ((bool) insertedTempo.getProperty ("ok", false));
    REQUIRE (insertedTempo.getProperty ("data", {}).getProperty ("tempoMap", {}).size() == 2);

    auto* curveArgs = new juce::DynamicObject();
    curveArgs->setProperty ("index", 0);
    curveArgs->setProperty ("curve", 0.0);
    auto curve = backend.setTempoCurve (juce::var (curveArgs));
    REQUIRE ((bool) curve.getProperty ("ok", false));
    REQUIRE ((double) curve.getProperty ("data", {}).getProperty ("tempoMap", {})[0].getProperty ("curve", 1.0) == 0.0);

    auto* removeTempoArgs = new juce::DynamicObject();
    removeTempoArgs->setProperty ("index", 1);
    auto removedTempo = backend.removeTempoChange (juce::var (removeTempoArgs));
    REQUIRE ((bool) removedTempo.getProperty ("ok", false));
    REQUIRE (removedTempo.getProperty ("data", {}).getProperty ("tempoMap", {}).size() == 1);

    auto* signatureArgs = new juce::DynamicObject();
    signatureArgs->setProperty ("numerator", 7);
    signatureArgs->setProperty ("denominator", 8);
    auto signature = backend.setTimeSignature (juce::var (signatureArgs));
    REQUIRE ((bool) signature.getProperty ("ok", false));
    REQUIRE ((int) signature.getProperty ("data", {}).getProperty ("numerator", 0) == 7);
    REQUIRE ((int) signature.getProperty ("data", {}).getProperty ("denominator", 0) == 8);
    REQUIRE (signature.getProperty ("data", {}).getProperty ("timeSigMap", {}).size() == 1);

    auto* insertSignatureArgs = new juce::DynamicObject();
    insertSignatureArgs->setProperty ("time", 12.0);
    insertSignatureArgs->setProperty ("numerator", 3);
    insertSignatureArgs->setProperty ("denominator", 4);
    auto insertedSignature = backend.insertTimeSigChange (juce::var (insertSignatureArgs));
    REQUIRE ((bool) insertedSignature.getProperty ("ok", false));
    REQUIRE (insertedSignature.getProperty ("data", {}).getProperty ("timeSigMap", {}).size() == 2);

    auto* removeSignatureArgs = new juce::DynamicObject();
    removeSignatureArgs->setProperty ("index", 1);
    auto removedSignature = backend.removeTimeSigChange (juce::var (removeSignatureArgs));
    REQUIRE ((bool) removedSignature.getProperty ("ok", false));
    REQUIRE (removedSignature.getProperty ("data", {}).getProperty ("timeSigMap", {}).size() == 1);

    auto* badSignatureArgs = new juce::DynamicObject();
    badSignatureArgs->setProperty ("numerator", 4);
    badSignatureArgs->setProperty ("denominator", 5);
    auto badSignature = backend.setTimeSignature (juce::var (badSignatureArgs));
    REQUIRE_FALSE ((bool) badSignature.getProperty ("ok", true));
    REQUIRE (badSignature.getProperty ("error", {}).getProperty ("code", {}).toString() == "invalid_argument");

    auto* metronomeArgs = new juce::DynamicObject();
    metronomeArgs->setProperty ("enabled", true);
    auto metronome = backend.setMetronome (juce::var (metronomeArgs));
    REQUIRE ((bool) metronome.getProperty ("ok", false));
    REQUIRE ((bool) metronome.getProperty ("data", {}).getProperty ("enabled", false));

    auto* projectArgs = new juce::DynamicObject();
    projectArgs->setProperty ("sampleRate", 96000.0);
    projectArgs->setProperty ("bitDepth", 16);
    projectArgs->setProperty ("timeBase", "barsBeats");
    auto project = backend.setProjectSettings (juce::var (projectArgs));
    REQUIRE ((bool) project.getProperty ("ok", false));
    REQUIRE ((double) project.getProperty ("data", {}).getProperty ("project", {}).getProperty ("sampleRate", 0.0) == 96000.0);
    REQUIRE ((int) project.getProperty ("data", {}).getProperty ("project", {}).getProperty ("bitDepth", 0) == 16);
    REQUIRE (project.getProperty ("data", {}).getProperty ("project", {}).getProperty ("timeBase", {}).toString() == "barsBeats");

    auto* badProjectArgs = new juce::DynamicObject();
    badProjectArgs->setProperty ("bitDepth", 20);
    auto badProject = backend.setProjectSettings (juce::var (badProjectArgs));
    REQUIRE_FALSE ((bool) badProject.getProperty ("ok", true));
    REQUIRE (badProject.getProperty ("error", {}).getProperty ("code", {}).toString() == "invalid_argument");

    auto formatGraph = backend.sessionGraph();
    REQUIRE ((double) formatGraph.getProperty ("tempo", 0.0) == 137.5);
    REQUIRE ((double) formatGraph.getProperty ("tempoMap", {})[0].getProperty ("curve", 1.0) == 0.0);
    REQUIRE ((int) formatGraph.getProperty ("timeSigNumerator", 0) == 7);
    REQUIRE ((int) formatGraph.getProperty ("timeSigDenominator", 0) == 8);
    REQUIRE ((bool) formatGraph.getProperty ("metronome", false));
    REQUIRE ((double) formatGraph.getProperty ("project", {}).getProperty ("sampleRate", 0.0) == 96000.0);
    REQUIRE ((int) formatGraph.getProperty ("project", {}).getProperty ("bitDepth", 0) == 16);
    REQUIRE (formatGraph.getProperty ("project", {}).getProperty ("timeBase", {}).toString() == "barsBeats");
    REQUIRE ((double) formatGraph.getProperty ("master", {}).getProperty ("volumeDb", 0.0) == -4.0);
    REQUIRE ((double) formatGraph.getProperty ("master", {}).getProperty ("pan", 0.0) == -1.0);
    REQUIRE (formatGraph.getProperty ("buses", {}).size() == 1);
    REQUIRE ((int) formatGraph.getProperty ("buses", {})[0].getProperty ("bus", -1) == 0);
    REQUIRE ((bool) formatGraph.getProperty ("tracks", {})[0].getProperty ("armed", false));
    REQUIRE (formatGraph.getProperty ("tracks", {})[0].getProperty ("monitor", {}).toString() == "on");
    REQUIRE (formatGraph.getProperty ("tracks", {})[0].getProperty ("input", {}).getProperty ("deviceID", {}).toString() == "input-1-2");
    REQUIRE (formatGraph.getProperty ("tracks", {})[0].getProperty ("sends", {}).size() == 1);
    REQUIRE ((int) formatGraph.getProperty ("tracks", {})[0].getProperty ("sends", {})[0].getProperty ("bus", -1) == 0);
    REQUIRE ((bool) formatGraph.getProperty ("tracks", {})[1].getProperty ("isReturn", false));
    REQUIRE ((int) formatGraph.getProperty ("tracks", {})[1].getProperty ("returnBus", -1) == 0);

    auto* clipArgs = new juce::DynamicObject();
    clipArgs->setProperty ("trackId", "track-unit");
    clipArgs->setProperty ("clipId", "clip-unit");
    clipArgs->setProperty ("sourceKind", "test-tone");
    clipArgs->setProperty ("name", "Unit Tone");
    clipArgs->setProperty ("seconds", 1.0);
    clipArgs->setProperty ("freq", 440.0);
    auto clip = backend.addClip (juce::var (clipArgs));
    REQUIRE ((bool) clip.getProperty ("ok", false));
    REQUIRE (clip.getProperty ("data", {}).getProperty ("clipId", {}).toString() == "clip-unit");
    REQUIRE (juce::File (clip.getProperty ("data", {}).getProperty ("file", {}).toString()).existsAsFile());

    auto* fileClipArgs = new juce::DynamicObject();
    fileClipArgs->setProperty ("trackId", "track-unit");
    fileClipArgs->setProperty ("clipId", "clip-file-import");
    fileClipArgs->setProperty ("sourceKind", "file");
    fileClipArgs->setProperty ("file", clip.getProperty ("data", {}).getProperty ("file", {}));
    fileClipArgs->setProperty ("name", "Imported Unit Tone");
    fileClipArgs->setProperty ("start", 2.0);
    auto fileClip = backend.addClip (juce::var (fileClipArgs));
    REQUIRE ((bool) fileClip.getProperty ("ok", false));
    REQUIRE (fileClip.getProperty ("data", {}).getProperty ("clipId", {}).toString() == "clip-file-import");
    REQUIRE (fileClip.getProperty ("data", {}).getProperty ("sourceKind", {}).toString() == "file");
    REQUIRE ((double) fileClip.getProperty ("data", {}).getProperty ("lengthSeconds", 0.0) > 0.0);

    auto* removeFileClipArgs = new juce::DynamicObject();
    removeFileClipArgs->setProperty ("clipId", "clip-file-import");
    REQUIRE ((bool) backend.removeClip (juce::var (removeFileClipArgs)).getProperty ("ok", false));

    auto* peaksArgs = new juce::DynamicObject();
    peaksArgs->setProperty ("clipId", "clip-unit");
    peaksArgs->setProperty ("buckets", 64);
    auto peaks = backend.getClipPeaks (juce::var (peaksArgs));
    REQUIRE ((bool) peaks.getProperty ("ok", false));
    REQUIRE ((int) peaks.getProperty ("data", {}).getProperty ("buckets", 0) > 0);
    REQUIRE (peaks.getProperty ("data", {}).getProperty ("peaks", {}).isArray());

    auto* moveArgs = new juce::DynamicObject();
    moveArgs->setProperty ("clipId", "clip-unit");
    moveArgs->setProperty ("start", 0.5);
    auto moved = backend.moveClip (juce::var (moveArgs));
    REQUIRE ((bool) moved.getProperty ("ok", false));
    REQUIRE ((double) moved.getProperty ("data", {}).getProperty ("start", 0.0) == 0.5);

    auto* trimArgs = new juce::DynamicObject();
    trimArgs->setProperty ("clipId", "clip-unit");
    trimArgs->setProperty ("start", 0.5);
    trimArgs->setProperty ("length", 0.75);
    trimArgs->setProperty ("offset", 0.1);
    auto trimmed = backend.trimClip (juce::var (trimArgs));
    REQUIRE ((bool) trimmed.getProperty ("ok", false));
    REQUIRE ((double) trimmed.getProperty ("data", {}).getProperty ("length", 0.0) == 0.75);

    auto* renameClipArgs = new juce::DynamicObject();
    renameClipArgs->setProperty ("clipId", "clip-unit");
    renameClipArgs->setProperty ("name", "Renamed Unit Tone");
    auto renamedClip = backend.renameClip (juce::var (renameClipArgs));
    REQUIRE ((bool) renamedClip.getProperty ("ok", false));
    REQUIRE (renamedClip.getProperty ("data", {}).getProperty ("name", {}).toString() == "Renamed Unit Tone");

    auto* gainArgs = new juce::DynamicObject();
    gainArgs->setProperty ("clipId", "clip-unit");
    gainArgs->setProperty ("gainDb", -2.0);
    auto gain = backend.setClipGain (juce::var (gainArgs));
    REQUIRE ((bool) gain.getProperty ("ok", false));
    REQUIRE ((double) gain.getProperty ("data", {}).getProperty ("gainDb", 0.0) == -2.0);

    auto* muteClipArgs = new juce::DynamicObject();
    muteClipArgs->setProperty ("clipId", "clip-unit");
    muteClipArgs->setProperty ("mute", true);
    auto mutedClip = backend.setClipMute (juce::var (muteClipArgs));
    REQUIRE ((bool) mutedClip.getProperty ("ok", false));
    REQUIRE ((bool) mutedClip.getProperty ("data", {}).getProperty ("mute", false));

    auto* warpArgs = new juce::DynamicObject();
    warpArgs->setProperty ("clipId", "clip-unit");
    warpArgs->setProperty ("autoTempo", true);
    warpArgs->setProperty ("sourceBpm", 137.5);
    auto warped = backend.setClipWarp (juce::var (warpArgs));
    REQUIRE ((bool) warped.getProperty ("ok", false));
    REQUIRE ((bool) warped.getProperty ("data", {}).getProperty ("autoTempo", false));
    REQUIRE (warped.getProperty ("data", {}).getProperty ("stretchMode", {}).toString().containsIgnoreCase ("soundtouch"));

    auto* unwarpArgs = new juce::DynamicObject();
    unwarpArgs->setProperty ("clipId", "clip-unit");
    unwarpArgs->setProperty ("autoTempo", false);
    auto unwarped = backend.setClipWarp (juce::var (unwarpArgs));
    REQUIRE ((bool) unwarped.getProperty ("ok", false));
    REQUIRE_FALSE ((bool) unwarped.getProperty ("data", {}).getProperty ("autoTempo", true));

    auto mixerGraph = backend.sessionGraph().getProperty ("tracks", {})[0];
    REQUIRE ((double) mixerGraph.getProperty ("volumeDb", 0.0) == -7.5);
    REQUIRE ((double) mixerGraph.getProperty ("pan", 0.0) == 1.0);
    REQUIRE ((bool) mixerGraph.getProperty ("mute", false));
    REQUIRE ((bool) mixerGraph.getProperty ("solo", false));
    REQUIRE (mixerGraph.getProperty ("clips", {}).size() == 1);
    auto clipGraph = mixerGraph.getProperty ("clips", {})[0];
    REQUIRE (clipGraph.getProperty ("name", {}).toString() == "Renamed Unit Tone");
    REQUIRE ((double) clipGraph.getProperty ("startSeconds", 0.0) == 0.5);
    REQUIRE ((double) clipGraph.getProperty ("lengthSeconds", 0.0) == 0.75);
    REQUIRE ((double) clipGraph.getProperty ("offsetSeconds", 0.0) == 0.1);
    REQUIRE ((double) clipGraph.getProperty ("gainDb", 0.0) == -2.0);
    REQUIRE ((bool) clipGraph.getProperty ("mute", false));

    auto* duplicateArgs = new juce::DynamicObject();
    duplicateArgs->setProperty ("clipId", "clip-unit");
    duplicateArgs->setProperty ("newClipId", "clip-unit-copy");
    auto duplicated = backend.duplicateClip (juce::var (duplicateArgs));
    REQUIRE ((bool) duplicated.getProperty ("ok", false));
    REQUIRE (duplicated.getProperty ("data", {}).getProperty ("newClipId", {}).toString() == "clip-unit-copy");
    auto graphAfterDuplicate = backend.sessionGraph().getProperty ("tracks", {})[0];
    REQUIRE (graphAfterDuplicate.getProperty ("clips", {}).size() == 2);
    auto duplicateGraph = graphAfterDuplicate.getProperty ("clips", {})[1];
    REQUIRE (duplicateGraph.getProperty ("id", {}).toString() == "clip-unit-copy");
    REQUIRE ((double) duplicateGraph.getProperty ("startSeconds", 0.0) == 1.25);
    REQUIRE ((double) duplicateGraph.getProperty ("lengthSeconds", 0.0) == 0.75);
    REQUIRE ((double) duplicateGraph.getProperty ("offsetSeconds", 0.0) == 0.1);

    auto second = backend.createTrack (juce::var());
    REQUIRE ((bool) second.getProperty ("ok", false));
    const auto secondTrackId = second.getProperty ("data", {}).getProperty ("trackId", {}).toString();
    REQUIRE (secondTrackId.isNotEmpty());
    REQUIRE (secondTrackId != "track-unit");

    auto* outputArgs = new juce::DynamicObject();
    outputArgs->setProperty ("trackId", "track-unit");
    outputArgs->setProperty ("destTrackId", secondTrackId);
    auto output = backend.setTrackOutput (juce::var (outputArgs));
    REQUIRE ((bool) output.getProperty ("ok", false));
    REQUIRE (output.getProperty ("data", {}).getProperty ("destTrackId", {}).toString() == secondTrackId);
    REQUIRE (backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("output", {}).getProperty ("destId", {}).toString() == secondTrackId);

    auto* cycleArgs = new juce::DynamicObject();
    cycleArgs->setProperty ("trackId", secondTrackId);
    cycleArgs->setProperty ("destTrackId", "track-unit");
    auto cycle = backend.setTrackOutput (juce::var (cycleArgs));
    REQUIRE_FALSE ((bool) cycle.getProperty ("ok", true));
    REQUIRE (cycle.getProperty ("error", {}).getProperty ("code", {}).toString() == "invalid_argument");

    auto* defaultOutputArgs = new juce::DynamicObject();
    defaultOutputArgs->setProperty ("trackId", "track-unit");
    defaultOutputArgs->setProperty ("output", "default");
    REQUIRE ((bool) backend.setTrackOutput (juce::var (defaultOutputArgs)).getProperty ("ok", false));

    juce::Array<juce::var> groupTrackIds;
    groupTrackIds.add ("track-unit");
    groupTrackIds.add (secondTrackId);
    auto* groupArgs = new juce::DynamicObject();
    groupArgs->setProperty ("groupId", "group-unit");
    groupArgs->setProperty ("name", "Unit Group");
    groupArgs->setProperty ("trackIds", groupTrackIds);
    auto group = backend.createGroupTrack (juce::var (groupArgs));
    REQUIRE ((bool) group.getProperty ("ok", false));
    REQUIRE (group.getProperty ("data", {}).getProperty ("groupId", {}).toString() == "group-unit");
    REQUIRE ((int) group.getProperty ("data", {}).getProperty ("moved", 0) == 2);
    auto groupedGraph = backend.sessionGraph();
    bool sawGroup = false;
    bool sawGroupedUnit = false;
    bool sawGroupedSecond = false;
    if (auto* graphTracks = groupedGraph.getProperty ("tracks", {}).getArray())
        for (const auto& graphTrack : *graphTracks)
        {
            const auto id = graphTrack.getProperty ("id", {}).toString();
            if (id == "group-unit")
            {
                sawGroup = true;
                REQUIRE (graphTrack.getProperty ("type", {}).toString() == "group");
                REQUIRE ((bool) graphTrack.getProperty ("isGroup", false));
            }
            if (id == "track-unit")
                sawGroupedUnit = graphTrack.getProperty ("parentId", {}).toString() == "group-unit";
            if (id == secondTrackId)
                sawGroupedSecond = graphTrack.getProperty ("parentId", {}).toString() == "group-unit";
        }
    REQUIRE (sawGroup);
    REQUIRE (sawGroupedUnit);
    REQUIRE (sawGroupedSecond);

    auto* ungroupArgs = new juce::DynamicObject();
    ungroupArgs->setProperty ("trackId", "group-unit");
    auto ungrouped = backend.ungroupTrack (juce::var (ungroupArgs));
    REQUIRE ((bool) ungrouped.getProperty ("ok", false));
    REQUIRE ((int) ungrouped.getProperty ("data", {}).getProperty ("hoisted", 0) == 2);
    auto ungroupedGraph = backend.sessionGraph();
    if (auto* graphTracks = ungroupedGraph.getProperty ("tracks", {}).getArray())
        for (const auto& graphTrack : *graphTracks)
        {
            REQUIRE (graphTrack.getProperty ("id", {}).toString() != "group-unit");
            if (graphTrack.getProperty ("id", {}).toString() == "track-unit"
                || graphTrack.getProperty ("id", {}).toString() == secondTrackId)
                REQUIRE (graphTrack.getProperty ("parentId", {}).toString().isEmpty());
        }

    auto graphWithPasteTarget = backend.sessionGraph();
    REQUIRE (graphWithPasteTarget.getProperty ("tracks", {}).size() >= 2);
    bool hasUnitTrack = false;
    bool hasPasteTarget = false;
    if (auto* graphTracks = graphWithPasteTarget.getProperty ("tracks", {}).getArray())
        for (const auto& graphTrack : *graphTracks)
        {
            const auto id = graphTrack.getProperty ("id", {}).toString();
            hasUnitTrack = hasUnitTrack || id == "track-unit";
            hasPasteTarget = hasPasteTarget || id == secondTrackId;
        }
    REQUIRE (hasUnitTrack);
    REQUIRE (hasPasteTarget);

    auto* pasteClipDesc = new juce::DynamicObject();
    pasteClipDesc->setProperty ("id", "clip-unit");
    pasteClipDesc->setProperty ("type", "wave");
    pasteClipDesc->setProperty ("sourcePath", clipGraph.getProperty ("sourcePath", {}));
    pasteClipDesc->setProperty ("name", "Pasted Unit Tone");
    pasteClipDesc->setProperty ("length", 0.75);
    pasteClipDesc->setProperty ("offset", 0.1);
    pasteClipDesc->setProperty ("gainDb", -2.0);
    pasteClipDesc->setProperty ("mute", true);

    auto* pasteArgs = new juce::DynamicObject();
    pasteArgs->setProperty ("trackId", secondTrackId);
    pasteArgs->setProperty ("newClipId", "clip-unit-paste");
    pasteArgs->setProperty ("start", 2.0);
    pasteArgs->setProperty ("clip", juce::var (pasteClipDesc));
    auto pasted = backend.pasteClip (juce::var (pasteArgs));
    REQUIRE ((bool) pasted.getProperty ("ok", false));
    REQUIRE (pasted.getProperty ("data", {}).getProperty ("newClipId", {}).toString() == "clip-unit-paste");
    auto graphAfterPaste = backend.sessionGraph();
    juce::var pasteTargetGraph;
    if (auto* graphTracks = graphAfterPaste.getProperty ("tracks", {}).getArray())
        for (const auto& graphTrack : *graphTracks)
            if (graphTrack.getProperty ("id", {}).toString() == secondTrackId)
            {
                pasteTargetGraph = graphTrack;
                break;
            }
    REQUIRE (pasteTargetGraph.isObject());
    REQUIRE (pasteTargetGraph.getProperty ("clips", {}).size() == 1);
    auto pasteGraph = pasteTargetGraph.getProperty ("clips", {})[0];
    REQUIRE (pasteGraph.getProperty ("id", {}).toString() == "clip-unit-paste");
    REQUIRE ((double) pasteGraph.getProperty ("startSeconds", 0.0) == 2.0);
    REQUIRE ((double) pasteGraph.getProperty ("lengthSeconds", 0.0) == 0.75);
    REQUIRE ((double) pasteGraph.getProperty ("offsetSeconds", 0.0) == 0.1);
    REQUIRE ((double) pasteGraph.getProperty ("gainDb", 0.0) == -2.0);
    REQUIRE ((bool) pasteGraph.getProperty ("mute", false));

    auto* removeArgs = new juce::DynamicObject();
    removeArgs->setProperty ("trackId", secondTrackId);
    auto removed = backend.removeTrack (juce::var (removeArgs));
    REQUIRE ((bool) removed.getProperty ("ok", false));
    auto graphAfterRemoveTrack = backend.sessionGraph();
    REQUIRE (graphAfterRemoveTrack.getProperty ("tracks", {}).size() == 2);
    bool removedTargetStillPresent = false;
    if (auto* graphTracks = graphAfterRemoveTrack.getProperty ("tracks", {}).getArray())
        for (const auto& graphTrack : *graphTracks)
            removedTargetStillPresent = removedTargetStillPresent
                                        || graphTrack.getProperty ("id", {}).toString() == secondTrackId;
    REQUIRE_FALSE (removedTargetStillPresent);

    auto* removableClipArgs = new juce::DynamicObject();
    removableClipArgs->setProperty ("trackId", "track-unit");
    removableClipArgs->setProperty ("clipId", "clip-remove");
    removableClipArgs->setProperty ("sourceKind", "test-tone");
    removableClipArgs->setProperty ("seconds", 0.25);
    REQUIRE ((bool) backend.addClip (juce::var (removableClipArgs)).getProperty ("ok", false));
    auto* removeClipArgs = new juce::DynamicObject();
    removeClipArgs->setProperty ("clipId", "clip-remove");
    REQUIRE ((bool) backend.removeClip (juce::var (removeClipArgs)).getProperty ("ok", false));
    REQUIRE (backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("clips", {}).size() == 2);

    auto* rangeClipArgs = new juce::DynamicObject();
    rangeClipArgs->setProperty ("trackId", "track-unit");
    rangeClipArgs->setProperty ("clipId", "clip-range");
    rangeClipArgs->setProperty ("sourceKind", "test-tone");
    rangeClipArgs->setProperty ("seconds", 2.0);
    rangeClipArgs->setProperty ("start", 3.0);
    REQUIRE ((bool) backend.addClip (juce::var (rangeClipArgs)).getProperty ("ok", false));
    auto* rangeArgs = new juce::DynamicObject();
    rangeArgs->setProperty ("start", 3.5);
    rangeArgs->setProperty ("end", 4.25);
    juce::Array<juce::var> rangeTrackIds;
    rangeTrackIds.add ("track-unit");
    rangeArgs->setProperty ("trackIds", rangeTrackIds);
    auto rangeDeleted = backend.deleteTimeRange (juce::var (rangeArgs));
    REQUIRE ((bool) rangeDeleted.getProperty ("ok", false));
    REQUIRE ((int) rangeDeleted.getProperty ("data", {}).getProperty ("removed", 0) == 1);
    REQUIRE ((int) rangeDeleted.getProperty ("data", {}).getProperty ("splits", 0) == 2);
    auto graphAfterRangeDelete = backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("clips", {});
    REQUIRE (graphAfterRangeDelete.size() == 4);
    REQUIRE (graphAfterRangeDelete[2].getProperty ("id", {}).toString() == "clip-range");
    REQUIRE ((double) graphAfterRangeDelete[2].getProperty ("lengthSeconds", 0.0) == 0.5);
    REQUIRE (graphAfterRangeDelete[3].getProperty ("id", {}).toString() == "clip-range-after-delete");
    REQUIRE ((double) graphAfterRangeDelete[3].getProperty ("startSeconds", 0.0) == 4.25);
    REQUIRE ((double) graphAfterRangeDelete[3].getProperty ("lengthSeconds", 0.0) == 0.75);
    REQUIRE ((double) graphAfterRangeDelete[3].getProperty ("offsetSeconds", 0.0) == 1.25);

    juce::Array<juce::var> seedNotes;
    for (int i = 0; i < 3; ++i)
    {
        auto* note = new juce::DynamicObject();
        note->setProperty ("pitch", 60 + i);
        note->setProperty ("start", (double) i + 0.2);
        note->setProperty ("length", 0.5);
        note->setProperty ("velocity", 90);
        seedNotes.add (juce::var (note));
    }
    auto* midiArgs = new juce::DynamicObject();
    midiArgs->setProperty ("trackId", "track-unit");
    midiArgs->setProperty ("clipId", "clip-midi-unit");
    midiArgs->setProperty ("name", "Unit MIDI");
    midiArgs->setProperty ("notes", juce::var (seedNotes));
    auto midiClip = backend.addMidiClip (juce::var (midiArgs));
    REQUIRE ((bool) midiClip.getProperty ("ok", false));
    REQUIRE (midiClip.getProperty ("data", {}).getProperty ("notes", {}).size() == 3);

    auto* addNoteArgs = new juce::DynamicObject();
    addNoteArgs->setProperty ("clipId", "clip-midi-unit");
    addNoteArgs->setProperty ("pitch", 72);
    addNoteArgs->setProperty ("start", 1.4);
    addNoteArgs->setProperty ("length", 1.0);
    addNoteArgs->setProperty ("velocity", 100);
    auto addedNote = backend.addNote (juce::var (addNoteArgs));
    REQUIRE ((bool) addedNote.getProperty ("ok", false));
    REQUIRE ((int) addedNote.getProperty ("data", {}).getProperty ("noteCount", 0) == 4);

    auto* setNoteArgs = new juce::DynamicObject();
    setNoteArgs->setProperty ("clipId", "clip-midi-unit");
    setNoteArgs->setProperty ("noteIndex", 0);
    setNoteArgs->setProperty ("pitch", 48);
    setNoteArgs->setProperty ("velocity", 127);
    auto setNote = backend.setNote (juce::var (setNoteArgs));
    REQUIRE ((bool) setNote.getProperty ("ok", false));
    REQUIRE ((int) setNote.getProperty ("data", {}).getProperty ("pitch", -1) == 48);
    REQUIRE ((int) setNote.getProperty ("data", {}).getProperty ("velocity", -1) == 127);

    auto* quantizeArgs = new juce::DynamicObject();
    quantizeArgs->setProperty ("clipId", "clip-midi-unit");
    quantizeArgs->setProperty ("division", 1.0);
    auto quantized = backend.quantizeNotes (juce::var (quantizeArgs));
    REQUIRE ((bool) quantized.getProperty ("ok", false));
    REQUIRE ((int) quantized.getProperty ("data", {}).getProperty ("moved", -1) > 0);

    auto* removeNoteArgs = new juce::DynamicObject();
    removeNoteArgs->setProperty ("clipId", "clip-midi-unit");
    removeNoteArgs->setProperty ("noteIndex", 0);
    auto removedNote = backend.removeNote (juce::var (removeNoteArgs));
    REQUIRE ((bool) removedNote.getProperty ("ok", false));
    REQUIRE ((int) removedNote.getProperty ("data", {}).getProperty ("noteCount", 0) == 3);
    auto midiGraph = backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("clips", {});
    bool sawMidiClip = false;
    for (int i = 0; i < midiGraph.size(); ++i)
        if (midiGraph[i].getProperty ("id", {}).toString() == "clip-midi-unit")
        {
            sawMidiClip = true;
            REQUIRE (midiGraph[i].getProperty ("notes", {}).size() == 3);
            REQUIRE ((int) midiGraph[i].getProperty ("notes", {})[0].getProperty ("pitch", -1) != 60);
        }
    REQUIRE (sawMidiClip);

    const auto seededGraph = juce::String (R"json({
  "schemaVersion": 1,
  "backend": "maolan",
  "device": "coreaudio:default",
  "sessionId": "plugin-unit",
  "tracks": [
    {
      "id": "track-unit",
      "name": "Plugin Unit Track",
      "type": "audio",
      "volumeDb": -7.5,
      "pan": 1.0,
      "mute": true,
      "solo": true,
      "clips": [],
      "plugins": [
        {
          "id": "jampilot-test-gain-vst3",
          "format": "vst3",
          "path": "/Users/emiliosanchez-harris/Library/Audio/Plug-Ins/VST3/JamPilotTestGain.vst3",
          "name": "JamPilotTestGain.vst3",
          "enabled": true,
          "params": []
        },
        {
          "id": "jampilot-test-gain-vst3-second",
          "format": "vst3",
          "path": "/Users/emiliosanchez-harris/Library/Audio/Plug-Ins/VST3/JamPilotTestGain.vst3",
          "name": "JamPilotTestGain.vst3 Second",
          "enabled": true,
          "params": []
        }
      ]
    }
  ],
  "transport": { "playing": false, "position": 0.0 }
})json");
    outputDir.getChildFile ("session-graph.json").replaceWithText (seededGraph + "\n");
    auto openedPluginGraph = backend.openSession (juce::var());
    REQUIRE ((bool) openedPluginGraph.getProperty ("ok", false));

    auto* paramArgs = new juce::DynamicObject();
    paramArgs->setProperty ("trackId", "track-unit");
    paramArgs->setProperty ("index", 0);
    paramArgs->setProperty ("paramIndex", 2);
    paramArgs->setProperty ("value", 1.5);
    auto param = backend.setPluginParam (juce::var (paramArgs));
    REQUIRE ((bool) param.getProperty ("ok", false));
    REQUIRE ((double) param.getProperty ("data", {}).getProperty ("params", {})[0].getProperty ("value", 0.0) == 1.0);

    auto* automationAArgs = new juce::DynamicObject();
    automationAArgs->setProperty ("trackId", "track-unit");
    automationAArgs->setProperty ("pluginIndex", 0);
    automationAArgs->setProperty ("paramIndex", 2);
    automationAArgs->setProperty ("time", 0.0);
    automationAArgs->setProperty ("value", 0.2);
    auto automationA = backend.addAutomationPoint (juce::var (automationAArgs));
    REQUIRE ((bool) automationA.getProperty ("ok", false));
    REQUIRE ((int) automationA.getProperty ("data", {}).getProperty ("pointIndex", -1) == 0);
    REQUIRE ((bool) automationA.getProperty ("data", {}).getProperty ("automated", false));

    auto* automationBArgs = new juce::DynamicObject();
    automationBArgs->setProperty ("trackId", "track-unit");
    automationBArgs->setProperty ("pluginIndex", 0);
    automationBArgs->setProperty ("paramIndex", 2);
    automationBArgs->setProperty ("time", 2.0);
    automationBArgs->setProperty ("value", 0.8);
    auto automationB = backend.addAutomationPoint (juce::var (automationBArgs));
    REQUIRE ((bool) automationB.getProperty ("ok", false));
    REQUIRE (automationB.getProperty ("data", {}).getProperty ("points", {}).size() == 2);

    auto* automationSetArgs = new juce::DynamicObject();
    automationSetArgs->setProperty ("trackId", "track-unit");
    automationSetArgs->setProperty ("pluginIndex", 0);
    automationSetArgs->setProperty ("paramIndex", 2);
    automationSetArgs->setProperty ("pointIndex", 0);
    automationSetArgs->setProperty ("time", 0.5);
    automationSetArgs->setProperty ("value", 0.5);
    auto automationSet = backend.setAutomationPoint (juce::var (automationSetArgs));
    REQUIRE ((bool) automationSet.getProperty ("ok", false));
    REQUIRE ((double) automationSet.getProperty ("data", {}).getProperty ("points", {})[0].getProperty ("v", 0.0) == 0.5);

    auto* automationRemoveArgs = new juce::DynamicObject();
    automationRemoveArgs->setProperty ("trackId", "track-unit");
    automationRemoveArgs->setProperty ("pluginIndex", 0);
    automationRemoveArgs->setProperty ("paramIndex", 2);
    automationRemoveArgs->setProperty ("pointIndex", 0);
    auto automationRemove = backend.removeAutomationPoint (juce::var (automationRemoveArgs));
    REQUIRE ((bool) automationRemove.getProperty ("ok", false));
    REQUIRE (automationRemove.getProperty ("data", {}).getProperty ("points", {}).size() == 1);

    auto* automationClearArgs = new juce::DynamicObject();
    automationClearArgs->setProperty ("trackId", "track-unit");
    automationClearArgs->setProperty ("pluginIndex", 0);
    automationClearArgs->setProperty ("paramIndex", 2);
    auto automationClear = backend.clearAutomation (juce::var (automationClearArgs));
    REQUIRE ((bool) automationClear.getProperty ("ok", false));
    REQUIRE_FALSE ((bool) automationClear.getProperty ("data", {}).getProperty ("automated", true));
    REQUIRE (automationClear.getProperty ("data", {}).getProperty ("points", {}).size() == 0);

    auto* bypassArgs = new juce::DynamicObject();
    bypassArgs->setProperty ("trackId", "track-unit");
    bypassArgs->setProperty ("index", 0);
    bypassArgs->setProperty ("bypassed", true);
    auto bypass = backend.bypassPlugin (juce::var (bypassArgs));
    REQUIRE ((bool) bypass.getProperty ("ok", false));
    REQUIRE_FALSE ((bool) bypass.getProperty ("data", {}).getProperty ("enabled", true));

    auto pluginGraph = backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("plugins", {})[0];
    REQUIRE_FALSE ((bool) pluginGraph.getProperty ("enabled", true));
    REQUIRE ((double) pluginGraph.getProperty ("params", {})[0].getProperty ("value", 0.0) == 1.0);

    auto* reorderArgs = new juce::DynamicObject();
    reorderArgs->setProperty ("trackId", "track-unit");
    reorderArgs->setProperty ("index", 1);
    reorderArgs->setProperty ("toIndex", 0);
    auto reorderedPlugin = backend.reorderPlugin (juce::var (reorderArgs));
    REQUIRE ((bool) reorderedPlugin.getProperty ("ok", false));
    REQUIRE ((int) reorderedPlugin.getProperty ("data", {}).getProperty ("index", -1) == 0);
    auto reorderedGraph = backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("plugins", {});
    REQUIRE (reorderedGraph.size() == 2);
    REQUIRE (reorderedGraph[0].getProperty ("id", {}).toString() == "jampilot-test-gain-vst3-second");
    REQUIRE (reorderedGraph[1].getProperty ("id", {}).toString() == "jampilot-test-gain-vst3");

    auto* removePluginArgs = new juce::DynamicObject();
    removePluginArgs->setProperty ("trackId", "track-unit");
    removePluginArgs->setProperty ("index", 0);
    auto removedPlugin = backend.removePlugin (juce::var (removePluginArgs));
    REQUIRE ((bool) removedPlugin.getProperty ("ok", false));
    REQUIRE (backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("plugins", {}).size() == 1);
    auto* removeLastPluginArgs = new juce::DynamicObject();
    removeLastPluginArgs->setProperty ("trackId", "track-unit");
    removeLastPluginArgs->setProperty ("index", 0);
    auto removedLastPlugin = backend.removePlugin (juce::var (removeLastPluginArgs));
    REQUIRE ((bool) removedLastPlugin.getProperty ("ok", false));
    REQUIRE (backend.sessionGraph().getProperty ("tracks", {})[0].getProperty ("plugins", {}).size() == 0);

    auto saved = backend.saveSessionGraph (juce::var());
    REQUIRE ((bool) saved.getProperty ("ok", false));

    auto restored = backend.restoreSessionGraph (juce::var());
    REQUIRE ((bool) restored.getProperty ("ok", false));
    REQUIRE (outputDir.getChildFile ("restored-session-graph.json").existsAsFile());

    const auto commandLog = outputDir.getChildFile ("command-log.jsonl").loadFileAsString();
    REQUIRE (commandLog.contains ("createSession"));
    REQUIRE (commandLog.contains ("selectAudioDevice"));
    REQUIRE (commandLog.contains ("createTrack"));
    REQUIRE (commandLog.contains ("getPluginBlocklist"));
    REQUIRE (commandLog.contains ("blockPlugin"));
    REQUIRE (commandLog.contains ("scanPlugins"));
    REQUIRE (commandLog.contains ("clearPluginBlocklist"));
    REQUIRE (commandLog.contains ("renameTrack"));
    REQUIRE (commandLog.contains ("removeTrack"));
    REQUIRE (commandLog.contains ("openSession"));
    REQUIRE (commandLog.contains ("setPluginParam"));
    REQUIRE (commandLog.contains ("bypassPlugin"));
    REQUIRE (commandLog.contains ("reorderPlugin"));
    REQUIRE (commandLog.contains ("removePlugin"));
    REQUIRE (commandLog.contains ("addAutomationPoint"));
    REQUIRE (commandLog.contains ("setAutomationPoint"));
    REQUIRE (commandLog.contains ("removeAutomationPoint"));
    REQUIRE (commandLog.contains ("clearAutomation"));
    REQUIRE (commandLog.contains ("addClip"));
    REQUIRE (commandLog.contains ("getClipPeaks"));
    REQUIRE (commandLog.contains ("moveClip"));
    REQUIRE (commandLog.contains ("trimClip"));
    REQUIRE (commandLog.contains ("duplicateClip"));
    REQUIRE (commandLog.contains ("pasteClip"));
    REQUIRE (commandLog.contains ("deleteTimeRange"));
    REQUIRE (commandLog.contains ("renameClip"));
    REQUIRE (commandLog.contains ("removeClip"));
    REQUIRE (commandLog.contains ("setClipMute"));
    REQUIRE (commandLog.contains ("setClipGain"));
    REQUIRE (commandLog.contains ("setClipWarp"));
    REQUIRE (commandLog.contains ("addMidiClip"));
    REQUIRE (commandLog.contains ("addNote"));
    REQUIRE (commandLog.contains ("setNote"));
    REQUIRE (commandLog.contains ("quantizeNotes"));
    REQUIRE (commandLog.contains ("removeNote"));
    REQUIRE (commandLog.contains ("setTrackVolume"));
    REQUIRE (commandLog.contains ("setTrackPan"));
    REQUIRE (commandLog.contains ("setTrackMute"));
    REQUIRE (commandLog.contains ("setTrackSolo"));
    REQUIRE (commandLog.contains ("enableTrackMeter"));
    REQUIRE (commandLog.contains ("enableAllMeters"));
    REQUIRE (commandLog.contains ("disableTrackMeter"));
    REQUIRE (commandLog.contains ("createGroupTrack"));
    REQUIRE (commandLog.contains ("ungroupTrack"));
    REQUIRE (commandLog.contains ("setTrackInput"));
    REQUIRE (commandLog.contains ("setTrackOutput"));
    REQUIRE (commandLog.contains ("armTrack"));
    REQUIRE (commandLog.contains ("setInputMonitor"));
    REQUIRE (commandLog.contains ("stopRecording"));
    REQUIRE (commandLog.contains ("setTempo"));
    REQUIRE (commandLog.contains ("insertTempoChange"));
    REQUIRE (commandLog.contains ("setTempoCurve"));
    REQUIRE (commandLog.contains ("removeTempoChange"));
    REQUIRE (commandLog.contains ("setTimeSignature"));
    REQUIRE (commandLog.contains ("insertTimeSigChange"));
    REQUIRE (commandLog.contains ("removeTimeSigChange"));
    REQUIRE (commandLog.contains ("setMetronome"));
    REQUIRE (commandLog.contains ("setProjectSettings"));
    REQUIRE (commandLog.contains ("saveSessionGraph"));
    REQUIRE (commandLog.contains ("restoreSessionGraph"));

    outputDir.deleteRecursively();
}

TEST_CASE ("maolan process backend rejects non-default CoreAudio device structurally")
{
    auto outputDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                         .getNonexistentChildFile ("mosh-maolan-contract-unit", {});
    outputDir.createDirectory();

    EngineBackendContext context;
    context.sessionDir = outputDir.getChildFile ("session");
    context.repoRoot = juce::File::getCurrentWorkingDirectory();

    MaolanProcessBackend backend (context);

    auto* createArgs = new juce::DynamicObject();
    createArgs->setProperty ("outputDir", outputDir.getFullPathName());
    REQUIRE ((bool) backend.createSession (juce::var (createArgs)).getProperty ("ok", false));

    auto* deviceArgs = new juce::DynamicObject();
    deviceArgs->setProperty ("device", "Built-in Output");
    auto result = backend.selectAudioDevice (juce::var (deviceArgs));

    REQUIRE_FALSE ((bool) result.getProperty ("ok", true));
    REQUIRE (result.getProperty ("backend", {}).toString() == "maolan");
    REQUIRE (result.getProperty ("commandId", {}).toString() == "selectAudioDevice");

    auto* error = result.getProperty ("error", {}).getDynamicObject();
    REQUIRE (error != nullptr);
    REQUIRE (error->getProperty ("code").toString() == "unsupported_by_backend");

    outputDir.deleteRecursively();
}
