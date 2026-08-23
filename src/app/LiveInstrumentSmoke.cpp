#include "LiveInstrumentSmoke.h"

#include "../engine/MoshEngine.h"
#include "../moshops/MoshOps.h"

#include <atomic>
#include <iostream>

namespace mosh
{
namespace
{
using namespace juce;

class CallbackProbe final : public AudioIODeviceCallback
{
public:
    void audioDeviceAboutToStart (AudioIODevice*) override {}
    void audioDeviceStopped() override {}

    void audioDeviceIOCallbackWithContext (const float* const*, int,
                                           float* const* outputs, int numOutputChannels,
                                           int numSamples,
                                           const AudioIODeviceCallbackContext&) override
    {
        callbacks.fetch_add (1, std::memory_order_relaxed);
        outputFrames.fetch_add (numOutputChannels > 0 ? numSamples : 0,
                                std::memory_order_relaxed);
        // AudioDeviceManager mixes every callback after the first through a reused
        // temporary buffer. A passive callback must explicitly contribute silence;
        // leaving it untouched re-adds stale samples and creates false WAV evidence.
        for (int channel = 0; channel < numOutputChannels; ++channel)
            if (outputs[channel] != nullptr)
                FloatVectorOperations::clear (outputs[channel], numSamples);
    }

    int callbackCount() const { return callbacks.load (std::memory_order_relaxed); }
    int frameCount() const { return outputFrames.load (std::memory_order_relaxed); }

private:
    std::atomic<int> callbacks { 0 };
    std::atomic<int> outputFrames { 0 };
};

var object (std::initializer_list<std::pair<const char*, var>> fields)
{
    auto* value = new DynamicObject();
    for (const auto& [name, field] : fields)
        value->setProperty (name, field);
    return var (value);
}

var execute (MoshOps& ops, const String& name, const var& args = {})
{
    auto* command = new DynamicObject();
    command->setProperty ("command", name);
    if (! args.isVoid())
        command->setProperty ("args", args);
    return ops.execute (var (command));
}

bool succeeded (const var& result)
{
    return (bool) result.getProperty ("ok", false);
}

String findInstrumentId (MoshOps& ops, const String& target)
{
    const auto result = execute (ops, "list_plugins");
    const auto plugins = result.getProperty ("data", var()).getProperty ("plugins", var());
    String fallback;
    if (auto* items = plugins.getArray())
        for (const auto& plugin : *items)
        {
            if (! (bool) plugin.getProperty ("isInstrument", false)
                || ! plugin.getProperty ("name", var()).toString().equalsIgnoreCase (target))
                continue;

            const auto id = plugin.getProperty ("id", var()).toString();
            if (plugin.getProperty ("format", var()).toString() == "VST3")
                return id;
            if (fallback.isEmpty())
                fallback = id;
        }
    return fallback;
}

String activeInstrumentName (MoshOps& ops, const String& trackId)
{
    const auto tracks = ops.snapshot().getProperty ("tracks", var());
    if (auto* trackItems = tracks.getArray())
        for (const auto& track : *trackItems)
            if (track.getProperty ("id", var()).toString() == trackId)
                if (auto* plugins = track.getProperty ("plugins", var()).getArray())
                    for (const auto& plugin : *plugins)
                        if ((bool) plugin.getProperty ("isInstrument", false))
                            return plugin.getProperty ("name", var()).toString();
    return {};
}

tracktion::engine::Plugin* activeInstrument (MoshEngine& engine, const String& trackId)
{
    for (auto* track : tracktion::engine::getAudioTracks (engine.edit()))
        if (track != nullptr && track->itemID.toString() == trackId)
            for (auto plugin : track->pluginList.getPlugins())
            {
                if (auto* external = dynamic_cast<tracktion::engine::ExternalPlugin*> (plugin))
                {
                    if (external->isSynth()) return external;
                }
                else if (plugin != nullptr && plugin->getPluginType() == "4osc")
                    return plugin;
            }
    return nullptr;
}

void raiseMax (std::atomic<double>& destination, double value)
{
    auto current = destination.load (std::memory_order_relaxed);
    while (value > current
           && ! destination.compare_exchange_weak (current, value,
                                                   std::memory_order_relaxed)) {}
}
}

int runLiveInstrumentSmoke (MoshEngine& engine, MoshOps& ops)
{
    using namespace juce;

    const auto target = SystemStats::getEnvironmentVariable (
        "MOSH_LIVE_INSTRUMENT", "4OSC").trim();
    const bool waveControl = target.equalsIgnoreCase ("WAVE");
    const auto scenario = SystemStats::getEnvironmentVariable (
        "MOSH_LIVE_INSTRUMENT_CASE", "hot-swap").trim();
    const bool probeEnabled = SystemStats::getEnvironmentVariable (
        "MOSH_LIVE_INSTRUMENT_CALLBACK_PROBE", "1") != "0";
    const int durationMs = jlimit (750, 10000,
        SystemStats::getEnvironmentVariable (
            "MOSH_LIVE_INSTRUMENT_MS", "3000").getIntValue());

    const auto createTrack = execute (ops, "create_track", object ({ { "name", "Live Instrument Smoke" } }));
    const auto trackId = createTrack.getProperty ("data", var()).getProperty ("trackId", var()).toString();

    Array<var> notes;
    // Use a deterministic pulse train rather than one note-on at time zero. Some
    // third-party instruments legitimately finish their first prepare cycle on the
    // opening block; later pulses prove sustained live MIDI delivery instead of
    // conflating one boundary event with a silent graph.
    for (double beat : { 0.0, 2.0, 4.0, 6.0, 8.0 })
        notes.add (object ({ { "pitch", 60 }, { "start", beat },
                             { "length", 1.0 }, { "velocity", 110 } }));
    const auto addClip = waveControl
        ? execute (ops, "add_test_tone_clip",
                   object ({ { "trackId", trackId }, { "seconds", 5.0 }, { "freq", 330.0 } }))
        : execute (ops, "add_midi_clip",
                   object ({ { "trackId", trackId }, { "length", 6.0 }, { "notes", notes } }));

    var loadResult = object ({ { "ok", true } });
    if (! waveControl && ! target.equalsIgnoreCase ("4OSC"))
    {
        const auto pluginId = findInstrumentId (ops, target);
        if (pluginId.isEmpty())
            loadResult = object ({ { "ok", false }, { "error", "installed instrument not found: " + target } });
        else
            loadResult = execute (ops, "load_plugin",
                                  object ({ { "trackId", trackId }, { "pluginId", pluginId },
                                            { "replaceInstrument", true } }));
    }

    var scenarioResult = object ({ { "ok", true } });
    if (succeeded (loadResult) && scenario == "save-reload")
    {
        const auto save = execute (ops, "save");
        scenarioResult = succeeded (save) ? execute (ops, "reload") : save;
    }
    else if (succeeded (loadResult) && scenario == "undo-redo"
             && ! target.equalsIgnoreCase ("4OSC"))
    {
        const auto undo = execute (ops, "undo");
        scenarioResult = succeeded (undo) ? execute (ops, "redo") : undo;
    }

    std::atomic<double> maxTrackDb { -1000.0 };
    std::atomic<double> maxMasterDb { -1000.0 };
    std::atomic<int> levelEvents { 0 };
    ops.setEventSink ([&] (const var& event)
    {
        if (event.getProperty ("type", var()).toString() != "levels")
            return;
        levelEvents.fetch_add (1, std::memory_order_relaxed);
        const auto payload = event.getProperty ("payload", var());
        if (auto* tracks = payload.getProperty ("tracks", var()).getArray())
            for (const auto& track : *tracks)
                raiseMax (maxTrackDb, jmax ((double) track.getProperty ("l", -1000.0),
                                            (double) track.getProperty ("r", -1000.0)));
        const auto master = payload.getProperty ("master", var());
        raiseMax (maxMasterDb, jmax ((double) master.getProperty ("l", -1000.0),
                                     (double) master.getProperty ("r", -1000.0)));
    });

    const auto meterResult = execute (ops, "enable_track_meter", object ({ { "trackId", trackId } }));
    const auto seekResult = execute (ops, "set_transport", object ({ { "position", 0.0 } }));

    auto& deviceManager = engine.engine().getDeviceManager().deviceManager;
    CallbackProbe probe;
    if (probeEnabled) deviceManager.addAudioCallback (&probe);
    const auto playResult = execute (ops, "set_transport", object ({ { "action", "play" } }));
    const bool playingAfterStart = engine.edit().getTransport().isPlaying();

    const auto deadline = Time::getMillisecondCounter() + (uint32) durationMs;
    auto* messageManager = MessageManager::getInstanceWithoutCreating();
    auto lastCpu = engine.engine().getDeviceManager().getCpuUsage();
    int cpuChanges = 0;
    bool contextEverPlayed = false;
    while (Time::getMillisecondCounter() < deadline)
    {
        if (messageManager != nullptr) messageManager->runDispatchLoopUntil (25);
        else Thread::sleep (25);
        const auto cpu = engine.engine().getDeviceManager().getCpuUsage();
        if (std::abs (cpu - lastCpu) > 0.000001f) { ++cpuChanges; lastCpu = cpu; }
        if (auto* context = engine.edit().getCurrentPlaybackContext())
            contextEverPlayed = contextEverPlayed || context->isPlaying();
    }

    auto* playbackContext = engine.edit().getCurrentPlaybackContext();
    auto* defaultWaveOut = engine.engine().getDeviceManager().getDefaultWaveOutDevice();
    const bool playbackContextPresent = playbackContext != nullptr;
    const bool playbackGraphAllocated = playbackContext != nullptr
                                     && playbackContext->isPlaybackGraphAllocated();
    const bool contextPlaying = playbackContext != nullptr && playbackContext->isPlaying();
    const double contextPosition = playbackContext != nullptr
                                 ? playbackContext->getPosition().inSeconds() : -1.0;
    const auto positionBeforeStop = engine.edit().getTransport().getPosition().inSeconds();
    const auto stopResult = execute (ops, "set_transport", object ({ { "action", "stop" } }));
    if (probeEnabled) deviceManager.removeAudioCallback (&probe);
    ops.setEventSink ({});

    const auto instrumentName = waveControl ? String ("WAVE")
                                            : activeInstrumentName (ops, trackId);
    auto* instrument = waveControl ? nullptr : activeInstrument (engine, trackId);
    const bool identityMatches = instrumentName.equalsIgnoreCase (target);
    const auto evidenceSave = execute (ops, "save");
    const bool passed = engine.audioReady()
        && succeeded (createTrack) && succeeded (addClip) && succeeded (loadResult)
        && succeeded (scenarioResult) && succeeded (meterResult) && succeeded (seekResult)
        && succeeded (playResult) && succeeded (stopResult) && playingAfterStart
        && identityMatches && (! probeEnabled
            || (probe.callbackCount() > 0 && probe.frameCount() > 0))
        && levelEvents.load() > 0 && contextEverPlayed
        && positionBeforeStop > 0.1 && maxMasterDb.load() > -80.0;

    auto* evidence = new DynamicObject();
    evidence->setProperty ("mode", "live_instrument_smoke");
    evidence->setProperty ("pass", passed);
    evidence->setProperty ("target", target);
    evidence->setProperty ("scenario", scenario);
    evidence->setProperty ("callbackProbeEnabled", probeEnabled);
    evidence->setProperty ("instrument", instrumentName);
    evidence->setProperty ("pluginProcessing",
                           instrument != nullptr && instrument->isProcessingEnabled());
    if (auto* external = dynamic_cast<tracktion::engine::ExternalPlugin*> (instrument))
    {
        evidence->setProperty ("pluginFormat", external->desc.pluginFormatName);
        evidence->setProperty ("pluginLoadError", external->getLoadError());
        evidence->setProperty ("pluginInitialisingAsync", external->isInitialisingAsync());
        if (auto* instance = external->getAudioPluginInstance())
        {
            evidence->setProperty ("pluginInstanceReady", true);
            evidence->setProperty ("pluginSampleRate", instance->getSampleRate());
            evidence->setProperty ("pluginBlockSize", instance->getBlockSize());
            evidence->setProperty ("pluginInputs", instance->getTotalNumInputChannels());
            evidence->setProperty ("pluginOutputs", instance->getTotalNumOutputChannels());
            evidence->setProperty ("pluginSuspended", instance->isSuspended());
        }
        else
            evidence->setProperty ("pluginInstanceReady", false);
    }
    evidence->setProperty ("identityMatches", identityMatches);
    evidence->setProperty ("audioReady", engine.audioReady());
    evidence->setProperty ("tracktionSampleRate", engine.engine().getDeviceManager().getSampleRate());
    evidence->setProperty ("tracktionBlockSize", engine.engine().getDeviceManager().getBlockSize());
    evidence->setProperty ("tracktionCpu", engine.engine().getDeviceManager().getCpuUsage());
    evidence->setProperty ("tracktionCpuChanges", cpuChanges);
    evidence->setProperty ("audioDeviceError", engine.audioReadinessError());
    evidence->setProperty ("playingAfterStart", playingAfterStart);
    evidence->setProperty ("playbackContextPresent", playbackContextPresent);
    evidence->setProperty ("defaultWaveOutput",
                           defaultWaveOut != nullptr ? defaultWaveOut->getName() : String());
    evidence->setProperty ("contextHasDefaultOutput",
                           playbackContext != nullptr && defaultWaveOut != nullptr
                               && playbackContext->getOutputFor (defaultWaveOut) != nullptr);
    evidence->setProperty ("playbackGraphAllocated", playbackGraphAllocated);
    evidence->setProperty ("contextPlaying", contextPlaying);
    evidence->setProperty ("contextEverPlayed", contextEverPlayed);
    evidence->setProperty ("contextPosition", contextPosition);
    evidence->setProperty ("positionBeforeStop", positionBeforeStop);
    evidence->setProperty ("transportPositionAfterRun",
                           engine.edit().getTransport().getPosition().inSeconds());
    evidence->setProperty ("callbackCount", probe.callbackCount());
    evidence->setProperty ("outputFrameCount", probe.frameCount());
    evidence->setProperty ("levelEvents", levelEvents.load());
    evidence->setProperty ("maxTrackDb", maxTrackDb.load());
    evidence->setProperty ("maxMasterDb", maxMasterDb.load());
    evidence->setProperty ("loadError", loadResult.getProperty ("error", var()));
    evidence->setProperty ("scenarioError", scenarioResult.getProperty ("error", var()));
    evidence->setProperty ("playError", playResult.getProperty ("error", var()));
    evidence->setProperty ("evidenceSaved", succeeded (evidenceSave));
    evidence->setProperty ("evidenceEdit", engine.editFile().getFullPathName());
    std::cout << JSON::toString (var (evidence), false).toStdString() << std::endl;
    return passed ? 0 : 1;
}
}
