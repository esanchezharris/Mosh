#include "MoshOps.h"
#include "state/Ids.h"
#include "state/RenderLayer.h"
#include "plugins/neural/NeuralInsertPlugin.h"
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
    NeuralInsertPlugin* asNeural (te::Plugin* p) { return dynamic_cast<NeuralInsertPlugin*> (p); }

    // Tracktion's compiled-in built-in plugin palette (registered unconditionally
    // by PluginManager). These ship inside the engine — no scan, no third-party
    // dependency — so the FX palette and built-in instruments are pure surface
    // work over the existing plugin command path. xmlTypeName strings are the
    // stable serialization ids createNewPlugin(type, {}) dispatches on.
    struct BuiltinSpec { const char* type; const char* name; const char* category; bool isInstrument; };
    static const BuiltinSpec kBuiltins[] = {
        { "4osc",         "4OSC Synth",            "Instrument", true  },
        { "sampler",      "Sampler",               "Instrument", true  },
        { "4bandEq",      "4-Band EQ",             "EQ",         false },
        { "compressor",   "Compressor",            "Dynamics",   false },
        { "reverb",       "Reverb",                "Reverb",     false },
        { "delay",        "Delay",                 "Delay",      false },
        { "chorus",       "Chorus",                "Modulation", false },
        { "phaser",       "Phaser",                "Modulation", false },
        { "lowpass",      "Low / High-Pass Filter","Filter",     false },
        { "pitchShifter", "Pitch Shifter",         "Pitch",      false },
    };

    const BuiltinSpec* findBuiltin (const juce::String& type)
    {
        for (auto& b : kBuiltins)
            if (type == b.type)
                return &b;
        return nullptr;
    }

    bool isSerumPlugin (te::ExternalPlugin& plugin)
    {
        const auto name = plugin.getName();
        const auto vendor = plugin.getVendor();
        const auto file = plugin.desc.fileOrIdentifier;
        return vendor == "Xfer Records"
               && (name == "Serum 2"
                   || name == "Serum 2 FX"
                   || file.containsIgnoreCase ("Serum2.vst3"));
    }

    void addExternalPluginMetadata (DynamicObject& o, te::ExternalPlugin& plugin)
    {
        o.setProperty ("manufacturer", plugin.getVendor());
        o.setProperty ("file", plugin.desc.fileOrIdentifier);
        o.setProperty ("identifier", te::createIdentifierString (plugin.desc));
        o.setProperty ("numInputs", plugin.getNumInputs());
        o.setProperty ("numOutputs", plugin.getNumOutputs());
        o.setProperty ("pluginInstanceLoaded", plugin.getAudioPluginInstance() != nullptr);
        o.setProperty ("isNonRealtime", plugin.getAudioPluginInstance() != nullptr
                                            && plugin.getAudioPluginInstance()->isNonRealtime());
    }

    String findSerumRealtimeRenderReason (te::Edit& edit)
    {
        for (auto* track : te::getAudioTracks (edit))
            for (auto* plugin : track->pluginList.getPlugins())
                if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin))
                    if (ext->isEnabled() && isSerumPlugin (*ext))
                        return "Serum compatibility: " + ext->getName();

        return {};
    }
}

MoshOps::MoshOps (MoshEngine& engineToUse)
    : eng (engineToUse), pluginHost (engineToUse.engine())
{
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    pluginHost.initialise();                 // formats + curated VST3 scan
    startTimerHz (30);                       // telemetry decimated to 30 Hz, never per-block
}

MoshOps::~MoshOps() { stopTimer(); unregisterAllMeterClients(); }

// ── Metering helpers (Wave 9) ────────────────────────────────────────────────
te::LevelMeterPlugin* MoshOps::findTrackMeter (te::AudioTrack& t)
{
    for (auto* p : t.pluginList.getPlugins())
        if (auto* m = dynamic_cast<te::LevelMeterPlugin*> (p))
            return m;
    return nullptr;
}

te::LevelMeterPlugin* MoshOps::ensureTrackMeter (te::AudioTrack& t)
{
    if (auto* lm = findTrackMeter (t)) return lm;
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    auto* lm = dynamic_cast<te::LevelMeterPlugin*> (plugin.get());
    t.pluginList.insertPlugin (plugin, t.pluginList.getPlugins().size(), nullptr);   // append → post-fader
    return lm;                                                // client is wired by reconcileMeterClients()
}

// Sync the client map to the LIVE meter taps in the edit. Robust against undo/
// redo/remove destroying a meter plugin: we only ever read our OWN Client (alive),
// never a stale measurer. A tap whose track no longer has a meter is dropped
// WITHOUT removeClient (its measurer is already gone); a fresh meter gets a client
// added to its (live) measurer. Called every frame before reading levels.
void MoshOps::reconcileMeterClients()
{
    std::map<juce::String, te::LevelMeterPlugin*> live;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* lm = findTrackMeter (*t))
                live[t->itemID.toString()] = lm;

    for (auto it = meterClients.begin(); it != meterClients.end();)
    {
        if (live.find (it->first) == live.end())
            it = meterClients.erase (it);                    // plugin gone (undo/remove) — drop, no removeClient
        else
            ++it;
    }
    for (auto& [id, lm] : live)
    {
        auto& slot = meterClients[id];
        if (slot == nullptr) slot = std::make_unique<MeterTap>();
        if (slot->plugin != lm)                              // new / replaced instance — (re)register our client
        {
            slot->plugin = lm;
            lm->measurer.addClient (slot->client);
        }
    }
}

void MoshOps::unregisterAllMeterClients()
{
    // Detach our clients, but ONLY from measurers that are still live — a track
    // removed since the last reconcile leaves a stale plugin pointer we must not
    // deref. Build the live set and match by value.
    juce::Array<te::LevelMeterPlugin*> live;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* lm = findTrackMeter (*t))
                live.add (lm);
    for (auto& [id, tap] : meterClients)
        if (tap != nullptr && tap->plugin != nullptr && live.contains (tap->plugin))
            tap->plugin->measurer.removeClient (tap->client);
    meterClients.clear();
}

void MoshOps::timerCallback()
{
    // Push a decimated transport delta while playing (and once on the
    // play-to-stop edge) so the UI playhead animates without polling (02 §4.2).
    auto& transport = eng.edit().getTransport();
    const bool playing = transport.isPlaying();
    if (playing || wasPlaying)
        emit ("transport", transportToVar());
    wasPlaying = playing;

    // Decimated level meters (Wave 9). Reconcile first (undo/redo-safe), then each
    // client reports the peak since the last read (getAndClear resets to -100);
    // master comes from the playback context's measurer (null headless → -100).
    reconcileMeterClients();
    if (! meterClients.empty())
    {
        Array<var> trackLevels;
        for (auto& [trackId, tap] : meterClients)
        {
            if (tap == nullptr) continue;
            const float l = tap->client.getAndClearAudioLevel (0).dB;
            const int chans = tap->client.getNumChannelsUsed();
            const float r = chans >= 2 ? tap->client.getAndClearAudioLevel (1).dB : l;
            auto* o = new DynamicObject();
            o->setProperty ("id", trackId);
            o->setProperty ("l", l);
            o->setProperty ("r", r);
            trackLevels.add (var (o));
        }

        float ml = -100.0f, mr = -100.0f;
        if (auto* ctx = transport.getCurrentPlaybackContext())
        {
            if (ctx != lastSeenContext) { ctx->masterLevels.addClient (masterClient); lastSeenContext = ctx; }
            ml = masterClient.getAndClearAudioLevel (0).dB;
            mr = masterClient.getAndClearAudioLevel (1).dB;
        }
        else
            lastSeenContext = nullptr;

        auto* master = new DynamicObject(); master->setProperty ("l", ml); master->setProperty ("r", mr);
        auto* payload = new DynamicObject();
        payload->setProperty ("tracks", trackLevels);
        payload->setProperty ("master", var (master));
        emit ("levels", var (payload));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::execute (const juce::var& command)
{
    const auto name = command.getProperty ("command", var()).toString();
    const auto args = command.getProperty ("args", var (new DynamicObject()));

    if (name.isEmpty())
        return errResult (name, "missing 'command'");

    if (name == "create_track")      return cmdCreateTrack (args);
    if (name == "rename_track")      return cmdRenameTrack (args);
    if (name == "remove_track")      return cmdRemoveTrack (args);
    if (name == "import_clip")       return cmdImportClip (args);
    if (name == "import_clip_data")  return cmdImportClipData (args);
    if (name == "add_test_tone_clip")return cmdAddTestTone (args);
    if (name == "set_transport")     return cmdSetTransport (args);
    if (name == "set_tempo")         return cmdSetTempo (args);
    if (name == "set_time_signature")return cmdSetTimeSignature (args);
    if (name == "set_metronome")     return cmdSetMetronome (args);
    if (name == "undo")              return cmdUndo (args);
    if (name == "redo")              return cmdRedo (args);
    if (name == "save")              return cmdSave (args);
    if (name == "reload")            return cmdReload (args);
    if (name == "add_render_layer")  return cmdAddRenderLayer (args);
    if (name == "move_clip")         return cmdMoveClip (args);
    if (name == "trim_clip")         return cmdTrimClip (args);
    if (name == "split_clip")        return cmdSplitClip (args);
    if (name == "remove_clip")       return cmdRemoveClip (args);
    if (name == "rename_clip")       return cmdRenameClip (args);
    if (name == "set_clip_mute")     return cmdSetClipMute (args);
    if (name == "set_clip_gain")     return cmdSetClipGain (args);
    if (name == "duplicate_clip")    return cmdDuplicateClip (args);
    if (name == "paste_clip")        return cmdPasteClip (args);
    if (name == "set_track_volume")  return cmdSetTrackVolume (args);
    if (name == "set_track_pan")     return cmdSetTrackPan (args);
    if (name == "set_track_mute")    return cmdSetTrackMute (args);
    if (name == "set_track_solo")    return cmdSetTrackSolo (args);
    if (name == "arm_track")         return cmdArmTrack (args);
    if (name == "set_input_monitor") return cmdSetInputMonitor (args);
    if (name == "set_master_volume") return cmdSetMasterVolume (args);
    if (name == "set_master_pan")    return cmdSetMasterPan (args);
    if (name == "enable_track_meter")  return cmdEnableTrackMeter (args);
    if (name == "disable_track_meter") return cmdDisableTrackMeter (args);
    if (name == "enable_all_meters")   return cmdEnableAllMeters (args);
    if (name == "create_bus")        return cmdCreateBus (args);
    if (name == "add_send")          return cmdAddSend (args);
    if (name == "set_send_level")    return cmdSetSendLevel (args);
    if (name == "remove_send")       return cmdRemoveSend (args);
    if (name == "remove_bus")        return cmdRemoveBus (args);
    if (name == "rename_bus")        return cmdRenameBus (args);
    if (name == "get_clip_peaks")    return cmdGetClipPeaks (args);
    if (name == "list_plugins")      return cmdListPlugins (args);
    if (name == "list_builtins")     return cmdListBuiltins (args);
    if (name == "load_plugin")       return cmdLoadPlugin (args);
    if (name == "load_builtin")      return cmdLoadBuiltin (args);
    if (name == "remove_plugin")     return cmdRemovePlugin (args);
    if (name == "reorder_plugin")    return cmdReorderPlugin (args);
    if (name == "set_plugin_param")  return cmdSetPluginParam (args);
    if (name == "bypass_plugin")     return cmdBypassPlugin (args);
    if (name == "rescan_plugins")        return cmdRescanPlugins (args);
    if (name == "get_plugin_blocklist")  return cmdGetPluginBlocklist (args);
    if (name == "clear_plugin_blocklist")return cmdClearPluginBlocklist (args);
    if (name == "block_plugin")          return cmdBlockPlugin (args);
    if (name == "add_automation_point")    return cmdAddAutomationPoint (args);
    if (name == "remove_automation_point") return cmdRemoveAutomationPoint (args);
    if (name == "set_automation_point")    return cmdSetAutomationPoint (args);
    if (name == "clear_automation")        return cmdClearAutomation (args);
    if (name == "open_plugin_editor")return cmdOpenPluginEditor (args);
    if (name == "add_midi_clip")     return cmdAddMidiClip (args);
    if (name == "add_note")          return cmdAddNote (args);
    if (name == "remove_note")       return cmdRemoveNote (args);
    if (name == "set_note")          return cmdSetNote (args);
    if (name == "quantize_notes")    return cmdQuantizeNotes (args);
    if (name == "add_neural_insert") return cmdAddNeuralInsert (args);
    if (name == "set_neural_param")  return cmdSetNeuralParam (args);
    if (name == "set_neural_lab_mode") return cmdSetNeuralLabMode (args);
    if (name == "set_neural_latency")return cmdSetNeuralLatency (args);
    if (name == "reset_neural")      return cmdResetNeural (args);
    if (name == "create_render_layer") return cmdCreateRenderLayer (args);
    if (name == "set_render_param")  return cmdSetRenderParam (args);
    if (name == "render_layer")      return cmdRenderLayer (args);
    if (name == "cancel_render")     return cmdCancelRender (args);
    if (name == "accept_render")     return cmdAcceptRender (args);
    if (name == "reject_render")     return cmdRejectRender (args);
    if (name == "bypass_layer")      return cmdBypassLayer (args);
    if (name == "freeze_layer")      return cmdFreezeLayer (args);
    if (name == "bounce_layer_to_clip") return cmdBounceLayerToClip (args);
    if (name == "remove_render_layer") return cmdRemoveRenderLayer (args);
    if (name == "list_colors")       return cmdListColors (args);
    if (name == "export_audio")      return cmdExportAudio (args);
    if (name == "list_audio_devices")return cmdListAudioDevices (args);
    if (name == "list_midi_inputs")  return cmdListMidiInputs (args);
    if (name == "get_command_log")   return cmdGetCommandLog (args);
    if (name == "set_audio_device")  return cmdSetAudioDevice (args);
    if (name == "set_buffer_size")   return cmdSetBufferSize (args);
    if (name == "set_audio_threads") return cmdSetAudioThreads (args);
    if (name == "list_directory")    return cmdListDirectory (args);
    if (name == "new_project")       return cmdNewProject (args);
    if (name == "open_project")      return cmdOpenProject (args);
    if (name == "save_as")           return cmdSaveAs (args);
    if (name == "set_project_settings") return cmdSetProjectSettings (args);

    return errResult (name, "unknown command: " + name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdCreateTrack (const juce::var& args)
{
    undoManager().beginNewTransaction ("create_track");
    auto* track = createAudioTrack (args.getProperty ("name", var()).toString());
    if (track == nullptr)
    {
        logLine ("create_track", args, false, "insert failed", true);
        return errResult ("create_track", "insert failed");
    }

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("create_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_track", var (data));
}

juce::var MoshOps::cmdRenameTrack (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (id);
    if (track == nullptr) return errResult ("rename_track", "no track: " + id);

    undoManager().beginNewTransaction ("rename_track");
    track->setName (args.getProperty ("name", var()).toString());
    logLine ("rename_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_track");
}

juce::var MoshOps::cmdRemoveTrack (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (id);
    if (track == nullptr) return errResult ("remove_track", "no track: " + id);

    undoManager().beginNewTransaction ("remove_track");
    eng.edit().deleteTrack (track);
    logLine ("remove_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_track");
}

// Shared wave-file insertion path used by both import_clip (path-based) and
// import_clip_data (bytes-over-bridge). The caller guarantees `file` is a real,
// already-validated audio file on disk. Opens one undo transaction, finds-or-
// creates the target track, inserts the wave clip at `startSeconds`, drains the
// post-insert AsyncUpdater headless (so itemIDs settle, no itemID assert), logs
// the command as undoable and emits a snapshot invalidation.
juce::var MoshOps::importWaveFileToTrack (const juce::String& command,
                                          const juce::File& file,
                                          const juce::String& clipName,
                                          const juce::String& trackId,
                                          double startSeconds,
                                          const juce::var& logArgs)
{
    auto& edit = eng.edit();
    auto* track = trackId.isNotEmpty() ? findTrack (trackId) : nullptr;
    if (track == nullptr)
    {
        auto tracks = te::getAudioTracks (edit);
        track = tracks.isEmpty() ? nullptr : tracks.getFirst();
    }

    undoManager().beginNewTransaction (command);
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult (command, "no track");

    te::AudioFile audioFile (edit.engine, file);
    if (! audioFile.isValid()) return errResult (command, "invalid audio file");

    const double len = audioFile.getLength();
    auto name = clipName;
    if (name.isEmpty()) name = file.getFileNameWithoutExtension();

    auto clip = track->insertWaveClip (name, file,
        { { tracktion::TimePosition::fromSeconds (startSeconds), tracktion::TimeDuration::fromSeconds (len) }, {} }, false);
    if (clip == nullptr)
    {
        logLine (command, logArgs, false, "insert failed", true);
        return errResult (command, "insertWaveClip failed");
    }

    // Tracktion queues a track/clip AsyncUpdater after a headless insert; drain
    // it before returning so itemIDs settle (mirrors createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("file", file.getFullPathName());
    logLine (command, logArgs, true, {}, true);
    emitSnapshotInvalidated();
    return okResult (command, var (data));
}

juce::var MoshOps::cmdImportClip (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("import_clip", "missing 'file'");

    File file (path);
    if (! file.existsAsFile()) return errResult ("import_clip", "file not found: " + path);

    return importWaveFileToTrack ("import_clip", file,
                                  args.getProperty ("name", var()).toString(),
                                  args.getProperty ("trackId", var()).toString(),
                                  (double) args.getProperty ("startSeconds", 0.0),
                                  args);
}

juce::var MoshOps::cmdImportClipData (const juce::var& args)
{
    auto name = args.getProperty ("name", var()).toString();
    const auto dataBase64 = args.getProperty ("dataBase64", var()).toString();
    if (name.isEmpty())       return errResult ("import_clip_data", "missing 'name'");
    if (dataBase64.isEmpty()) return errResult ("import_clip_data", "missing 'dataBase64'");

    // Size guard: reject a pathological drop before decoding to avoid OOM.
    // ~280 MB of base64 decodes to ~200 MB of audio.
    if (dataBase64.length() > 280 * 1024 * 1024)
        return errResult ("import_clip_data", "file too large");

    // Decode base64 -> raw bytes. Guard against malformed input (no crash).
    juce::MemoryOutputStream mos;
    if (! juce::Base64::convertFromBase64 (mos, dataBase64))
        return errResult ("import_clip_data", "invalid base64 data");

    // Write the decoded bytes under sessionDir/imports/. Uniquify the destination so
    // two drops sharing a display name (both "loop.wav") don't overwrite each other's
    // on-disk source: an earlier imported clip still references the first file, so an
    // in-place overwrite would silently alias it (and persist across save/reload).
    auto importsDir = eng.sessionDir().getChildFile ("imports");
    importsDir.createDirectory();
    const juce::File named (importsDir.getChildFile (juce::File::createLegalFileName (name)));
    auto file = importsDir.getNonexistentChildFile (named.getFileNameWithoutExtension(),
                                                    named.getFileExtension(), false);
    if (! file.replaceWithData (mos.getData(), mos.getDataSize()))
        return errResult ("import_clip_data", "could not write the import file");

    // Validate it is real audio BEFORE inserting; never leave a garbage file or
    // insert a non-audio clip.
    te::AudioFile af (eng.engine(), file);
    if (! af.isValid())
    {
        file.deleteFile();
        return errResult ("import_clip_data", "not a supported audio file");
    }

    return importWaveFileToTrack ("import_clip_data", file, name,
                                  args.getProperty ("trackId", var()).toString(),
                                  (double) args.getProperty ("start", 0.0),
                                  args);
}

juce::var MoshOps::cmdAddTestTone (const juce::var& args)
{
    const double seconds = (double) args.getProperty ("seconds", 2.0);
    const double freq = (double) args.getProperty ("freq", 220.0);
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = "tone-" + String ((int) freq);

    auto file = eng.generateTestTone (seconds, freq, name);
    if (! file.existsAsFile()) return errResult ("add_test_tone_clip", "tone generation failed");

    auto* importArgs = new DynamicObject();
    importArgs->setProperty ("file", file.getFullPathName());
    importArgs->setProperty ("trackId", args.getProperty ("trackId", var()));
    importArgs->setProperty ("name", name);
    return cmdImportClip (var (importArgs));   // logs as import_clip
}

juce::var MoshOps::cmdSetTransport (const juce::var& args)
{
    auto& transport = eng.edit().getTransport();
    const auto action = args.getProperty ("action", var()).toString();

    // Play/record touch the audio device; skip them in no-audio (headless) mode.
    if ((action == "play" || (action == "toggle" && ! transport.isPlaying())) && eng.hasAudio())
    {
        eng.ensurePlaybackContext();
        transport.play (false);
    }
    else if (action == "stop" || (action == "toggle" && transport.isPlaying()))
    {
        transport.stop (false, false);
    }
    else if (action == "record" && eng.hasAudio())
    {
        eng.ensurePlaybackContext();
        transport.record (false);
    }

    if (action == "to_end")
        transport.setPosition (tracktion::TimePosition::fromSeconds (eng.edit().getLength().inSeconds()));
    else if (action == "to_start")
        transport.setPosition (tracktion::TimePosition());

    if (args.hasProperty ("position"))
        transport.setPosition (tracktion::TimePosition::fromSeconds ((double) args.getProperty ("position", 0.0)));

    if (args.hasProperty ("loop"))
        transport.looping = (bool) args.getProperty ("loop", false);

    if (args.hasProperty ("loopStart") && args.hasProperty ("loopEnd"))
        transport.setLoopRange ({ tracktion::TimePosition::fromSeconds ((double) args.getProperty ("loopStart", 0.0)),
                                  tracktion::TimePosition::fromSeconds ((double) args.getProperty ("loopEnd", 0.0)) });

    logLine ("set_transport", args, true, {}, false);          // transport is NOT undoable
    emit ("transport", transportToVar());
    return okResult ("set_transport", transportToVar());
}

juce::var MoshOps::cmdSetTempo (const juce::var& args)
{
    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    if (tempo == nullptr) return errResult ("set_tempo", "no tempo setting");

    const double bpm = juce::jlimit (20.0, 999.0, (double) args.getProperty ("bpm", 120.0));
    undoManager().beginNewTransaction ("set_tempo");
    tempo->setBpm (bpm);
    logLine ("set_tempo", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("bpm", tempo->getBpm());
    return okResult ("set_tempo", var (data));
}

juce::var MoshOps::cmdSetTimeSignature (const juce::var& args)
{
    auto& edit = eng.edit();
    auto* ts = edit.tempoSequence.getTimeSig (0);
    if (ts == nullptr) return errResult ("set_time_signature", "no time signature");

    const int num = juce::jlimit (1, 32, (int) args.getProperty ("numerator", 4));
    const int den = (int) args.getProperty ("denominator", 4);
    static const int validDen[] = { 1, 2, 4, 8, 16, 32 };
    bool denOk = false;
    for (int d : validDen) if (d == den) denOk = true;
    if (! denOk) return errResult ("set_time_signature", "denominator must be a power of two (1..32)");

    undoManager().beginNewTransaction ("set_time_signature");
    ts->setStringTimeSig (juce::String (num) + "/" + juce::String (den));
    logLine ("set_time_signature", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("numerator", ts->numerator.get());
    data->setProperty ("denominator", ts->denominator.get());
    return okResult ("set_time_signature", var (data));
}

juce::var MoshOps::cmdSetMetronome (const juce::var& args)
{
    // The click track is a transport/monitoring preference (like loop), not a
    // session edit — not undoable.
    const bool on = (bool) args.getProperty ("enabled", false);
    eng.edit().clickTrackEnabled = on;
    logLine ("set_metronome", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("metronome", on);
    return okResult ("set_metronome", var (data));
}

// PRJ-008 — the MOSH_PROJECT child of the Edit's own ValueTree (mirrors the
// MOSH_RENDERLAYER parenting). Created empty on first access so it saves/reloads
// with the .tracktionedit. Pure storage accessor: no undo manager, no logging.
juce::ValueTree MoshOps::projectSettingsTree()
{
    auto state = eng.edit().state;
    auto node = state.getChildWithName (ids::MOSH_PROJECT);
    if (! node.isValid())
    {
        node = juce::ValueTree (ids::MOSH_PROJECT);
        state.appendChild (node, nullptr);   // nullptr: not an undoable edit (preference)
    }
    return node;
}

juce::var MoshOps::projectSettingsToVar()
{
    // Project INTENT where stored; live device readout as the fallback (device values
    // stay the live truth, project = intent). timeBase has no device analogue, so it
    // defaults to "seconds". NON-mutating read (snapshot() is read-only by contract):
    // getChildWithName returns an invalid tree when unset, whose hasProperty() is false,
    // so the device-fallback below handles the absent case without writing the Edit tree.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    auto& dm = eng.engine().getDeviceManager();

    double sr = dm.getSampleRate();
    if (sr < 7000.0) sr = 44100.0;
    if (node.hasProperty (ids::projectSampleRate))
        sr = (double) node.getProperty (ids::projectSampleRate);

    int bd = dm.getBitDepth();
    if (bd != 16 && bd != 24 && bd != 32) bd = 24;
    if (node.hasProperty (ids::projectBitDepth))
        bd = (int) node.getProperty (ids::projectBitDepth);

    juce::String tb = node.hasProperty (ids::timeBase)
                          ? node.getProperty (ids::timeBase).toString()
                          : juce::String ("seconds");

    auto* o = new DynamicObject();
    o->setProperty ("sampleRate", sr);
    o->setProperty ("bitDepth", bd);
    o->setProperty ("timeBase", tb);
    return var (o);
}

juce::var MoshOps::cmdSetProjectSettings (const juce::var& args)
{
    // Per-project format / time-base INTENT — a producer preference (the export/
    // format default + the timeline display base), NOT a live device change. Stored
    // on a MOSH_PROJECT child of the Edit tree so it persists with the session, and
    // followed the cmdSetMetronome template exactly: no Tracktion transaction (no
    // beginNewTransaction), logLine(..., false), emitSnapshotInvalidated. Works
    // headless (no audio device required).
    //
    // Validate every supplied field before writing anything (partial patch: each
    // field is optional, but a present field that fails validation is a hard error
    // and leaves the stored settings untouched).
    if (args.hasProperty ("sampleRate"))
    {
        const double sr = (double) args.getProperty ("sampleRate", 0.0);
        if (sr < 7000.0)
            return errResult ("set_project_settings", "sampleRate must be >= 7000");
    }
    if (args.hasProperty ("bitDepth"))
    {
        const int bd = (int) args.getProperty ("bitDepth", 0);
        if (bd != 16 && bd != 24 && bd != 32)
            return errResult ("set_project_settings", "bitDepth must be one of 16, 24, 32");
    }
    if (args.hasProperty ("timeBase"))
    {
        const auto tb = args.getProperty ("timeBase", var()).toString();
        if (tb != "seconds" && tb != "barsBeats")
            return errResult ("set_project_settings", "timeBase must be 'seconds' or 'barsBeats'");
    }

    auto node = projectSettingsTree();
    if (args.hasProperty ("sampleRate"))
        node.setProperty (ids::projectSampleRate, (double) args.getProperty ("sampleRate", 0.0), nullptr);
    if (args.hasProperty ("bitDepth"))
        node.setProperty (ids::projectBitDepth, (int) args.getProperty ("bitDepth", 0), nullptr);
    if (args.hasProperty ("timeBase"))
        node.setProperty (ids::timeBase, args.getProperty ("timeBase", var()).toString(), nullptr);

    logLine ("set_project_settings", args, true, {}, false);   // preference — NOT undoable
    emitSnapshotInvalidated();
    return okResult ("set_project_settings", projectSettingsToVar());
}

juce::var MoshOps::cmdUndo (const juce::var& args)
{
    const bool did = undoManager().undo();
    logLine ("undo", args, did, did ? String() : String ("nothing to undo"), false);
    emitSnapshotInvalidated();
    return okResult ("undo", var (did));
}

juce::var MoshOps::cmdRedo (const juce::var& args)
{
    const bool did = undoManager().redo();
    logLine ("redo", args, did, did ? String() : String ("nothing to redo"), false);
    emitSnapshotInvalidated();
    return okResult ("redo", var (did));
}

juce::var MoshOps::cmdSave (const juce::var& args)
{
    const bool ok = eng.save();
    logLine ("save", args, ok, ok ? String() : String ("save failed"), false);
    return ok ? okResult ("save") : errResult ("save", "save failed");
}

juce::var MoshOps::cmdReload (const juce::var& args)
{
    unregisterAllMeterClients();        // old measurers are still valid here
    eng.reloadFromFile();               // reconcileMeterClients() re-registers on the next frame
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    logLine ("reload", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("reload");
}

juce::var MoshOps::cmdAddRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("add_render_layer", "no clip: " + clipId);

    undoManager().beginNewTransaction ("add_render_layer");
    auto pos = clip->getPosition();
    auto node = RenderLayer::create (
        "rl-" + String (Time::getCurrentTime().toMilliseconds()),
        clip->itemID.toString(),
        pos.getStart().inSeconds(), pos.getEnd().inSeconds(),
        args.getProperty ("adapter", "fake").toString());
    clip->state.appendChild (node, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("layerId", node[ids::id].toString());
    logLine ("add_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_render_layer", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — arrangement editing
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdMoveClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("move_clip", "no clip: " + id);

    undoManager().beginNewTransaction ("move_clip");
    const double newStart = juce::jmax (0.0, (double) args.getProperty ("start", clip->getPosition().getStart().inSeconds()));
    clip->setStart (tracktion::TimePosition::fromSeconds (newStart), false, true);   // keep length

    // Optional move to another track.
    if (args.hasProperty ("trackId"))
        if (auto* dest = findTrack (args.getProperty ("trackId", var()).toString()))
            if (dest != clip->getTrack())
                clip->moveTo (*dest);

    logLine ("move_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_clip");
}

juce::var MoshOps::cmdTrimClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("trim_clip", "no clip: " + id);

    auto pos = clip->getPosition();
    const double start  = (double) args.getProperty ("start",  pos.getStart().inSeconds());
    const double length = juce::jmax (0.01, (double) args.getProperty ("length", pos.getLength().inSeconds()));
    const double offset = (double) args.getProperty ("offset", pos.getOffset().inSeconds());

    undoManager().beginNewTransaction ("trim_clip");
    clip->setPosition ({ { tracktion::TimePosition::fromSeconds (start),
                           tracktion::TimeDuration::fromSeconds (length) },
                         tracktion::TimeDuration::fromSeconds (offset) });
    logLine ("trim_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("trim_clip");
}

juce::var MoshOps::cmdSplitClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("split_clip", "no clip: " + id);
    auto* clipTrack = dynamic_cast<te::ClipTrack*> (clip->getTrack());
    if (clipTrack == nullptr) return errResult ("split_clip", "clip not on a clip track");

    const double at = (double) args.getProperty ("time", 0.0);
    undoManager().beginNewTransaction ("split_clip");
    auto* newClip = clipTrack->splitClip (*clip, tracktion::TimePosition::fromSeconds (at));

    auto* data = new DynamicObject();
    if (newClip != nullptr) data->setProperty ("newClipId", newClip->itemID.toString());
    logLine ("split_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("split_clip", var (data));
}

juce::var MoshOps::cmdRemoveClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("remove_clip", "no clip");
    undoManager().beginNewTransaction ("remove_clip");
    clip->removeFromParent();
    logLine ("remove_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_clip");
}

juce::var MoshOps::cmdRenameClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("rename_clip", "no clip");
    undoManager().beginNewTransaction ("rename_clip");
    clip->setName (args.getProperty ("name", var()).toString());
    logLine ("rename_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_clip");
}

juce::var MoshOps::cmdSetClipMute (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("set_clip_mute", "no clip");
    undoManager().beginNewTransaction ("set_clip_mute");
    clip->setMuted ((bool) args.getProperty ("mute", false));
    logLine ("set_clip_mute", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_mute");
}

juce::var MoshOps::cmdSetClipGain (const juce::var& args)
{
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_gain", "not an audio clip");
    undoManager().beginNewTransaction ("set_clip_gain");
    ac->setGainDB (juce::jlimit (-48.0f, 24.0f, (float) (double) args.getProperty ("gainDb", 0.0)));
    logLine ("set_clip_gain", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_gain");
}

juce::var MoshOps::cmdDuplicateClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("duplicate_clip", "no clip");
    auto* track = dynamic_cast<te::ClipTrack*> (clip->getTrack());
    if (track == nullptr) return errResult ("duplicate_clip", "clip not on a clip track");

    auto pos = clip->getPosition();
    const double newStart = pos.getEnd().inSeconds();
    const double len = pos.getLength().inSeconds();

    undoManager().beginNewTransaction ("duplicate_clip");
    te::Clip* dup = nullptr;
    if (auto* w = dynamic_cast<te::WaveAudioClip*> (clip))
    {
        auto nc = track->insertWaveClip (clip->getName(), w->getCurrentSourceFile(),
            { { tracktion::TimePosition::fromSeconds (newStart), pos.getLength() }, pos.getOffset() }, false);
        if (nc != nullptr) { nc->setGainDB (w->getGainDB()); dup = nc.get(); }
    }
    else if (auto* m = dynamic_cast<te::MidiClip*> (clip))
    {
        auto nc = track->insertMIDIClip (clip->getName(),
            { tracktion::TimePosition::fromSeconds (newStart),
              tracktion::TimePosition::fromSeconds (newStart + len) }, nullptr);
        if (nc != nullptr)
        {
            auto& src = m->getSequence();
            auto& dst = nc->getSequence();
            for (int i = 0; i < src.getNumNotes(); ++i)
                if (auto* n = src.getNote (i))
                    dst.addNote (n->getNoteNumber(), n->getStartBeat(), n->getLengthBeats(),
                                 n->getVelocity(), 0, &undoManager());
            dup = nc.get();
        }
    }
    if (dup == nullptr) return errResult ("duplicate_clip", "could not duplicate this clip type");
    dup->setMuted (clip->isMuted());

    auto* data = new DynamicObject();
    data->setProperty ("newClipId", dup->itemID.toString());
    logLine ("duplicate_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("duplicate_clip", var (data));
}

// Recreate a clip from a clipToVar-shaped descriptor on a target track at a
// target time. This is the paste half of the UI-local copy/cut/paste clipboard
// (the clipboard itself is view state and never crosses the bridge until here).
// A genuine undoable edit: open a transaction and log undoable:true.
juce::var MoshOps::cmdPasteClip (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    if (trackId.isEmpty()) return errResult ("paste_clip", "missing 'trackId'");

    const auto clipVar = args.getProperty ("clip", var());
    if (! clipVar.isObject()) return errResult ("paste_clip", "missing 'clip'");

    const auto type = clipVar.getProperty ("type", var()).toString();
    if (type != "wave" && type != "midi")
        return errResult ("paste_clip", "unsupported clip type: " + type);

    // Validate cheap per-type preconditions BEFORE any side effect (transaction /
    // track auto-create) so a malformed descriptor errors out with zero side effects
    // (no orphan track left behind, no empty transaction opened).
    File waveSource;
    if (type == "wave")
    {
        const auto sourcePath = clipVar.getProperty ("sourceFile", var()).toString();
        if (sourcePath.isEmpty()) return errResult ("paste_clip", "wave clip missing 'sourceFile'");
        waveSource = File (sourcePath);
        if (! waveSource.existsAsFile()) return errResult ("paste_clip", "source file not found: " + sourcePath);
    }

    auto* track = findTrack (trackId);

    undoManager().beginNewTransaction ("paste_clip");
    // Match cmdImportClip/cmdAddMidiClip: create the track if it's missing.
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult ("paste_clip", "no track");

    const double start  = (double) args.getProperty ("start", 0.0);
    const double length = juce::jmax (0.0, (double) clipVar.getProperty ("length", 0.0));
    const double offset = (double) clipVar.getProperty ("offset", 0.0);
    auto name = clipVar.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = (type == "midi") ? "MIDI" : "clip";

    te::Clip* pasted = nullptr;
    if (type == "wave")
    {
        auto nc = track->insertWaveClip (name, waveSource,
            { { tracktion::TimePosition::fromSeconds (start), tracktion::TimeDuration::fromSeconds (length) },
              tracktion::TimeDuration::fromSeconds (offset) }, false);
        if (nc == nullptr) return errResult ("paste_clip", "insertWaveClip failed");
        nc->setGainDB ((float) (double) clipVar.getProperty ("gainDb", 0.0));
        pasted = nc.get();
    }
    else // midi
    {
        auto nc = track->insertMIDIClip (name,
            { tracktion::TimePosition::fromSeconds (start),
              tracktion::TimePosition::fromSeconds (start + length) }, nullptr);
        if (nc == nullptr) return errResult ("paste_clip", "insertMIDIClip failed");

        auto& sequence = nc->getSequence();
        // Bind the notes array to a local before getArray(): a pointer into a
        // temporary var dangles (has bitten prior waves).
        const auto notesVar = clipVar.getProperty ("notes", var());
        if (notesVar.isArray())
            for (auto& n : *notesVar.getArray())
                sequence.addNote (juce::jlimit (0, 127, (int) n.getProperty ("pitch", 60)),
                                  tracktion::BeatPosition::fromBeats ((double) n.getProperty ("start", 0.0)),
                                  tracktion::BeatDuration::fromBeats (juce::jmax (0.0625, (double) n.getProperty ("length", 1.0))),
                                  juce::jlimit (1, 127, (int) n.getProperty ("velocity", 100)), 0, &undoManager());
        pasted = nc.get();
    }

    if (pasted == nullptr) return errResult ("paste_clip", "could not paste this clip type");
    pasted->setMuted ((bool) clipVar.getProperty ("mute", false));

    // Tracktion queues a track/clip AsyncUpdater after a headless insert; drain
    // it before returning so itemIDs settle (mirrors createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("clipId", pasted->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("paste_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("paste_clip", var (data));
}

juce::var MoshOps::cmdSetTrackVolume (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_volume", "no track");
    auto* vp = ensureVolumePlugin (*track);
    if (vp == nullptr) return errResult ("set_track_volume", "no volume plugin");

    undoManager().beginNewTransaction ("set_track_volume");
    vp->setVolumeDb ((float) (double) args.getProperty ("db", 0.0));
    logLine ("set_track_volume", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_volume");
}

juce::var MoshOps::cmdSetTrackPan (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_pan", "no track");
    auto* vp = ensureVolumePlugin (*track);
    if (vp == nullptr) return errResult ("set_track_pan", "no volume plugin");

    undoManager().beginNewTransaction ("set_track_pan");
    vp->setPan (juce::jlimit (-1.0f, 1.0f, (float) (double) args.getProperty ("pan", 0.0)));
    logLine ("set_track_pan", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_pan");
}

juce::var MoshOps::cmdSetTrackMute (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_mute", "no track");
    undoManager().beginNewTransaction ("set_track_mute");
    track->setMute ((bool) args.getProperty ("mute", false));
    logLine ("set_track_mute", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_mute");
}

juce::var MoshOps::cmdSetTrackSolo (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_solo", "no track");
    undoManager().beginNewTransaction ("set_track_solo");
    track->setSolo ((bool) args.getProperty ("solo", false));
    logLine ("set_track_solo", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_solo");
}

juce::var MoshOps::cmdArmTrack (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("arm_track", "no track");
    const bool armed = (bool) args.getProperty ("armed", false);

    // Record-arm is a monitoring preference, NOT an undoable session edit: the engine
    // binds the destination's `armed` flag with a nullptr UndoManager
    // (tracktion_InputDevice.h: recordEnabled.referTo (state, IDs::armed, nullptr, false)),
    // so a transaction here would be empty. Treat it like set_metronome / set_transport.

    // getAllInputDevices() is empty headless / without a playback context, so there
    // are no instances to operate on. Degrade gracefully: ok result, applied:false,
    // never an error (mirrors cmdSetTransport skipping play/record when !hasAudio()).
    bool applied = false;
    auto inputs = eng.edit().getAllInputDevices();

    // Find an instance already targeting this track at slot 0.
    te::InputDeviceInstance* target = nullptr;
    for (auto* inst : inputs)
        if (inst != nullptr && te::isOnTargetTrack (*inst, *track, 0))
        {
            target = inst;
            break;
        }

    // Arming a virgin track: assign an available input first, then enable
    // (RecordingDemo does setTarget + setRecordingEnabled together). Disarming a track
    // with no instance is a harmless no-op.
    //
    // CTL-001 — route MIDI to instrument tracks: an instrument track (one hosting a
    // synth) should receive live MIDI from a controller, not a wave input, so a played
    // note turns into audio. We therefore prefer a MIDI input instance when the track
    // has an instrument, and a wave input otherwise. setTarget + setRecordingEnabled
    // are identical calls for either device family. There is NO Tracktion "all MIDI
    // inputs auto-route to the armed track" behaviour — each input must be explicitly
    // targeted; we pick the FIRST matching input (multi-controller disambiguation is a
    // later enhancement). Wave-only tracks are unchanged from the recording wave.
    if (target == nullptr && armed)
    {
        const bool wantMidi = trackHasInstrument (*track);

        auto matchesPreferred = [wantMidi] (te::InputDeviceInstance* inst)
        {
            const auto type = inst->getInputDevice().getDeviceType();
            return wantMidi ? (type == te::InputDevice::physicalMidiDevice
                                   || type == te::InputDevice::virtualMidiDevice)
                            : (type == te::InputDevice::waveDevice);
        };

        // First pass: the preferred device family (MIDI for instrument tracks, wave
        // otherwise). Fallback pass: the other family, so arming still does something
        // sensible if e.g. only a wave input is present (or only MIDI, no synth yet).
        for (int pass = 0; pass < 2 && target == nullptr; ++pass)
            for (auto* inst : inputs)
            {
                if (inst == nullptr) continue;
                const bool preferred = matchesPreferred (inst);
                if (pass == 0 ? ! preferred : preferred)
                    continue;     // pass 0: preferred only; pass 1: the other family only
                if (! (inst->getInputDevice().getDeviceType() == te::InputDevice::waveDevice
                       || inst->getInputDevice().isMidi()))
                    continue;     // ignore track-wave/track-midi internal device types

                // setTarget returns tl::expected — check the error, never blind-deref.
                // Pass nullptr (no UndoManager): arming is a non-undoable preference, so
                // the target assignment stays off the Edit undo stack too (it still
                // persists in the input-device ValueTree and saves with the Edit).
                if (auto r = inst->setTarget (track->itemID, true, nullptr, 0))
                {
                    target = inst;
                    break;
                }
                else
                {
                    // Genuine assignment failure (a live device rejected the target):
                    // log exactly once and surface as an error — never a misleading ok.
                    logLine ("arm_track", args, false, r.error(), false);
                    return errResult ("arm_track", r.error());
                }
            }
    }

    if (target != nullptr)
    {
        target->setRecordingEnabled (track->itemID, armed);
        applied = true;
    }

    logLine ("arm_track", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("armed", armed);
    data->setProperty ("applied", applied);
    if (! applied)
        data->setProperty ("reason", "no input device");
    return okResult ("arm_track", var (data));
}

juce::var MoshOps::cmdSetInputMonitor (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_input_monitor", "no track");

    // Accept either { mode: "off"|"automatic"|"on" } or legacy { monitor: bool }.
    juce::String modeStr;
    if (args.hasProperty ("mode"))
        modeStr = args.getProperty ("mode", var()).toString();
    else if (args.hasProperty ("monitor"))
        modeStr = ((bool) args.getProperty ("monitor", false)) ? "on" : "off";
    else
        modeStr = "automatic";

    te::InputDevice::MonitorMode mode;
    if (modeStr == "off")            mode = te::InputDevice::MonitorMode::off;
    else if (modeStr == "automatic") mode = te::InputDevice::MonitorMode::automatic;
    else if (modeStr == "on")        mode = te::InputDevice::MonitorMode::on;
    else return errResult ("set_input_monitor", "bad mode: " + modeStr);

    // Input monitoring is a device preference, NOT an undoable Edit change: setMonitorMode
    // writes the field + saveProps() (global engine props, not the Edit value tree), so a
    // transaction would be empty. Treat it like set_metronome.

    // Monitor mode is a property of the shared InputDevice (the *device*, not the
    // instance) — two tracks fed by the same physical input share one monitor mode.
    // Headless getAllInputDevices() is empty → no-op, applied:false (never an error).
    bool applied = false;
    for (auto* inst : eng.edit().getAllInputDevices())
        if (inst != nullptr && te::isOnTargetTrack (*inst, *track, 0))
        {
            inst->getInputDevice().setMonitorMode (mode);
            applied = true;
            break;
        }

    logLine ("set_input_monitor", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("mode", modeStr);
    data->setProperty ("applied", applied);
    if (! applied)
        data->setProperty ("reason", "no input device");
    return okResult ("set_input_monitor", var (data));
}

juce::var MoshOps::cmdSetMasterVolume (const juce::var& args)
{
    auto mvp = eng.edit().getMasterVolumePlugin();
    if (mvp == nullptr) return errResult ("set_master_volume", "no master plugin");
    undoManager().beginNewTransaction ("set_master_volume");
    mvp->setVolumeDb (juce::jlimit (-48.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_master_volume", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_volume");
}

juce::var MoshOps::cmdSetMasterPan (const juce::var& args)
{
    auto mvp = eng.edit().getMasterVolumePlugin();
    if (mvp == nullptr) return errResult ("set_master_pan", "no master plugin");
    undoManager().beginNewTransaction ("set_master_pan");
    mvp->setPan (juce::jlimit (-1.0f, 1.0f, (float) (double) args.getProperty ("pan", 0.0)));
    logLine ("set_master_pan", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_pan");
}

juce::var MoshOps::cmdEnableTrackMeter (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("enable_track_meter", "no track");
    undoManager().beginNewTransaction ("enable_track_meter");
    if (ensureTrackMeter (*track) == nullptr) return errResult ("enable_track_meter", "could not create meter");
    logLine ("enable_track_meter", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("enable_track_meter");
}

juce::var MoshOps::cmdDisableTrackMeter (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("disable_track_meter", "no track");
    const auto id = track->itemID.toString();
    if (auto it = meterClients.find (id); it != meterClients.end())
    {
        if (it->second != nullptr && it->second->plugin != nullptr)
            it->second->plugin->measurer.removeClient (it->second->client);   // unregister before delete
        meterClients.erase (it);
    }
    undoManager().beginNewTransaction ("disable_track_meter");
    if (auto* lm = findTrackMeter (*track)) lm->deleteFromParent();
    logLine ("disable_track_meter", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("disable_track_meter");
}

juce::var MoshOps::cmdEnableAllMeters (const juce::var& args)
{
    undoManager().beginNewTransaction ("enable_all_meters");
    int n = 0;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr && ensureTrackMeter (*t) != nullptr) ++n;
    logLine ("enable_all_meters", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("count", n);
    return okResult ("enable_all_meters", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 8 — sends / returns / aux buses. A "bus" is an integer busNumber; the
// return is a normal AudioTrack carrying an AuxReturnPlugin (which renders even
// with no input). Sends are post-fader AuxSendPlugins appended to a track's
// chain, routed purely by matching busNumber. (Plan: docs/plans/wave-sends.md.)
// ─────────────────────────────────────────────────────────────────────────────
te::AuxReturnPlugin* MoshOps::firstAuxReturnOn (te::AudioTrack& t)
{
    for (auto* p : t.pluginList.getPlugins())
        if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (p))
            return r;
    return nullptr;
}

te::AudioTrack* MoshOps::findReturnTrackForBus (int bus)
{
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* r = firstAuxReturnOn (*t))
                if (r->busNumber.get() == bus)
                    return t;
    return nullptr;
}

int MoshOps::allocateBusNumber()
{
    juce::Array<int> used;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            for (auto* p : t->pluginList.getPlugins())
                if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (p))
                    used.add (r->busNumber.get());
    int n = 0;
    while (used.contains (n)) ++n;
    return n;
}

juce::var MoshOps::cmdCreateBus (const juce::var& args)
{
    auto& edit = eng.edit();
    const int bus = allocateBusNumber();
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = "Bus " + String (bus + 1);

    undoManager().beginNewTransaction ("create_bus");
    auto* track = createAudioTrack (name);
    if (track == nullptr) return errResult ("create_bus", "could not create return track");

    auto plugin = edit.getPluginCache().createNewPlugin (te::AuxReturnPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("create_bus", "could not create aux return");
    if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (plugin.get()))
        r->busNumber = bus;
    track->pluginList.insertPlugin (plugin, 0, nullptr);
    ensureVolumePlugin (*track);
    edit.setAuxBusName (bus, name);

    auto* data = new DynamicObject();
    data->setProperty ("busNumber", bus);
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("name", name);
    logLine ("create_bus", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_bus", var (data));
}

juce::var MoshOps::cmdAddSend (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_send", "no track");
    const int bus = (int) args.getProperty ("bus", -1);
    if (findReturnTrackForBus (bus) == nullptr) return errResult ("add_send", "no such bus");
    if (track->getAuxSendPlugin (bus) != nullptr) return errResult ("add_send", "send already exists");

    undoManager().beginNewTransaction ("add_send");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::AuxSendPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("add_send", "could not create aux send");
    if (auto* s = dynamic_cast<te::AuxSendPlugin*> (plugin.get()))
    {
        s->busNumber = bus;
        track->pluginList.insertPlugin (plugin, track->pluginList.getPlugins().size(), nullptr);  // append → post-fader
        s->setGainDb (juce::jlimit (-60.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0)));
    }
    logLine ("add_send", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("bus", bus);
    return okResult ("add_send", var (data));
}

juce::var MoshOps::cmdSetSendLevel (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_send_level", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("set_send_level", "no send to that bus");
    undoManager().beginNewTransaction ("set_send_level");
    s->setGainDb (juce::jlimit (-100.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_send_level", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_send_level");
}

juce::var MoshOps::cmdRemoveSend (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("remove_send", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("remove_send", "no send to that bus");
    undoManager().beginNewTransaction ("remove_send");
    s->deleteFromParent();
    logLine ("remove_send", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_send");
}

juce::var MoshOps::cmdRemoveBus (const juce::var& args)
{
    const int bus = (int) args.getProperty ("bus", -1);
    if (bus < 0) return errResult ("remove_bus", "bad bus");
    auto* returnTrack = findReturnTrackForBus (bus);
    if (returnTrack == nullptr) return errResult ("remove_bus", "no such bus");

    undoManager().beginNewTransaction ("remove_bus");
    // Sweep orphan sends pointing at this bus, then drop the name + the return track.
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* s = t->getAuxSendPlugin (bus))
                s->deleteFromParent();
    eng.edit().setAuxBusName (bus, {});
    eng.edit().deleteTrack (returnTrack);
    logLine ("remove_bus", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_bus");
}

juce::var MoshOps::cmdRenameBus (const juce::var& args)
{
    const int bus = (int) args.getProperty ("bus", -1);
    auto* returnTrack = findReturnTrackForBus (bus);
    if (returnTrack == nullptr) return errResult ("rename_bus", "no such bus");
    undoManager().beginNewTransaction ("rename_bus");
    const auto name = args.getProperty ("name", var()).toString();
    eng.edit().setAuxBusName (bus, name);
    returnTrack->setName (name);
    logLine ("rename_bus", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_bus");
}

juce::var MoshOps::cmdGetClipPeaks (const juce::var& args)
{
    // Backend-computed waveform peaks (peak array per clip; no audio on the web
    // thread, 03 // VERIFY). Read-only — not a mutation, no undo/log.
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    if (wave == nullptr) return errResult ("get_clip_peaks", "no wave clip: " + id);

    const int buckets = juce::jlimit (16, 4000, (int) args.getProperty ("buckets", 600));
    auto file = wave->getCurrentSourceFile();

    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (file));
    if (reader == nullptr) return errResult ("get_clip_peaks", "cannot read source");

    const auto total = (juce::int64) reader->lengthInSamples;
    const int chans = (int) reader->numChannels;
    const juce::int64 perBucket = juce::jmax ((juce::int64) 1, total / buckets);

    juce::Array<var> peaks;
    juce::AudioBuffer<float> buf (juce::jmax (1, chans), (int) juce::jmin (perBucket, (juce::int64) 65536));
    for (int b = 0; b < buckets; ++b)
    {
        const juce::int64 startSample = (juce::int64) b * perBucket;
        if (startSample >= total) break;
        const int n = (int) juce::jmin (perBucket, total - startSample, (juce::int64) buf.getNumSamples());
        buf.clear();
        reader->read (&buf, 0, n, startSample, true, chans > 1);
        float mn = 0.0f, mx = 0.0f;
        for (int c = 0; c < buf.getNumChannels(); ++c)
        {
            auto r = juce::FloatVectorOperations::findMinAndMax (buf.getReadPointer (c), n);
            mn = juce::jmin (mn, r.getStart());
            mx = juce::jmax (mx, r.getEnd());
        }
        juce::Array<var> pair; pair.add (mn); pair.add (mx);
        peaks.add (var (pair));
    }

    auto* data = new DynamicObject();
    data->setProperty ("clipId", id);
    data->setProperty ("buckets", peaks.size());
    data->setProperty ("peaks", peaks);
    return okResult ("get_clip_peaks", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — VST3 hosting + MIDI
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdListPlugins (const juce::var&)
{
    juce::Array<var> plugins;
    int nVst3 = 0, nAu = 0;
    for (auto& d : pluginHost.available())
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", PluginHost::idFor (d));
        o->setProperty ("name", d.name);
        o->setProperty ("format", d.pluginFormatName);   // "VST3" / "AudioUnit"
        o->setProperty ("manufacturer", d.manufacturerName);
        o->setProperty ("isInstrument", d.isInstrument);
        plugins.add (var (o));

        if (d.pluginFormatName == "AudioUnit") ++nAu;
        else if (d.pluginFormatName == "VST3") ++nVst3;
    }
    // Per-format counts for the manager UI (INS-005). Plain numbers, not Tracktion
    // concepts — VST3/AudioUnit are standard plugin formats.
    auto* counts = new DynamicObject();
    counts->setProperty ("vst3", nVst3);
    counts->setProperty ("au", nAu);
    counts->setProperty ("total", plugins.size());

    auto* data = new DynamicObject();
    data->setProperty ("plugins", plugins);
    data->setProperty ("counts", var (counts));
    return okResult ("list_plugins", var (data));
}

juce::var MoshOps::cmdListBuiltins (const juce::var&)
{
    // The engine's compiled-in plugin palette (instruments + effects). Static —
    // no scan needed; the UI groups these by category alongside scanned VST3/AUs.
    juce::Array<var> plugins;
    for (auto& b : kBuiltins)
    {
        auto* o = new DynamicObject();
        o->setProperty ("type", b.type);
        o->setProperty ("name", b.name);
        o->setProperty ("category", b.category);
        o->setProperty ("isInstrument", b.isInstrument);
        o->setProperty ("builtin", true);
        plugins.add (var (o));
    }
    auto* data = new DynamicObject();
    data->setProperty ("plugins", plugins);
    return okResult ("list_builtins", var (data));
}

juce::var MoshOps::cmdLoadBuiltin (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_builtin", "no track");

    const auto type = args.getProperty ("type", var()).toString();
    const auto* spec = findBuiltin (type);
    if (spec == nullptr) return errResult ("load_builtin", "unknown builtin: " + type);

    undoManager().beginNewTransaction ("load_builtin");
    // Same cache path as load_plugin — the inserted plugin IS the one we hold.
    auto plugin = eng.edit().getPluginCache().createNewPlugin (type, {});
    if (plugin == nullptr) return errResult ("load_builtin", "create failed: " + type);

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();   // append
    track->pluginList.insertPlugin (plugin, index, nullptr);

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", spec->isInstrument);
    logLine ("load_builtin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("load_builtin", var (data));
}

juce::var MoshOps::cmdLoadPlugin (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_plugin", "no track");

    const auto pluginId = args.getProperty ("pluginId", var()).toString();
    juce::PluginDescription desc;
    if (! pluginHost.findDescription (pluginId, desc))
        return errResult ("load_plugin", "unknown plugin: " + pluginId);

    undoManager().beginNewTransaction ("load_plugin");
    // MUST use the Edit's PluginCache so the inserted plugin IS the one we hold
    // (PluginManager::createNewPlugin yields a different instance → insertPlugin
    // re-creates from state, indexOf fails, and it asserts — engine's own note).
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, desc);
    if (plugin == nullptr) return errResult ("load_plugin", "create failed");

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();   // append (−1 does not append)
    track->pluginList.insertPlugin (plugin, index, nullptr);

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
    if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin.get()))
        addExternalPluginMetadata (*data, *ext);
    logLine ("load_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("load_plugin", var (data));
}

juce::var MoshOps::cmdRemovePlugin (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("remove_plugin", "no plugin");
    pluginHost.closeEditor (*plugin);
    undoManager().beginNewTransaction ("remove_plugin");
    plugin->deleteFromParent();
    logLine ("remove_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_plugin");
}

juce::var MoshOps::cmdReorderPlugin (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("reorder_plugin", "no track");
    const int from = (int) args.getProperty ("index", -1);
    const int to   = (int) args.getProperty ("toIndex", -1);
    auto plugins = track->pluginList.getPlugins();
    if (from < 0 || from >= plugins.size()) return errResult ("reorder_plugin", "bad index");

    te::Plugin::Ptr p = plugins[from];
    undoManager().beginNewTransaction ("reorder_plugin");
    p->removeFromParent();
    track->pluginList.insertPlugin (p, to, nullptr);
    logLine ("reorder_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("reorder_plugin");
}

juce::var MoshOps::cmdSetPluginParam (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("set_plugin_param", "no plugin");
    const int pi = (int) args.getProperty ("paramIndex", -1);
    if (pi < 0 || pi >= plugin->getNumAutomatableParameters())
        return errResult ("set_plugin_param", "bad paramIndex");

    auto param = plugin->getAutomatableParameter (pi);
    const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) args.getProperty ("value", 0.0));
    undoManager().beginNewTransaction ("set_plugin_param");
    param->setParameter (param->valueRange.convertFrom0to1 (norm), juce::sendNotification);
    logLine ("set_plugin_param", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_plugin_param");
}

juce::var MoshOps::cmdBypassPlugin (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("bypass_plugin", "no plugin");
    const bool bypassed = (bool) args.getProperty ("bypassed", false);
    undoManager().beginNewTransaction ("bypass_plugin");
    plugin->setEnabled (! bypassed);          // enabled == not bypassed
    logLine ("bypass_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bypass_plugin");
}

// ─────────────────────────────────────────────────────────────────────────────
// INS-005 — plugin scan & management. These mutate the plugin CATALOG, not the
// Edit, so they are NON-undoable (no Tracktion transaction); get_plugin_blocklist
// is read-only (no log). The catalog is a query (list_plugins) outside snapshot()
// — scan progress rides on transient 'plugin_scan_progress' events, never the
// snapshot (swappable-seam discipline).
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdRescanPlugins (const juce::var& args)
{
    const auto format = args.getProperty ("format", "all").toString();   // "vst3" | "au" | "all"
    const bool clearFirst = (bool) args.getProperty ("clearFirst", false);
    const bool includeVST3 = (format == "vst3" || format == "all");
    // AU is the slow/risky path: only when requested AND opted in (so --selftest,
    // which never sets MOSH_SCAN_AU, performs no AU sweep). VST3-only rescans are
    // always allowed.
    const bool auOptedIn = SystemStats::getEnvironmentVariable ("MOSH_SCAN_AU", {}) == "1";
    const bool includeAU = (format == "au" || format == "all") && auOptedIn;

    // wait:true forces a synchronous VST3 sweep (cheap + safe on the message thread).
    // AU cataloging ALWAYS runs on a background thread, even when wait:true, because
    // JUCE's AudioPluginFormat::createInstanceFromDescription marshals component
    // instantiation back to the message thread — a hanging AU stalls the UI with no
    // per-component timeout.  Only CRASHes are recovered via the dead-mans-pedal;
    // a HANG requires a forced app restart.  Never call the AU sweep synchronously
    // on the message thread.
    const bool wait = (bool) args.getProperty ("wait", false);
    if (! includeAU)
    {
        // VST3-only (or no formats): fast + safe, run synchronously.
        const int total = pluginHost.rescan (clearFirst, includeVST3, false);
        logLine ("rescan_plugins", args, true, {}, false);   // non-undoable catalog op
        emitSnapshotInvalidated();
        auto* d = new DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("count", total);
        return okResult ("rescan_plugins", var (d));
    }
    if (wait)
    {
        // wait:true with AU requested: do the VST3 part inline, THEN kick off the
        // AU sweep on a background thread and return "scanning" to the caller.
        // (Keeping the message-thread VST3 result gives the caller a useful count
        // while the AU sweep is in progress.)
        if (includeVST3)
            pluginHost.rescan (clearFirst, includeVST3, false);
    }

    // Async AU rescan — mirror cmdRenderLayer: do the slow work on a background
    // std::thread, marshal the result back to the message thread.
    emit ("plugin_scan_progress", [&] { auto* o = new DynamicObject();
        o->setProperty ("format", format); o->setProperty ("done", false); return var (o); }());
    // NOTE: clearFirst and the VST3 sweep have already run inline (if wait:true) or
    // will run together below (async path).  Pass clearFirst=false and includeVST3 in
    // the async lambda only if we didn't already do them above.
    const bool asyncClearFirst  = clearFirst && ! wait;
    const bool asyncIncludeVST3 = includeVST3 && ! wait;
    std::thread ([this, asyncClearFirst, asyncIncludeVST3, format]
    {
        const int total = pluginHost.rescan (asyncClearFirst, asyncIncludeVST3, true);
        juce::MessageManager::callAsync ([this, total, format]
        {
            emit ("plugin_scan_progress", [&] { auto* o = new juce::DynamicObject();
                o->setProperty ("format", format); o->setProperty ("count", total);
                o->setProperty ("done", true); return juce::var (o); }());
            emitSnapshotInvalidated();
        });
    }).detach();

    logLine ("rescan_plugins", args, true, {}, false);
    auto* d = new DynamicObject();
    d->setProperty ("status", "scanning");
    return okResult ("rescan_plugins", var (d));
}

juce::var MoshOps::cmdGetPluginBlocklist (const juce::var&)
{
    // READ-ONLY (no log/transaction) — modelled on cmdListAudioDevices.
    // The blacklist stores fileOrIdentifier strings (file paths for VST3,
    // "AudioUnit:..." for AU).  For each entry we try to present the UI-facing
    // idFor() form if the entry is still resolvable via the catalog; otherwise we
    // fall back to the raw fileOrIdentifier so the caller can see what was blocked.
    juce::Array<var> entries;
    auto rawIds = pluginHost.blocklist();
    // Use the unfiltered type list for the reverse-mapping: available() now filters
    // blocked entries, so blocked plugins would be invisible to the lookup.
    const auto allTypes = eng.engine().getPluginManager().knownPluginList.getTypes();

    for (auto& rawId : rawIds)
    {
        // Try to find a matching description in the full type catalog (including
        // blocked entries) to map rawId -> UI-facing idFor() form.
        String uiId = rawId;   // default: show the raw key
        for (auto& d : allTypes)
        {
            if (d.fileOrIdentifier == rawId)
            {
                uiId = PluginHost::idFor (d);
                break;
            }
        }
        auto* o = new DynamicObject();
        o->setProperty ("id",    uiId);
        o->setProperty ("rawId", rawId);   // the actual blacklist key, for debugging
        o->setProperty ("reason", "blocked");   // crashed-scan vs manual not tracked separately
        entries.add (var (o));
    }
    auto* data = new DynamicObject();
    data->setProperty ("blocklist", entries);
    return okResult ("get_plugin_blocklist", var (data));
}

juce::var MoshOps::cmdClearPluginBlocklist (const juce::var& args)
{
    pluginHost.clearBlocklist();
    logLine ("clear_plugin_blocklist", args, true, {}, false);   // catalog op, not undoable
    emitSnapshotInvalidated();
    return okResult ("clear_plugin_blocklist");
}

juce::var MoshOps::cmdBlockPlugin (const juce::var& args)
{
    const auto id = args.getProperty ("pluginId", var()).toString();
    if (id.isEmpty()) return errResult ("block_plugin", "missing pluginId");

    // The incoming pluginId is the UI-facing identifier (e.g. "VST3-Serum") produced
    // by idFor()/te::createIdentifierString.  The JUCE blacklist is keyed on
    // PluginDescription.fileOrIdentifier (a file path for VST3, an "AudioUnit:..."
    // string for AU).  We must resolve the UI id -> fileOrIdentifier before blocking,
    // otherwise the key is wrong and the block has no effect on future scans.
    juce::PluginDescription desc;
    if (pluginHost.findDescription (id, desc))
    {
        // Found in the live catalog: block by the format-native key (fileOrIdentifier).
        // available() filters blocked entries, so this plugin disappears from
        // list_plugins immediately without needing to remove it from the type list
        // (the type list is the persistent catalog; the blacklist is the gate).
        pluginHost.blockPlugin (desc.fileOrIdentifier);
    }
    else
    {
        // Not in the catalog. The caller may be passing a raw fileOrIdentifier or
        // an "AudioUnit:..." id directly.  Accept it as-is so AU crash-recovery and
        // pre-emptive blocks still work, but a bogus id is harmless (empty blacklist
        // entries do nothing).
        if (id.contains ("/") || id.startsWith ("AudioUnit:") || id.startsWith ("VST3:"))
            pluginHost.blockPlugin (id);
        else
            return errResult ("block_plugin", "pluginId not found in catalog and does not look like a raw identifier");
    }

    logLine ("block_plugin", args, true, {}, false);             // catalog op, not undoable
    emitSnapshotInvalidated();
    return okResult ("block_plugin");
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 7 — parameter automation. A parameter is addressed by
// (trackId, pluginIndex, paramIndex); values cross the seam normalised 0–1 and
// are mapped to the parameter's real range here. Times are in seconds.
// ─────────────────────────────────────────────────────────────────────────────
te::AutomatableParameter* MoshOps::findParam (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("pluginIndex", -1));
    if (plugin == nullptr) return nullptr;
    const int pi = (int) args.getProperty ("paramIndex", -1);
    if (pi < 0 || pi >= plugin->getNumAutomatableParameters()) return nullptr;
    return plugin->getAutomatableParameter (pi).get();
}

juce::var MoshOps::cmdAddAutomationPoint (const juce::var& args)
{
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("add_automation_point", "no such parameter");
    const double t = juce::jmax (0.0, (double) args.getProperty ("time", 0.0));
    const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) args.getProperty ("value", 0.0));
    undoManager().beginNewTransaction ("add_automation_point");
    const int idx = param->getCurve().addPoint (tracktion::TimePosition::fromSeconds (t),
                                                 param->valueRange.convertFrom0to1 (norm), 0.0f, &undoManager());
    logLine ("add_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("pointIndex", idx);
    return okResult ("add_automation_point", var (data));
}

juce::var MoshOps::cmdRemoveAutomationPoint (const juce::var& args)
{
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("remove_automation_point", "no such parameter");
    auto& curve = param->getCurve();
    const int idx = (int) args.getProperty ("pointIndex", -1);
    if (idx < 0 || idx >= curve.getNumPoints()) return errResult ("remove_automation_point", "bad pointIndex");
    undoManager().beginNewTransaction ("remove_automation_point");
    curve.removePoint (idx, &undoManager());
    logLine ("remove_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_automation_point");
}

juce::var MoshOps::cmdSetAutomationPoint (const juce::var& args)
{
    // Move a point: remove + re-add at the new (time, value).
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("set_automation_point", "no such parameter");
    auto& curve = param->getCurve();
    const int idx = (int) args.getProperty ("pointIndex", -1);
    if (idx < 0 || idx >= curve.getNumPoints()) return errResult ("set_automation_point", "bad pointIndex");

    const double t = juce::jmax (0.0, (double) args.getProperty ("time", curve.getPointTime (idx).inSeconds()));
    const float norm = juce::jlimit (0.0f, 1.0f,
        (float) (double) args.getProperty ("value", param->valueRange.convertTo0to1 (curve.getPointValue (idx))));
    undoManager().beginNewTransaction ("set_automation_point");
    curve.removePoint (idx, &undoManager());
    const int newIdx = curve.addPoint (tracktion::TimePosition::fromSeconds (t),
                                       param->valueRange.convertFrom0to1 (norm), 0.0f, &undoManager());
    logLine ("set_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("pointIndex", newIdx);
    return okResult ("set_automation_point", var (data));
}

juce::var MoshOps::cmdClearAutomation (const juce::var& args)
{
    auto* param = findParam (args);
    if (param == nullptr) return errResult ("clear_automation", "no such parameter");
    undoManager().beginNewTransaction ("clear_automation");
    param->getCurve().clear (&undoManager());
    logLine ("clear_automation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("clear_automation");
}

juce::var MoshOps::cmdOpenPluginEditor (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("open_plugin_editor", "no plugin");
    const bool contextActiveBefore = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    if (eng.hasAudio())
        eng.ensurePlaybackContext();
    const bool contextActiveAfter = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    pluginHost.openEditor (*plugin);          // native pop-out (not undoable)
    logLine ("open_plugin_editor", args, true, {}, false);
    auto* data = new DynamicObject();
    data->setProperty ("audioEnabled", eng.hasAudio());
    data->setProperty ("playbackContextActiveBefore", contextActiveBefore);
    data->setProperty ("playbackContextActive", contextActiveAfter);
    data->setProperty ("plugin", plugin->getName());
    return okResult ("open_plugin_editor", var (data));
}

juce::var MoshOps::cmdAddMidiClip (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    undoManager().beginNewTransaction ("add_midi_clip");
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult ("add_midi_clip", "no track");

    const double start = (double) args.getProperty ("start", 0.0);
    const double length = (double) args.getProperty ("length", 2.0);
    auto clip = track->insertMIDIClip (args.getProperty ("name", "MIDI").toString(),
        { tracktion::TimePosition::fromSeconds (start), tracktion::TimePosition::fromSeconds (start + length) }, nullptr);
    if (clip == nullptr) return errResult ("add_midi_clip", "insertMIDIClip failed");

    auto& sequence = clip->getSequence();
    if (auto notes = args.getProperty ("notes", var()); notes.isArray())
    {
        for (auto& n : *notes.getArray())
            sequence.addNote ((int) n.getProperty ("pitch", 60),
                              tracktion::BeatPosition::fromBeats ((double) n.getProperty ("start", 0.0)),
                              tracktion::BeatDuration::fromBeats ((double) n.getProperty ("length", 1.0)),
                              (int) n.getProperty ("velocity", 100), 0, &undoManager());
    }
    else
    {
        // Default: a C-major arpeggio so a synth has something to play (gate).
        const int pattern[] = { 60, 64, 67, 72 };
        for (int i = 0; i < 4; ++i)
            sequence.addNote (pattern[i], tracktion::BeatPosition::fromBeats ((double) i),
                              tracktion::BeatDuration::fromBeats (1.0), 100, 0, &undoManager());
    }

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("add_midi_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_midi_clip", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 4 — MIDI note editing (piano-roll). Notes are addressed in BEATS within
// the clip's sequence; the index is the position in getNotes() for the current
// snapshot (the UI refetches after every edit, so indices stay valid).
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdAddNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("add_note", "no midi clip");

    const int pitch = juce::jlimit (0, 127, (int) args.getProperty ("pitch", 60));
    const double start = juce::jmax (0.0, (double) args.getProperty ("start", 0.0));
    const double length = juce::jmax (0.0625, (double) args.getProperty ("length", 1.0));
    const int vel = juce::jlimit (1, 127, (int) args.getProperty ("velocity", 100));

    undoManager().beginNewTransaction ("add_note");
    mc->getSequence().addNote (pitch, tracktion::BeatPosition::fromBeats (start),
                               tracktion::BeatDuration::fromBeats (length), vel, 0, &undoManager());
    logLine ("add_note", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("noteCount", mc->getSequence().getNumNotes());
    return okResult ("add_note", var (data));
}

juce::var MoshOps::cmdRemoveNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("remove_note", "no midi clip");
    auto& seq = mc->getSequence();
    const int idx = (int) args.getProperty ("noteIndex", -1);
    if (idx < 0 || idx >= seq.getNumNotes()) return errResult ("remove_note", "bad noteIndex");

    undoManager().beginNewTransaction ("remove_note");
    seq.removeNote (*seq.getNote (idx), &undoManager());
    logLine ("remove_note", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_note");
}

juce::var MoshOps::cmdSetNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("set_note", "no midi clip");
    auto& seq = mc->getSequence();
    const int idx = (int) args.getProperty ("noteIndex", -1);
    if (idx < 0 || idx >= seq.getNumNotes()) return errResult ("set_note", "bad noteIndex");
    auto* note = seq.getNote (idx);

    undoManager().beginNewTransaction ("set_note");
    if (args.hasProperty ("pitch"))
        note->setNoteNumber (juce::jlimit (0, 127, (int) args.getProperty ("pitch", note->getNoteNumber())), &undoManager());
    if (args.hasProperty ("start") || args.hasProperty ("length"))
    {
        const double start  = juce::jmax (0.0, (double) args.getProperty ("start",  note->getStartBeat().inBeats()));
        const double length = juce::jmax (0.0625, (double) args.getProperty ("length", note->getLengthBeats().inBeats()));
        note->setStartAndLength (tracktion::BeatPosition::fromBeats (start),
                                 tracktion::BeatDuration::fromBeats (length), &undoManager());
    }
    if (args.hasProperty ("velocity"))
        note->setVelocity (juce::jlimit (1, 127, (int) args.getProperty ("velocity", note->getVelocity())), &undoManager());

    logLine ("set_note", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_note");
}

juce::var MoshOps::cmdQuantizeNotes (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("quantize_notes", "no midi clip");
    auto& seq = mc->getSequence();

    const double division = juce::jmax (0.03125, (double) args.getProperty ("division", 1.0));   // beats
    const double strength = juce::jlimit (0.0, 1.0, (double) args.getProperty ("strength", 1.0));

    undoManager().beginNewTransaction ("quantize_notes");
    int moved = 0;
    for (int i = 0; i < seq.getNumNotes(); ++i)
    {
        auto* note = seq.getNote (i);
        const double start = note->getStartBeat().inBeats();
        const double q = std::round (start / division) * division;
        const double next = start + (q - start) * strength;
        if (std::abs (next - start) > 1.0e-6)
        {
            note->setStartAndLength (tracktion::BeatPosition::fromBeats (juce::jmax (0.0, next)),
                                     note->getLengthBeats(), &undoManager());
            ++moved;
        }
    }
    logLine ("quantize_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("moved", moved);
    return okResult ("quantize_notes", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4 — Tier-A real-time neural insert
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdAddNeuralInsert (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_neural_insert", "no track");

    undoManager().beginNewTransaction ("add_neural_insert");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (NeuralInsertPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("add_neural_insert", "create failed");
    if (auto* n = asNeural (plugin.get()))
        n->selectModel (args.getProperty ("modelId", "nam").toString());

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();
    track->pluginList.insertPlugin (plugin, index, nullptr);

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    logLine ("add_neural_insert", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_neural_insert", var (data));
}

juce::var MoshOps::cmdSetNeuralParam (const juce::var& args)
{
    auto* n = asNeural (findPlugin (args.getProperty ("trackId", var()).toString(),
                                    (int) args.getProperty ("index", -1)));
    if (n == nullptr) return errResult ("set_neural_param", "no neural insert");
    undoManager().beginNewTransaction ("set_neural_param");
    n->setNeuralParamUi (args.getProperty ("paramId", "drive").toString(),
                         (float) (double) args.getProperty ("value", 0.0));   // 0–100 UI
    logLine ("set_neural_param", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_neural_param");
}

juce::var MoshOps::cmdSetNeuralLabMode (const juce::var& args)
{
    auto* n = asNeural (findPlugin (args.getProperty ("trackId", var()).toString(),
                                    (int) args.getProperty ("index", -1)));
    if (n == nullptr) return errResult ("set_neural_lab_mode", "no neural insert");
    undoManager().beginNewTransaction ("set_neural_lab_mode");
    n->setLabMode ((bool) args.getProperty ("on", false));
    logLine ("set_neural_lab_mode", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_neural_lab_mode", n->describe());
}

juce::var MoshOps::cmdSetNeuralLatency (const juce::var& args)
{
    auto* n = asNeural (findPlugin (args.getProperty ("trackId", var()).toString(),
                                    (int) args.getProperty ("index", -1)));
    if (n == nullptr) return errResult ("set_neural_latency", "no neural insert");
    n->setLatencySamples ((int) args.getProperty ("samples", 0));
    logLine ("set_neural_latency", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_neural_latency", n->describe());
}

juce::var MoshOps::cmdResetNeural (const juce::var& args)
{
    auto* n = asNeural (findPlugin (args.getProperty ("trackId", var()).toString(),
                                    (int) args.getProperty ("index", -1)));
    if (n == nullptr) return errResult ("reset_neural", "no neural insert");
    n->resetModel();
    logLine ("reset_neural", args, true, {}, false);
    return okResult ("reset_neural");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 — Tier-B generative layer (RenderLayer flow)
// ─────────────────────────────────────────────────────────────────────────────
juce::ValueTree MoshOps::findRenderLayer (const juce::String& clipId)
{
    if (auto* clip = findClip (clipId))
        return clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
    return {};
}

juce::String MoshOps::computeFingerprint (const juce::ValueTree& node, const juce::File& inputWav)
{
    const auto upstreamHash = juce::MD5 (inputWav).toHexString();   // full upstream audio hash
    return RenderLayer::fingerprint (node, upstreamHash, "120bpm/Cmaj", 44100, 2,
                                     jobManager.serviceBuild());
}

juce::var MoshOps::cmdCreateRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("create_render_layer", "no clip: " + clipId);
    if (clip->state.getChildWithName (ids::MOSH_RENDERLAYER).isValid())
        return errResult ("create_render_layer", "clip already has a render layer");

    undoManager().beginNewTransaction ("create_render_layer");
    auto pos = clip->getPosition();
    auto node = RenderLayer::create ("rl-" + String (Time::getCurrentTime().toMilliseconds()),
        clipId, pos.getStart().inSeconds(), pos.getEnd().inSeconds(),
        args.getProperty ("adapter", "fake").toString());
    if (args.hasProperty ("mode"))         node.setProperty (ids::mode, args.getProperty ("mode", "reimagine"), nullptr);
    if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), nullptr);
    clip->state.appendChild (node, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("layerId", node[ids::id].toString());
    logLine ("create_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_render_layer", var (data));
}

juce::var MoshOps::cmdSetRenderParam (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("set_render_param", "no render layer");

    undoManager().beginNewTransaction ("set_render_param");
    auto params = node.getChildWithName (ids::PARAMS);
    if (args.hasProperty ("prompt")) params.setProperty (ids::prompt, args.getProperty ("prompt", ""), &undoManager());
    if (args.hasProperty ("cfg"))    params.setProperty (ids::cfg, args.getProperty ("cfg", 7.0), &undoManager());
    if (args.hasProperty ("steps"))  params.setProperty (ids::steps, args.getProperty ("steps", 30), &undoManager());
    if (args.hasProperty ("nl"))     params.setProperty (ids::nl, args.getProperty ("nl", 0.4), &undoManager());
    if (args.hasProperty ("seed"))   node.setProperty (ids::seed, args.getProperty ("seed", 0), &undoManager());
    if (args.hasProperty ("mode"))   node.setProperty (ids::mode, args.getProperty ("mode", "reimagine"), &undoManager());
    if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), &undoManager());
    if (args.hasProperty ("lab"))    params.setProperty (juce::Identifier ("lab"), args.getProperty ("lab", false), &undoManager());

    if (args.hasProperty ("colors"))   // ≤3, ordered (01 §4.4)
    {
        auto colors = params.getChildWithName (ids::COLORS);
        colors.removeAllChildren (&undoManager());
        if (auto* arr = args.getProperty ("colors", var()).getArray())
            for (int i = 0; i < juce::jmin (3, arr->size()); ++i)
            {
                auto& c = arr->getReference (i);
                juce::ValueTree col (ids::COLOR);
                col.setProperty (ids::name, c.getProperty ("name", ""), nullptr);
                col.setProperty (ids::value, c.getProperty ("value", 0), nullptr);
                colors.appendChild (col, &undoManager());
            }
    }

    node.setProperty (ids::status, "dirty", nullptr);   // params changed → re-render
    logLine ("set_render_param", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_render_param");
}

juce::var MoshOps::cmdRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("render_layer", "no render layer");

    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    if (wave == nullptr) return errResult ("render_layer", "only wave clips renderable in v0");

    // Prepare the job dir + render the source region to input.wav. For a wave
    // clip with no upstream FX this is the source audio; the general path is
    // te::Renderer::renderToFile (render-to-file preferred, 05 §3 // VERIFY).
    auto jobDir = eng.sessionDir().getChildFile ("renders").getChildFile (node[ids::id].toString());
    jobDir.createDirectory();
    auto input = jobDir.getChildFile ("input.wav");
    auto output = jobDir.getChildFile ("output.wav");
    auto manifest = jobDir.getChildFile ("output_manifest.json");
    input.deleteFile();
    if (! wave->getCurrentSourceFile().copyFileTo (input))
        return errResult ("render_layer", "could not stage source region");

    // Ensure the service first so its build/version is part of EVERY fingerprint
    // (else the first render hashes an empty build and the cache never hits).
    if (! jobManager.ensureServiceRunning())
        return errResult ("render_layer", "generative service unavailable");

    const auto fp = computeFingerprint (node, input);

    // Cache by FULL fingerprint (05 §5) — reuse only on an exact match.
    if (node[ids::cacheKey].toString() == fp
        && juce::File (node[ids::cacheArtifact].toString()).existsAsFile())
    {
        node.setProperty (ids::status, "ready", nullptr);
        emit ("layer_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
            o->setProperty ("status", "ready"); o->setProperty ("cache", "hit"); return var (o); }());
        logLine ("render_layer", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("cache", "hit"); d->setProperty ("status", "ready");
        return okResult ("render_layer", var (d));
    }

    // Build the job params from the node.
    auto params = node.getChildWithName (ids::PARAMS);
    auto* p = new DynamicObject();
    p->setProperty ("prompt", params[ids::prompt]);
    p->setProperty ("seed", node[ids::seed]);
    p->setProperty ("nl", params[ids::nl]);
    p->setProperty ("cfg", params[ids::cfg]);
    p->setProperty ("steps", params[ids::steps]);
    Array<var> colors;
    if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
        for (int i = 0; i < cs.getNumChildren(); ++i)
        {
            auto* co = new DynamicObject();
            co->setProperty ("name", cs.getChild (i)[ids::name]);
            co->setProperty ("value", cs.getChild (i)[ids::value]);
            colors.add (var (co));
        }
    p->setProperty ("colors", colors);
    p->setProperty ("lab", (bool) params.getProperty (juce::Identifier ("lab"), false));

    const auto jobId = jobManager.submitJob (node[ids::modelAdapter].toString(),
                                             input, output, manifest, var (p));
    if (jobId.isEmpty()) return errResult ("render_layer", "job submit failed");

    node.setProperty (ids::cacheKey, fp, nullptr);
    node.setProperty (ids::status, "rendering", nullptr);
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
        o->setProperty ("status", "rendering"); o->setProperty ("cache", "miss");
        o->setProperty ("jobId", jobId); return var (o); }());

    // Poll. Headless harness uses wait:true (inline); the GUI polls async on a
    // background thread so playback never stalls (05 §4) — see below.
    const bool wait = (bool) args.getProperty ("wait", false);
    if (wait)
    {
        const int waitTimeoutMs = juce::jmax (1000, juce::SystemStats::getEnvironmentVariable (
            "MOSH_RENDER_WAIT_TIMEOUT_MS", "120000").getIntValue());
        const int maxPolls = juce::jmax (1, waitTimeoutMs / 50);
        for (int i = 0; i < maxPolls; ++i)   // default ~120s; PC CUDA cold loads can opt into longer waits
        {
            auto st = jobManager.jobStatus (jobId);
            const auto status = st.getProperty ("status", var()).toString();
            emit ("layer_render_progress", [&] { auto* o = new DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("jobId", jobId);
                o->setProperty ("progress", st.getProperty ("progress", 0.0)); return var (o); }());
            if (status == "ready" || status == "error" || status == "cancelled") break;
            juce::Thread::sleep (50);
        }
        finalizeRender (clipId, output, manifest, fp);
        logLine ("render_layer", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("cache", "miss");
        d->setProperty ("status", node[ids::status]); d->setProperty ("jobId", jobId);
        return okResult ("render_layer", var (d));
    }

    // Async: poll on a background thread, marshal node updates + events to the
    // message thread (service I/O off the message thread; tree on it).
    std::thread ([this, clipId, jobId, output, manifest, fp]
    {
        for (int i = 0; i < 1800; ++i)   // up to ~180s for a slow generative render
        {
            auto st = jobManager.jobStatus (jobId);
            const auto status = st.getProperty ("status", juce::var()).toString();
            const auto progress = st.getProperty ("progress", 0.0);
            juce::MessageManager::callAsync ([this, clipId, jobId, progress]
            {
                emit ("layer_render_progress", [&] { auto* o = new juce::DynamicObject();
                    o->setProperty ("clipId", clipId); o->setProperty ("jobId", jobId);
                    o->setProperty ("progress", progress); return juce::var (o); }());
            });
            if (status == "ready" || status == "error" || status == "cancelled") break;
            juce::Thread::sleep (100);
        }
        juce::MessageManager::callAsync ([this, clipId, output, manifest, fp]
        {
            finalizeRender (clipId, output, manifest, fp);
        });
    }).detach();

    logLine ("render_layer", args, true, {}, false);
    auto* d = new DynamicObject(); d->setProperty ("cache", "miss");
    d->setProperty ("status", "rendering"); d->setProperty ("jobId", jobId);
    return okResult ("render_layer", var (d));
}

void MoshOps::finalizeRender (const juce::String& clipId, const juce::File& outputWav,
                              const juce::File& manifestFile, const juce::String& cacheKey)
{
    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;
    if (! outputWav.existsAsFile()) { node.setProperty (ids::status, "error", nullptr); emitSnapshotInvalidated(); return; }

    node.setProperty (ids::cacheArtifact, outputWav.getFullPathName(), nullptr);
    node.setProperty (ids::cacheKey, cacheKey, nullptr);
    node.setProperty (ids::status, "ready", nullptr);

    var qa = manifestFile.existsAsFile() ? JSON::parse (manifestFile.loadFileAsString()) : var();
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
        o->setProperty ("status", "ready"); o->setProperty ("cache", "miss");
        o->setProperty ("qa", qa); return var (o); }());
    emitSnapshotInvalidated();
}

juce::var MoshOps::cmdListColors (const juce::var&)
{
    // The SA3 colour rack (name + ASTD ceiling per color) for the generative UI.
    if (! jobManager.ensureServiceRunning())
        return errResult ("list_colors", "generative service unavailable");
    auto r = jobManager.listColors();
    if (! (bool) r.getProperty ("ok", false))
        return okResult ("list_colors", [] { auto* o = new DynamicObject(); o->setProperty ("colors", Array<var>{}); return var (o); }());
    return okResult ("list_colors", r);
}

juce::var MoshOps::cmdCancelRender (const juce::var& args)
{
    jobManager.cancelJob (args.getProperty ("jobId", var()).toString());
    if (auto node = findRenderLayer (args.getProperty ("clipId", var()).toString()); node.isValid())
        node.setProperty (ids::status, "dirty", nullptr);
    logLine ("cancel_render", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("cancel_render");
}

juce::var MoshOps::cmdAcceptRender (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("accept_render", "no render layer");
    juce::File artifact (node[ids::cacheArtifact].toString());
    if (! artifact.existsAsFile()) return errResult ("accept_render", "nothing rendered to accept");

    // Landing: new clip on a dedicated "neural" lane (the documented guaranteed
    // fallback, 05 §3.1 — ships as a user-selectable mode, not a defeat).
    undoManager().beginNewTransaction ("accept_render");
    auto& edit = eng.edit();
    te::AudioTrack* lane = nullptr;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr && t->getName() == "Neural Renders") lane = t;
    if (lane == nullptr)
    {
        lane = createAudioTrack ("Neural Renders");
    }
    if (lane == nullptr) return errResult ("accept_render", "no lane");

    auto dest = eng.sessionDir().getChildFile ("audio")
                    .getChildFile (node[ids::id].toString()).withFileExtension ("wav");
    dest.deleteFile();
    artifact.copyFileTo (dest);

    auto pos = clip->getPosition();
    lane->insertWaveClip ("neural-" + clip->getName(), dest,
        { { pos.getStart(), pos.getLength() }, {} }, false);

    node.setProperty (ids::userKept, true, &undoManager());
    node.setProperty (ids::status, "ready", &undoManager());

    // JSONL TASTE LABEL (05 §9): accept feeds the taste flywheel.
    auto* tl = new DynamicObject();
    tl->setProperty ("clipId", clipId); tl->setProperty ("layerId", node[ids::id]);
    tl->setProperty ("landing", "new_clip");
    logLine ("accept_render", var (tl), true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("accept_render");
}

juce::var MoshOps::cmdRejectRender (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("reject_render", "no render layer");
    undoManager().beginNewTransaction ("reject_render");
    node.setProperty (ids::userKept, false, &undoManager());
    node.setProperty (ids::status, "dirty", &undoManager());
    logLine ("reject_render", args, true, {}, true);   // TASTE LABEL (reject)
    emitSnapshotInvalidated();
    return okResult ("reject_render");
}

juce::var MoshOps::cmdBypassLayer (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("bypass_layer", "no render layer");
    undoManager().beginNewTransaction ("bypass_layer");
    node.setProperty (ids::status, (bool) args.getProperty ("bypassed", false) ? "bypassed" : "ready", &undoManager());
    logLine ("bypass_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bypass_layer");
}

juce::var MoshOps::cmdFreezeLayer (const juce::var& args)
{
    // Freeze = commit the cached render as the durable audio (already a file).
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("freeze_layer", "no render layer");
    if (! juce::File (node[ids::cacheArtifact].toString()).existsAsFile())
        return errResult ("freeze_layer", "nothing rendered to freeze");
    undoManager().beginNewTransaction ("freeze_layer");
    node.setProperty (ids::status, "frozen", &undoManager());
    logLine ("freeze_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("freeze_layer");
}

juce::var MoshOps::cmdBounceLayerToClip (const juce::var& args)
{
    // Bounce = accept_render then mark the layer bounced (the render becomes a
    // plain clip on the neural lane; lineage stays in the RenderLayer link).
    auto r = cmdAcceptRender (args);
    if (! (bool) r.getProperty ("ok", false)) return r;
    if (auto node = findRenderLayer (args.getProperty ("clipId", var()).toString()); node.isValid())
        node.setProperty (ids::status, "bounced", nullptr);
    logLine ("bounce_layer_to_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bounce_layer_to_clip");
}

juce::var MoshOps::cmdRemoveRenderLayer (const juce::var& args)
{
    // Clear the MOSH_RENDERLAYER node off the clip (the genuine "remove" — reject_render
    // only marks the take dirty, it does NOT remove the layer). After this the clip has
    // no layer and create_render_layer succeeds again. Undoable (mirrors remove_plugin);
    // any accepted/bounced clip already landed on the neural lane is left untouched.
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("remove_render_layer", "no clip: " + clipId);
    auto node = clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
    if (! node.isValid()) return errResult ("remove_render_layer", "clip has no render layer");

    undoManager().beginNewTransaction ("remove_render_layer");
    clip->state.removeChild (node, &undoManager());
    logLine ("remove_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_render_layer");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6 — export (the full producer loop ends here)
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdExportAudio (const juce::var& args)
{
    auto& edit = eng.edit();

    // ── Format / extension resolution ────────────────────────────────────────
    // The UI speaks generic media-format names ("wav"/"aiff"/"flac"), never engine
    // type names. Resolve them through the Engine's AudioFileFormatManager (the
    // robust path: per-format getters + getFormatFromFileName), and FALL BACK to
    // the default WAV format on anything unknown. An explicitly-requested-but-
    // unsupported format is a hard error (caught before any render).
    auto& afm = edit.engine.getAudioFileFormatManager();

    const auto requestedFormat = args.getProperty ("format", var()).toString().trim().toLowerCase();

    // Map a format keyword -> (juce::AudioFormat*, canonical extension). Empty
    // keyword means "infer from the destination file extension" below.
    struct FormatChoice { juce::AudioFormat* format = nullptr; juce::String extension; };
    auto formatForKeyword = [&afm] (const juce::String& kw) -> FormatChoice
    {
        if (kw == "wav")  return { afm.getWavFormat(),  ".wav" };
        if (kw == "aiff" || kw == "aif") return { afm.getAiffFormat(), ".aiff" };
        if (kw == "flac") return { afm.getFlacFormat(), ".flac" };
        return {};
    };

    if (requestedFormat.isNotEmpty() && formatForKeyword (requestedFormat).format == nullptr)
        return errResult ("export_audio", "unsupported format: " + requestedFormat
                          + " (supported: wav, aiff, flac)");

    auto file = args.getProperty ("file", var()).toString().isNotEmpty()
                    ? juce::File (args.getProperty ("file", var()).toString())
                    : eng.sessionDir().getChildFile ("exports")
                          .getChildFile ("mix-" + String (Time::getCurrentTime().toMilliseconds()))
                          .withFileExtension ("wav");

    // Choose the format: explicit keyword wins; otherwise infer from the file
    // extension; otherwise the default WAV. Then force the destination extension
    // to match the chosen format so the bytes and the name agree.
    juce::AudioFormat* audioFormat = nullptr;
    juce::String formatName = "wav";
    if (requestedFormat.isNotEmpty())
    {
        auto choice = formatForKeyword (requestedFormat);
        audioFormat = choice.format;
        formatName = requestedFormat == "aif" ? "aiff" : requestedFormat;
        file = file.withFileExtension (choice.extension);
    }
    else
    {
        const auto ext = file.getFileExtension().toLowerCase();
        if (ext == ".wav")       { audioFormat = afm.getWavFormat();  formatName = "wav"; }
        else if (ext == ".aiff" || ext == ".aif") { audioFormat = afm.getAiffFormat(); formatName = "aiff"; file = file.withFileExtension (".aiff"); }
        else if (ext == ".flac") { audioFormat = afm.getFlacFormat(); formatName = "flac"; }
        else if (ext == ".mid")  { audioFormat = afm.getDefaultFormat(); formatName = "mid"; }
        else { audioFormat = afm.getDefaultFormat(); formatName = "wav"; file = file.withFileExtension (".wav"); }
    }
    if (audioFormat == nullptr)   // belt-and-braces: never render with a null format
        audioFormat = afm.getDefaultFormat();

    file.getParentDirectory().createDirectory();
    file.deleteFile();

    // ── Bit depth ────────────────────────────────────────────────────────────
    // Validate the requested depth against what this format can actually write
    // (getPossibleBitDepths). Reject an unsupported depth rather than silently
    // writing the wrong one. Absent -> 24 (or the format's nearest supported).
    // PRJ-008 — when the export omits bitDepth, default it from the stored per-project
    // setting (NON-mutating read; an invalid/absent tree's hasProperty() is false ->
    // the 24-bit / device-rate defaults below).
    auto projectSettings = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    int bitDepth = projectSettings.hasProperty (ids::projectBitDepth)
                       ? (int) projectSettings.getProperty (ids::projectBitDepth)
                       : 24;
    {
        auto depths = audioFormat->getPossibleBitDepths();   // local copy of the Array<int>
        const bool depthRequested = args.hasProperty ("bitDepth");
        if (depthRequested)
        {
            bitDepth = (int) args.getProperty ("bitDepth", 24);
            if (! depths.contains (bitDepth))
            {
                juce::StringArray supported;
                for (auto d : depths) supported.add (String (d));
                return errResult ("export_audio", "format " + formatName + " does not support bit depth "
                                  + String (bitDepth) + " (supported: " + supported.joinIntoString (", ") + ")");
            }
        }
        else if (! depths.isEmpty() && ! depths.contains (bitDepth))
        {
            // Nearest supported to the 24-bit default.
            int best = depths[0];
            for (auto d : depths) if (std::abs (d - 24) < std::abs (best - 24)) best = d;
            bitDepth = best;
        }
    }

    const auto requestedMode = args.getProperty ("renderMode", "auto").toString().toLowerCase();
    if (requestedMode != "auto" && requestedMode != "fast" && requestedMode != "realtime")
        return errResult ("export_audio", "renderMode must be 'auto', 'fast', or 'realtime'");

    String renderMode = requestedMode;
    String renderModeReason;
    if (requestedMode == "auto")
    {
        renderModeReason = findSerumRealtimeRenderReason (edit);
        renderMode = renderModeReason.isNotEmpty() ? "realtime" : "fast";
        if (renderModeReason.isEmpty())
            renderModeReason = "no realtime-only hosted plugin detected";
    }
    else if (requestedMode == "realtime")
    {
        renderModeReason = "requested realtime render";
    }
    else
    {
        renderModeReason = "requested fast render";
    }

    // Render exclusivity (01 §5): detach the Edit from the device before an
    // offline/realtime export render (asserts otherwise). No-op when no device
    // is attached. Tear down our level-meter taps first (the master tap lives on
    // the playback context we are about to free) and clear lastSeenContext so the
    // master meter re-attaches to the *next* context rather than an ABA-reused
    // address — same swap guard cmdNewProject/cmdOpenProject use.
    unregisterAllMeterClients();           // master tap follows the context being freed
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the next ctx

    const double len = juce::jmax (0.1, edit.getLength().inSeconds());

    // Sample rate: honor a valid explicit request (>= 7000), else the stored
    // per-project setting (PRJ-008), else the device rate with the 44100 fallback.
    double sampleRate = edit.engine.getDeviceManager().getSampleRate();
    if (sampleRate < 7000.0)
        sampleRate = 44100.0;
    if (! args.hasProperty ("sampleRate") && projectSettings.hasProperty (ids::projectSampleRate))
    {
        const double projSr = (double) projectSettings.getProperty (ids::projectSampleRate);
        if (projSr >= 7000.0)
            sampleRate = projSr;
    }
    if (args.hasProperty ("sampleRate"))
    {
        const double reqSr = (double) args.getProperty ("sampleRate", sampleRate);
        if (reqSr >= 7000.0)
            sampleRate = reqSr;
    }

    te::Renderer::Parameters params (edit);
    params.destFile = file;
    params.audioFormat = audioFormat;
    params.bitDepth = bitDepth;
    params.sampleRateForAudio = sampleRate;
    params.blockSizeForAudio = edit.engine.getDeviceManager().getBlockSize();
    if (params.blockSizeForAudio <= 0)
        params.blockSizeForAudio = 512;
    params.time = { tracktion::TimePosition(), edit.getLength() };
    params.tracksToDo = te::toBitSet (te::getAllTracks (edit));
    params.usePlugins = true;
    params.useMasterPlugins = true;
    params.createMidiFile = file.hasFileExtension (".mid");
    params.realTimeRender = renderMode == "realtime";

    String renderError;
    {
        const te::Edit::ScopedRenderStatus srs (edit, true);
        te::TransportControl::stopAllTransports (edit.engine, false, true);
        te::Renderer::turnOffAllPlugins (edit);

        if (params.tracksToDo.countNumberOfSetBits() > 0
            && params.destFile.hasWriteAccess()
            && ! params.destFile.isDirectory())
        {
            te::Renderer::RenderTask task ("Mosh export", params, nullptr, nullptr);
            while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
            {}

            te::Renderer::turnOffAllPlugins (edit);

            if (task.errorMessage.isNotEmpty())
            {
                renderError = task.errorMessage;
                file.deleteFile();
            }
        }
        else
        {
            renderError = "render target is not writable or no tracks are renderable";
        }
    }

    const bool ok = renderError.isEmpty() && file.existsAsFile() && file.getSize() > 0;

    logLine ("export_audio", args, ok, ok ? String() : (renderError.isNotEmpty() ? renderError : String ("render produced no file")), false);
    if (! ok) return errResult ("export_audio", renderError.isNotEmpty() ? renderError : String ("export render failed"));

    auto* data = new DynamicObject();
    data->setProperty ("file", file.getFullPathName());
    data->setProperty ("format", formatName);
    if (formatName != "mid")   // bit depth / sample rate are meaningless for a MIDI export
    {
        data->setProperty ("bitDepth", bitDepth);
        data->setProperty ("sampleRate", sampleRate);
    }
    data->setProperty ("bytes", (juce::int64) file.getSize());
    data->setProperty ("seconds", len);
    data->setProperty ("renderModeRequested", requestedMode);
    data->setProperty ("renderMode", renderMode);
    data->setProperty ("renderModeReason", renderModeReason);
    data->setProperty ("realTimeRender", params.realTimeRender);
    return okResult ("export_audio", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave: settings — audio device picker + project lifecycle
//
// Device + project commands are NON-undoable by design (no beginNewTransaction):
// a device change is a machine preference (like set_metronome) and new/open/save-as
// replace or persist the whole Edit — there is nothing to put on the Edit's own
// undo stack, and pushing an empty transaction would silently undo an unrelated
// prior edit. All log undoable:false. list_audio_devices is read-only (no log).
// ─────────────────────────────────────────────────────────────────────────────

juce::var MoshOps::currentAudioSelection()
{
    // Lightweight current-selection summary for the snapshot's audio{} block + the
    // set_audio_device result. NO full device lists here (those stay behind the
    // on-demand list_audio_devices so the snapshot stays small).
    auto& dm = adm();
    auto setup = dm.getAudioDeviceSetup();
    auto* o = new DynamicObject();
    o->setProperty ("type", dm.getCurrentAudioDeviceType());
    o->setProperty ("outputDevice", setup.outputDeviceName);
    o->setProperty ("inputDevice", setup.inputDeviceName);
    o->setProperty ("sampleRate", setup.sampleRate);
    o->setProperty ("bufferSize", setup.bufferSize);
    return var (o);
}

juce::var MoshOps::cmdListAudioDevices (const juce::var&)
{
    // Read-only enumeration — no transaction, no log line. Headless (no audio) the
    // engine never adds system device types (MoshEngine addSystemAudioIODeviceTypes
    // returns false), so `types` is a well-formed empty array and audioEnabled:false.
    auto& dm = adm();

    Array<var> types;
    for (auto* type : dm.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        type->scanForDevices();                          // required before getDeviceNames

        Array<var> outputs, inputs;
        for (auto& n : type->getDeviceNames (false)) outputs.add (n);
        for (auto& n : type->getDeviceNames (true))  inputs.add (n);

        auto* to = new DynamicObject();
        to->setProperty ("name", type->getTypeName());
        to->setProperty ("outputs", outputs);
        to->setProperty ("inputs", inputs);
        types.add (var (to));
    }

    // Valid sample-rate / buffer-size lists are only meaningful when a device is
    // open (null headless → empty arrays).
    Array<var> sampleRates, bufferSizes;
    int defaultBufferSize = 0;
    if (auto* dev = dm.getCurrentAudioDevice())
    {
        for (auto sr : dev->getAvailableSampleRates()) sampleRates.add (sr);
        for (auto bs : dev->getAvailableBufferSizes()) bufferSizes.add (bs);
        defaultBufferSize = dev->getDefaultBufferSize();
    }

    auto* data = new DynamicObject();
    data->setProperty ("types", types);
    data->setProperty ("current", currentAudioSelection());
    data->setProperty ("sampleRates", sampleRates);
    data->setProperty ("bufferSizes", bufferSizes);
    data->setProperty ("defaultBufferSize", defaultBufferSize);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_audio_devices", var (data));
}

juce::var MoshOps::cmdListMidiInputs (const juce::var&)
{
    // Read-only MIDI-input enumeration (CTL-001) — modelled on cmdListAudioDevices:
    // no transaction, no log line, no event. Headless (no audio device) the engine's
    // MIDI device list is empty (devices are only enumerated once CoreAudio/MIDI is
    // up), so `inputs` is a well-formed empty array. The live note flow (controller ->
    // armed instrument track -> audible synth) is hardware-gated and verified live.
    auto& dm = eng.engine().getDeviceManager();

    Array<var> inputs;
    for (auto& mi : dm.getMidiInDevices())
    {
        if (mi == nullptr) continue;

        auto* o = new DynamicObject();
        o->setProperty ("name", mi->getName());
        o->setProperty ("alias", mi->getAlias());
        o->setProperty ("deviceID", mi->getDeviceID());
        o->setProperty ("enabled", mi->isEnabled());
        switch (mi->getMonitorMode())
        {
            case te::InputDevice::MonitorMode::off:       o->setProperty ("monitor", "off"); break;
            case te::InputDevice::MonitorMode::on:        o->setProperty ("monitor", "on"); break;
            case te::InputDevice::MonitorMode::automatic: o->setProperty ("monitor", "automatic"); break;
            default:                                      o->setProperty ("monitor", "automatic"); break;
        }
        inputs.add (var (o));
    }

    auto* data = new DynamicObject();
    data->setProperty ("inputs", inputs);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_midi_inputs", var (data));
}

juce::var MoshOps::cmdListDirectory (const juce::var& args)
{
    // BRW-001 — content/file browser enumerator. STRICTLY READ-ONLY: no transaction,
    // no log line, no event. Like cmdListAudioDevices / cmdGetCommandLog it returns
    // okResult(...) directly — listing the filesystem must never pollute the undo
    // stack or mosh-log.jsonl. There is no new mutation path: the UI imports a chosen
    // file via the existing import_clip command (which re-validates at import time).
    //
    // Never recurses (one level per call). Never writes / deletes / mkdir. Graceful on
    // a missing / not-a-directory / permission-denied path: returns ok:true with
    // exists:false + an error string + the well-known roots so the UI can recover.
    // errResult is reserved for a genuinely malformed request.
    using TFTF = File::TypesOfFileToFind;
    static const StringArray audioExts { ".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg" };

    // Well-known roots — ALWAYS returned regardless of path validity, so the browser
    // always has sane recovery targets. Skip-if-absent keeps this strictly read-only
    // (we never create the imports dir just to advertise it).
    Array<var> roots;
    auto addRoot = [&] (const String& name, const File& dir)
    {
        if (dir.isDirectory())
        {
            auto* o = new DynamicObject();
            o->setProperty ("name", name);
            o->setProperty ("path", dir.getFullPathName());
            roots.add (var (o));
        }
    };
    addRoot ("Home",     File::getSpecialLocation (File::userHomeDirectory));
    addRoot ("Music",    File::getSpecialLocation (File::userMusicDirectory));
    addRoot ("Desktop",  File::getSpecialLocation (File::userDesktopDirectory));
    addRoot ("Documents",File::getSpecialLocation (File::userDocumentsDirectory));
    addRoot ("Imports",  eng.sessionDir().getChildFile ("imports"));

    auto makeResult = [&] (const File& dir, bool exists, const String& error,
                           const Array<var>& entries, const File* parentForUp) -> juce::var
    {
        auto* data = new DynamicObject();
        data->setProperty ("path", dir.getFullPathName());
        // parent drives the Up button; null at the filesystem root.
        if (parentForUp != nullptr && *parentForUp != dir && parentForUp->isDirectory())
            data->setProperty ("parent", parentForUp->getFullPathName());
        else
            data->setProperty ("parent", var());   // null
        data->setProperty ("exists", exists);
        data->setProperty ("error", error.isNotEmpty() ? var (error) : var());
        data->setProperty ("roots", roots);
        data->setProperty ("entries", entries);
        return okResult ("list_directory", var (data));
    };

    const auto req = args.getProperty ("path", var()).toString();

    // Resolve the target. Empty -> default to Home. NEVER resolve a relative path
    // against the (unstable) process cwd, and NEVER construct File() with a non-absolute
    // path (that trips a JUCE assertion) — guard with isAbsolutePath first.
    File dir;
    if (req.isEmpty())
    {
        dir = File::getSpecialLocation (File::userHomeDirectory);
    }
    else if (! File::isAbsolutePath (req))
    {
        // Malformed/relative request: return the home dir's parent? No — just report
        // invalid with roots so the UI recovers, without ever building a relative File.
        auto* data = new DynamicObject();
        data->setProperty ("path", req);
        data->setProperty ("parent", var());
        data->setProperty ("exists", false);
        data->setProperty ("error", "invalid path (must be absolute)");
        data->setProperty ("roots", roots);
        data->setProperty ("entries", Array<var>());
        return okResult ("list_directory", var (data));
    }
    else
    {
        dir = File (req);
    }

    File parent = dir.getParentDirectory();

    if (! dir.isDirectory())
        return makeResult (dir, false, "not a directory or not found", Array<var>(), &parent);
    if (! dir.hasReadAccess())
        return makeResult (dir, false, "permission denied", Array<var>(), &parent);

    // Gather sub-directories then audio files, each sorted case-insensitively, dirs
    // first. ignoreHiddenFiles keeps dotfiles / .DS_Store out. searchRecursively=false.
    Array<File> dirs  = dir.findChildFiles (TFTF::findDirectories | TFTF::ignoreHiddenFiles, false, "*");
    Array<File> files = dir.findChildFiles (TFTF::findFiles       | TFTF::ignoreHiddenFiles, false, "*");

    struct ByName { int compareElements (const File& a, const File& b) const {
        return a.getFileName().compareIgnoreCase (b.getFileName()); } } byName;
    dirs.sort (byName);
    files.sort (byName);

    Array<var> entries;
    auto addEntry = [&] (const File& f, bool isDir)
    {
        auto* o = new DynamicObject();
        o->setProperty ("name", f.getFileName());
        o->setProperty ("path", f.getFullPathName());
        o->setProperty ("isDir", isDir);
        // File::getSize() is int64; juce::var has no int64 ctor — store as double to
        // avoid overflow on large files (formatted in the UI).
        o->setProperty ("size", isDir ? var() : var ((double) f.getSize()));
        entries.add (var (o));
    };

    for (auto& d : dirs)  addEntry (d, true);
    for (auto& f : files)
        if (audioExts.contains (f.getFileExtension().toLowerCase()))
            addEntry (f, false);

    return makeResult (dir, true, {}, entries, &parent);
}

juce::var MoshOps::cmdGetCommandLog (const juce::var& args)
{
    // READ-ONLY inspector over the canonical command log (mosh-log.jsonl). This is
    // the one command that must NOT log/transact/emit — doing so would pollute the
    // very file it returns (and make get_command_log appear in its own results).
    // Modelled on cmdListAudioDevices / cmdListPlugins: returns okResult directly.
    int limit = (int) args.getProperty ("limit", 50);
    if (limit <= 0) limit = 50;
    if (limit > 500) limit = 500;                    // clamp to a sane max

    const auto file = eng.sessionDir().getChildFile ("mosh-log.jsonl");

    Array<var> entries;
    int total = 0;

    if (file.existsAsFile())
    {
        const auto text = file.loadFileAsString();
        auto lines = StringArray::fromLines (text);

        for (auto& line : lines)
        {
            if (line.trim().isEmpty()) continue;     // skip blank lines

            var parsed;
            // A partially-written tail line must not crash the inspector — JSON::parse
            // returns a non-ok Result on malformed input; skip such lines.
            if (JSON::parse (line, parsed).failed()) continue;
            if (! parsed.isObject()) continue;

            ++total;

            auto* o = new DynamicObject();
            o->setProperty ("ts",       parsed.getProperty ("ts", var()));
            o->setProperty ("seq",      parsed.getProperty ("seq", var()));
            o->setProperty ("command",  parsed.getProperty ("command", var()));
            o->setProperty ("ok",       (bool) parsed.getProperty ("ok", false));
            o->setProperty ("undoable", (bool) parsed.getProperty ("undoable", false));
            if (parsed.hasProperty ("error"))
                o->setProperty ("error", parsed.getProperty ("error", var()));
            entries.add (var (o));
        }
    }

    // Most-recent-first, limited to the last `limit` entries.
    Array<var> recent;
    for (int i = entries.size() - 1; i >= 0 && recent.size() < limit; --i)
        recent.add (entries.getReference (i));

    auto* data = new DynamicObject();
    data->setProperty ("entries", recent);
    data->setProperty ("total", total);
    return okResult ("get_command_log", var (data));
}

// Applies a device-setup patch (type/output/input/sampleRate/bufferSize) to the
// AudioDeviceManager. Returns the error string (empty == success). NO logging / no
// snapshot emit — the callers (set_audio_device / set_buffer_size) log exactly once
// under their own command name so the JSONL has one line per user action.
juce::String MoshOps::applyAudioDeviceSetup (const juce::var& args)
{
    auto& dm = adm();

    // Device type switch (optional).
    const auto type = args.getProperty ("type", var()).toString();
    if (type.isNotEmpty() && type != dm.getCurrentAudioDeviceType())
        dm.setCurrentAudioDeviceType (type, true);

    auto setup = dm.getAudioDeviceSetup();
    if (args.hasProperty ("outputDevice"))
        setup.outputDeviceName = args.getProperty ("outputDevice", var()).toString();
    if (args.hasProperty ("inputDevice"))
    {
        setup.inputDeviceName = args.getProperty ("inputDevice", var()).toString();
        // Match the existing working rule (MoshEngine applyRequestedAudioOutputDevice):
        // only request default input channels when an input device is selected.
        setup.inputChannels.clear();
        setup.useDefaultInputChannels = setup.inputDeviceName.isNotEmpty();
    }
    if (args.hasProperty ("sampleRate"))
        setup.sampleRate = (double) args.getProperty ("sampleRate", 0.0);
    if (args.hasProperty ("bufferSize"))
        setup.bufferSize = (int) args.getProperty ("bufferSize", 0);
    setup.useDefaultOutputChannels = true;

    // setAudioDeviceSetup returns an ERROR STRING (empty == success) — do not invert.
    const auto err = dm.setAudioDeviceSetup (setup, true);
    if (err.isNotEmpty())
        return err;

    // Rebuild Tracktion's wave-device wrappers + flush the async device update
    // before the next snapshot (mirrors MoshEngine.cpp applyRequestedAudioOutputDevice).
    eng.engine().getDeviceManager().rescanWaveDeviceList();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (50);

    // PRE-001 — persist the chosen device setup to the session dir so it is restored
    // on the next launch (MoshEngine reads it before the MOSH_AUDIO_OUTPUT_DEVICE env
    // fallback). A machine/whole-app preference, written without the undo manager.
    if (auto stateXml = std::unique_ptr<juce::XmlElement> (adm().createStateXml()))
        stateXml->writeTo (eng.sessionDir().getChildFile ("audio-device.xml"));

    return {};
}

juce::var MoshOps::cmdSetAudioDevice (const juce::var& args)
{
    // Graceful degradation: headless / no-audio session has no device to drive.
    // Log the failed attempt (undoable:false) so the JSONL trail records it, then
    // return a real, honest error (NOT a crash).
    if (! eng.hasAudio())
    {
        logLine ("set_audio_device", args, false, "no audio device in this session", false);
        return errResult ("set_audio_device", "no audio device in this session");
    }

    const auto err = applyAudioDeviceSetup (args);
    if (err.isNotEmpty())
    {
        logLine ("set_audio_device", args, false, err, false);
        return errResult ("set_audio_device", err);
    }

    logLine ("set_audio_device", args, true, {}, false);   // machine preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_audio_device", currentAudioSelection());
}

juce::var MoshOps::cmdSetBufferSize (const juce::var& args)
{
    // Thin convenience wrapper = a bufferSize-only device-setup. Maps 1:1 to a UI
    // control; shares the no-device guard + non-undoable logging. Logs exactly ONE
    // JSONL line under set_buffer_size (it applies the setup directly, not via
    // cmdSetAudioDevice, so there is no phantom set_audio_device line).
    if (! args.hasProperty ("bufferSize"))
        return errResult ("set_buffer_size", "missing 'bufferSize'");
    if (! eng.hasAudio())
    {
        logLine ("set_buffer_size", args, false, "no audio device in this session", false);
        return errResult ("set_buffer_size", "no audio device in this session");
    }

    auto* patch = new DynamicObject();
    patch->setProperty ("bufferSize", args.getProperty ("bufferSize", var()));
    const auto err = applyAudioDeviceSetup (var (patch));
    if (err.isNotEmpty())
    {
        logLine ("set_buffer_size", args, false, err, false);
        return errResult ("set_buffer_size", err);
    }

    logLine ("set_buffer_size", args, true, {}, false);   // machine preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_buffer_size", currentAudioSelection());
}

juce::var MoshOps::cmdSetAudioThreads (const juce::var& args)
{
    // PRF-001 — multicore audio processing preference. This is a GENUINE knob, not a
    // dead toggle: it drives MoshEngineBehaviour::getNumberOfCPUsToUseForAudio(), which
    // Tracktion applies as setNumThreads(N-1) on the parallel playback/render graph.
    // UI value 1 => 0 worker threads => single-threaded; higher => more parallelism.
    //
    // Unlike set_buffer_size / set_audio_device this is NOT gated on an open audio
    // device: the preference + readout are valid headless (only the live re-apply,
    // handled inside setAudioThreadPref, is conditional on a running context). That
    // keeps it testable in --selftest (which runs MOSH_NO_AUDIO).
    if (! args.hasProperty ("threads"))
        return errResult ("set_audio_threads", "missing 'threads'");

    const int cores = eng.availableCores();
    const int requested = (int) args.getProperty ("threads", var());

    // Reject clearly-invalid input (<=0 or absurdly large) rather than silently
    // coercing it into the valid range — keeps the readout honest and the UI safe.
    if (requested < 1 || requested > 4096)
        return errResult ("set_audio_threads",
                          "threads out of range (expected 1.." + String (cores) + ")");

    const int clamped = juce::jlimit (1, cores, requested);   // clamp to the real core count
    eng.setAudioThreadPref (clamped);                         // store + LIVE re-apply (if a device is open)

    logLine ("set_audio_threads", args, true, {}, false);     // machine preference — NOT undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("availableCores", cores);
    data->setProperty ("audioThreads", eng.effectiveAudioThreads());
    return okResult ("set_audio_threads", var (data));
}

juce::var MoshOps::cmdNewProject (const juce::var& args)
{
    unregisterAllMeterClients();           // old measurers valid here; dead after the swap
    auto name = args.getProperty ("name", var()).toString().trim();
    if (name.isEmpty())
        name = "untitled-" + String (Time::getCurrentTime().toMilliseconds());

    auto file = eng.sessionDir().getChildFile ("projects")
                    .getChildFile (File::createLegalFileName (name))
                    .withFileExtension ("tracktionedit");

    eng.newProject (file);                 // stops transport + frees ctx before swap, re-points retriever
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the new ctx
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    logLine ("new_project", args, true, {}, false);   // replaces the Edit — not undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("editFile", eng.editFile().getFullPathName());
    return okResult ("new_project", var (data));
}

juce::var MoshOps::cmdOpenProject (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("open_project", "missing 'file'");

    File file (path);
    if (! file.existsAsFile()) return errResult ("open_project", "file not found: " + path);

    unregisterAllMeterClients();           // old measurers valid here; dead after the swap
    eng.openProject (file);                // stops transport + frees ctx before swap, re-points retriever
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the new ctx
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    logLine ("open_project", args, true, {}, false);  // replaces the Edit — not undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("editFile", eng.editFile().getFullPathName());
    return okResult ("open_project", var (data));
}

juce::var MoshOps::cmdSaveAs (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("save_as", "missing 'file'");

    File file (path);
    if (file.getFileExtension().isEmpty())
        file = file.withFileExtension ("tracktionedit");

    const bool didSave = eng.saveProjectAs (file);   // saveAs + adopt the new backing file
    logLine ("save_as", args, didSave, didSave ? String() : String ("saveAs failed"), false);
    if (! didSave) return errResult ("save_as", "saveAs failed");
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("file", eng.editFile().getFullPathName());
    return okResult ("save_as", var (data));
}

te::AudioTrack* MoshOps::createAudioTrack (const juce::String& name)
{
    auto& edit = eng.edit();
    auto track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr, false);
    if (track == nullptr)
        return nullptr;

    if (name.isNotEmpty())
        track->setName (name);

    // Tracktion queues a track-order AsyncUpdater after insertion. In headless
    // command runs there is no normal GUI dispatch between commands, so drain it
    // here before the next undo transaction is opened.
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    return track.get();
}

te::VolumeAndPanPlugin* MoshOps::ensureVolumePlugin (te::AudioTrack& track)
{
    if (auto* existing = track.getVolumePlugin())
        return existing;

    if (auto plugin = eng.edit().getPluginCache().createNewPlugin (te::VolumeAndPanPlugin::xmlTypeName, {}))
    {
        track.pluginList.insertPlugin (plugin, -1, nullptr);
        return dynamic_cast<te::VolumeAndPanPlugin*> (plugin.get());
    }

    return nullptr;
}

juce::var MoshOps::pluginToVar (te::Plugin& p, int index)
{
    auto* o = new DynamicObject();
    o->setProperty ("index", index);
    o->setProperty ("name", p.getName());
    o->setProperty ("type", p.getPluginType());
    o->setProperty ("enabled", p.isEnabled());
    auto* ext = dynamic_cast<te::ExternalPlugin*> (&p);
    const auto* bspec = findBuiltin (p.getPluginType());
    o->setProperty ("external", ext != nullptr);
    o->setProperty ("builtin", bspec != nullptr);
    o->setProperty ("isInstrument", (ext != nullptr && ext->isSynth())
                                        || (bspec != nullptr && bspec->isInstrument));
    if (bspec != nullptr)
        o->setProperty ("category", bspec->category);
    if (ext != nullptr)
        addExternalPluginMetadata (*o, *ext);
    if (auto* n = asNeural (&p))
    {
        o->setProperty ("neural", n->describe());
        o->setProperty ("labMode", n->isLabMode());
    }

    juce::Array<var> params;
    const int n = juce::jmin (16, p.getNumAutomatableParameters());
    for (int i = 0; i < n; ++i)
    {
        auto param = p.getAutomatableParameter (i);
        auto* po = new DynamicObject();
        po->setProperty ("index", i);
        po->setProperty ("name", param->getParameterName());
        po->setProperty ("value", param->getCurrentNormalisedValue());
        const bool automated = param->hasAutomationPoints();
        po->setProperty ("automated", automated);
        if (automated)
        {
            auto& curve = param->getCurve();
            juce::Array<var> pts;
            for (int j = 0; j < curve.getNumPoints(); ++j)
            {
                auto* pt = new DynamicObject();
                pt->setProperty ("t", curve.getPointTime (j).inSeconds());
                pt->setProperty ("v", param->valueRange.convertTo0to1 (curve.getPointValue (j)));
                pts.add (var (pt));
            }
            po->setProperty ("points", pts);
        }
        params.add (var (po));
    }
    o->setProperty ("params", params);
    return var (o);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::snapshot()
{
    auto& edit = eng.edit();

    auto* session = new DynamicObject();
    session->setProperty ("sampleRate", eng.engine().getDeviceManager().getSampleRate());
    session->setProperty ("tempo", edit.tempoSequence.getBpmAt (tracktion::TimePosition()));
    if (auto* ts = edit.tempoSequence.getTimeSig (0))
    {
        session->setProperty ("timeSigNumerator", ts->numerator.get());
        session->setProperty ("timeSigDenominator", ts->denominator.get());
    }
    session->setProperty ("metronome", edit.clickTrackEnabled.get());
    session->setProperty ("length", edit.getLength().inSeconds());
    session->setProperty ("editFile", eng.editFile().getFullPathName());
    // Project container extension, backend-owned (keeps the storage format out of the
    // UI — the file-dialog filter is built from this, not a hard-coded constant).
    session->setProperty ("projectExtension", eng.editFile().getFileExtension().substring (1));

    // Audio-engine gate + readout (wave: settings — MON-007 / FLY-004). audioEnabled
    // is the gate field the UI reads to disable play/record/export + show the
    // "No audio device" banner. The rest is a small read-only readout; full device
    // lists stay behind on-demand list_audio_devices (keeps this refetched-often
    // snapshot small).
    auto& dm = eng.engine().getDeviceManager();
    session->setProperty ("audioEnabled", eng.hasAudio());
    session->setProperty ("bitDepth", dm.getBitDepth());
    session->setProperty ("bufferSize", dm.getBlockSize());
    session->setProperty ("outputLatencyMs", dm.getOutputLatencySeconds() * 1000.0);

    // PRF-001 — multicore audio readout + preference. availableCores is the logical
    // core count the engine sees; audioThreads is the RESOLVED value it actually uses
    // (== availableCores when 'auto'); audioThreadsAuto lets the UI show "Auto (N)".
    // This is a real, load-bearing preference (drives setNumThreads on the parallel
    // graph), valid headless — not a cosmetic readout. Single-thread is threads=1
    // (no separate on/off flag exists in the engine).
    session->setProperty ("availableCores", eng.availableCores());
    session->setProperty ("audioThreads", eng.effectiveAudioThreads());
    session->setProperty ("audioThreadsAuto", eng.audioThreadPref() <= 0);

    // Monitoring round-trip latency (MON-003). The performer-felt input-monitoring
    // delay is the hardware input + output latency (getRecordAdjustment*), distinct
    // from outputLatencyMs (output only) and totalLatencyMs (whole-graph PDC). Unlike
    // getLatencySamples() this needs only an OPEN device, not a prepared playback
    // graph — so it is valid the moment an interface is present. Read-only state, not
    // a command. Headless / no device -> 0 (surface as "-" in the UI, mirroring how
    // outputLatencyMs is handled). Monitoring is SOFTWARE-ONLY in the pinned engine
    // (no direct/hardware/zero-latency mode); the buffer size is the user's lever.
    // getRecordAdjustment* are non-const, and `dm` here is a non-const reference.
    session->setProperty ("roundTripLatencySamples", dm.getRecordAdjustmentSamples());
    session->setProperty ("roundTripLatencyMs", dm.getRecordAdjustmentMs());

    // Plugin delay compensation readout (MON-004). This is the WHOLE-GRAPH reported
    // latency Tracktion itself compensates — the single authoritative total from the
    // prepared playback graph (te::EditPlaybackContext::getLatencySamples()), which
    // already folds in the neural insert + every hosted plugin (max across parallel
    // paths, sum along chains). It is read-only state, not a command. The context is
    // null until ensureContextAllocated() runs (only with an audio device); headless /
    // no-audio reports 0 + latencyContextReady=false so the UI labels "PDC —" rather
    // than a false "0.0 ms". Distinct from outputLatencyMs (device I/O latency above).
    int totalLatencySamples = 0;
    bool latencyContextReady = false;
    if (auto* ctx = edit.getTransport().getCurrentPlaybackContext())
    {
        totalLatencySamples = ctx->getLatencySamples();
        latencyContextReady = true;
    }
    const double latencySR = dm.getSampleRate() > 0.0 ? dm.getSampleRate() : 44100.0;
    session->setProperty ("totalLatencySamples", totalLatencySamples);
    session->setProperty ("totalLatencyMs", (double) totalLatencySamples / latencySR * 1000.0);
    session->setProperty ("latencyContextReady", latencyContextReady);

    session->setProperty ("audioDeviceName",
        dm.deviceManager.getCurrentAudioDevice() != nullptr
            ? dm.deviceManager.getCurrentAudioDevice()->getName() : String());
    session->setProperty ("audioDeviceError", eng.audioDeviceError());

    // PRJ-008 — per-project format / time-base INTENT (the export/format default +
    // timeline display base). Read from the MOSH_PROJECT child of the Edit tree,
    // falling back to the live device readout where unset (device = live truth,
    // project = remembered intent). This is generic media-format state — no
    // Tracktion concepts cross to the UI.
    session->setProperty ("project", projectSettingsToVar());

    Array<var> tracks;
    int index = 0;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr)
            tracks.add (trackToVar (*t, index++));

    auto* root = new DynamicObject();
    root->setProperty ("schemaVersion", 1);
    root->setProperty ("session", var (session));
    root->setProperty ("tracks", tracks);
    root->setProperty ("transport", transportToVar());

    // Lightweight current audio-device selection summary for the settings edit form
    // (duplicates session.sampleRate intentionally). Full lists stay on-demand.
    root->setProperty ("audio", currentAudioSelection());

    // Aux buses (Wave 8) — one entry per AuxReturn-carrying track.
    Array<var> buses;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr)
            if (auto* r = firstAuxReturnOn (*t))
            {
                const int bus = r->busNumber.get();
                auto* bo = new DynamicObject();
                bo->setProperty ("bus", bus);
                bo->setProperty ("name", edit.getAuxBusName (bus).isNotEmpty()
                                             ? edit.getAuxBusName (bus) : ("Bus " + String (bus + 1)));
                bo->setProperty ("trackId", t->itemID.toString());
                buses.add (var (bo));
            }
    root->setProperty ("buses", buses);

    // Master bus (Wave 5) — the edit's master VolumeAndPan, always present.
    if (auto mvp = edit.getMasterVolumePlugin())
    {
        auto* master = new DynamicObject();
        master->setProperty ("volumeDb", mvp->getVolumeDb());
        master->setProperty ("pan", mvp->getPan());
        root->setProperty ("master", var (master));
    }
    return var (root);
}

juce::var MoshOps::trackToVar (te::AudioTrack& t, int index)
{
    Array<var> clips;
    for (auto* c : t.getClips())
        if (c != nullptr)
            clips.add (clipToVar (*c));

    auto* o = new DynamicObject();
    o->setProperty ("id", t.itemID.toString());
    o->setProperty ("index", index);
    o->setProperty ("name", t.getName());
    o->setProperty ("type", "audio");
    o->setProperty ("clips", clips);

    // Plugin chain (Stage 3). Indexed within pluginList (built-ins included). The
    // metering tap (Wave 9) is hidden from the rack but keeps its real index so
    // plugin-addressed commands still resolve.
    juce::Array<var> plugins;
    auto pl = t.pluginList.getPlugins();
    for (int i = 0; i < pl.size(); ++i)
        if (pl[i] != nullptr && dynamic_cast<te::LevelMeterPlugin*> (pl[i].get()) == nullptr)
            plugins.add (pluginToVar (*pl[i], i));
    o->setProperty ("plugins", plugins);
    o->setProperty ("meterEnabled", findTrackMeter (t) != nullptr);

    // Mixer state (Stage 2 mixer stub).
    if (auto* vp = t.getVolumePlugin())
    {
        o->setProperty ("volumeDb", vp->getVolumeDb());
        o->setProperty ("pan", vp->getPan());
    }
    else
    {
        o->setProperty ("volumeDb", 0.0);
        o->setProperty ("pan", 0.0);
    }
    o->setProperty ("mute", t.isMuted (false));
    o->setProperty ("solo", t.isSolo (false));

    // Recording state (Wave: recording). Requires a live input-device instance;
    // getAllInputDevices() is empty headless / without a playback context, so all
    // three default false/"automatic"/false. Monitor mode is read off the shared
    // InputDevice behind the instance (per-device, surfaced per-track).
    {
        bool armed = false; juce::String monitor = "automatic"; bool hasInput = false;
        juce::String inputType = "wave"; juce::String midiInputName;
        for (auto* inst : eng.edit().getAllInputDevices())
            if (inst != nullptr && te::isOnTargetTrack (*inst, t, 0))
            {
                hasInput = true;
                armed    = inst->isRecordingEnabled (t.itemID);
                auto& dev = inst->getInputDevice();
                switch (dev.getMonitorMode())
                {
                    case te::InputDevice::MonitorMode::off:       monitor = "off"; break;
                    case te::InputDevice::MonitorMode::on:        monitor = "on"; break;
                    case te::InputDevice::MonitorMode::automatic: monitor = "automatic"; break;
                    default:                                      monitor = "automatic"; break;
                }
                // CTL-001 — let the UI label a MIDI-driven instrument track vs a wave
                // recording track (the routed input device family + its name).
                if (dev.isMidi())
                {
                    inputType     = "midi";
                    midiInputName = dev.getName();
                }
                break;
            }
        o->setProperty ("armed",     armed);     // bool
        o->setProperty ("monitor",   monitor);   // "off" | "automatic" | "on"
        o->setProperty ("hasInput",  hasInput);  // bool — false headless; UI can show "no input"
        o->setProperty ("inputType", inputType); // "wave" | "midi" — kind of the routed input
        if (midiInputName.isNotEmpty())
            o->setProperty ("midiInputName", midiInputName);
    }

    // CTL-001 — does this track host an instrument plugin? The UI shows a "MIDI armed"
    // affordance only on instrument tracks (and arm_track routes live MIDI to them).
    o->setProperty ("isInstrument", trackHasInstrument (t));

    // Sends (post-fader aux sends) owned by this track (Wave 8).
    juce::Array<var> sends;
    for (auto* p : t.pluginList.getPlugins())
        if (auto* s = dynamic_cast<te::AuxSendPlugin*> (p))
        {
            auto* so = new DynamicObject();
            so->setProperty ("bus", s->getBusNumber());
            so->setProperty ("db", s->getGainDb());
            so->setProperty ("mute", s->isMute());
            sends.add (var (so));
        }
    o->setProperty ("sends", sends);
    if (auto* r = firstAuxReturnOn (t))
    {
        o->setProperty ("isReturn", true);
        o->setProperty ("returnBus", r->busNumber.get());
    }
    return var (o);
}

juce::var MoshOps::clipToVar (te::Clip& c)
{
    auto pos = c.getPosition();
    auto* o = new DynamicObject();
    o->setProperty ("id", c.itemID.toString());
    o->setProperty ("name", c.getName());
    o->setProperty ("start", pos.getStart().inSeconds());
    o->setProperty ("length", pos.getLength().inSeconds());
    o->setProperty ("offset", pos.getOffset().inSeconds());

    o->setProperty ("mute", c.isMuted());
    if (auto* w = dynamic_cast<te::WaveAudioClip*> (&c))
    {
        o->setProperty ("type", "wave");
        o->setProperty ("sourceFile", w->getCurrentSourceFile().getFullPathName());
        o->setProperty ("sourceLength", w->getSourceLength().inSeconds());
        o->setProperty ("gainDb", w->getGainDB());
    }
    else if (auto* mc = dynamic_cast<te::MidiClip*> (&c))
    {
        o->setProperty ("type", "midi");
        Array<var> notes;
        auto& seq = mc->getSequence();
        for (int i = 0; i < seq.getNumNotes(); ++i)
            if (auto* n = seq.getNote (i))
            {
                auto* no = new DynamicObject();
                no->setProperty ("i", i);
                no->setProperty ("pitch", n->getNoteNumber());
                no->setProperty ("start", n->getStartBeat().inBeats());     // beats within the clip sequence
                no->setProperty ("length", n->getLengthBeats().inBeats());
                no->setProperty ("velocity", n->getVelocity());
                notes.add (var (no));
            }
        o->setProperty ("notes", notes);
    }
    else
        o->setProperty ("type", "clip");

    auto rl = c.state.getChildWithName (ids::MOSH_RENDERLAYER);
    o->setProperty ("hasRenderLayer", rl.isValid());
    if (rl.isValid())
    {
        auto* r = new DynamicObject();
        r->setProperty ("id", rl[ids::id]);
        r->setProperty ("status", rl[ids::status]);
        r->setProperty ("adapter", rl[ids::modelAdapter]);
        r->setProperty ("mode", rl[ids::mode]);
        r->setProperty ("seed", (int) rl[ids::seed]);
        r->setProperty ("userKept", rl[ids::userKept]);
        r->setProperty ("hasArtifact", juce::File (rl[ids::cacheArtifact].toString()).existsAsFile());
        if (auto params = rl.getChildWithName (ids::PARAMS); params.isValid())
        {
            r->setProperty ("prompt", params[ids::prompt]);
            r->setProperty ("nl", (double) params[ids::nl]);
            Array<var> colors;
            if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
                for (int i = 0; i < cs.getNumChildren(); ++i)
                {
                    auto* co = new DynamicObject();
                    co->setProperty ("name", cs.getChild (i)[ids::name]);
                    co->setProperty ("value", (double) cs.getChild (i)[ids::value]);
                    colors.add (var (co));
                }
            r->setProperty ("colors", colors);
        }
        o->setProperty ("renderLayer", var (r));
    }
    return var (o);
}

juce::var MoshOps::transportToVar()
{
    auto& transport = eng.edit().getTransport();
    auto loop = transport.getLoopRange();
    auto* o = new DynamicObject();
    o->setProperty ("playing", transport.isPlaying());
    o->setProperty ("recording", transport.isRecording());
    o->setProperty ("position", transport.getPosition().inSeconds());
    o->setProperty ("looping", transport.looping.get());
    o->setProperty ("loopStart", loop.getStart().inSeconds());
    o->setProperty ("loopEnd", loop.getEnd().inSeconds());
    return var (o);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
te::AudioTrack* MoshOps::findTrack (const juce::String& id)
{
    return te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (id));
}

bool MoshOps::trackHasInstrument (te::AudioTrack& t)
{
    // Same predicate pluginToVar uses for the "isInstrument" flag: an external
    // synth (ExternalPlugin::isSynth) or a builtin instrument (e.g. 4OSC/sampler).
    auto plugins = t.pluginList.getPlugins();
    for (int i = 0; i < plugins.size(); ++i)
    {
        auto* p = plugins[i].get();
        if (p == nullptr) continue;
        if (auto* ext = dynamic_cast<te::ExternalPlugin*> (p))
            if (ext->isSynth())
                return true;
        if (const auto* bspec = findBuiltin (p->getPluginType()))
            if (bspec->isInstrument)
                return true;
    }
    return false;
}

te::Clip* MoshOps::findClip (const juce::String& id)
{
    const auto target = te::EditItemID::fromString (id);
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            for (auto* c : t->getClips())
                if (c != nullptr && c->itemID == target)
                    return c;
    return nullptr;
}

te::Plugin* MoshOps::findPlugin (const juce::String& trackId, int index)
{
    auto* track = findTrack (trackId);
    if (track == nullptr) return nullptr;
    auto plugins = track->pluginList.getPlugins();
    return (index >= 0 && index < plugins.size()) ? plugins[index].get() : nullptr;
}

void MoshOps::emit (const juce::String& type, juce::var payload)
{
    if (! eventSink) return;
    auto* e = new DynamicObject();
    e->setProperty ("type", type);
    e->setProperty ("payload", payload);
    eventSink (var (e));
}

void MoshOps::emitSnapshotInvalidated()
{
    emit ("snapshot_invalidated");
}

void MoshOps::logLine (const juce::String& command, const juce::var& args,
                       bool ok, const juce::String& error, bool undoable)
{
    auto* o = new DynamicObject();
    o->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    o->setProperty ("seq", ++seq);
    o->setProperty ("command", command);
    o->setProperty ("args", args);
    o->setProperty ("ok", ok);
    if (error.isNotEmpty()) o->setProperty ("error", error);
    o->setProperty ("undoable", undoable);
    logFile.appendText (JSON::toString (var (o), true) + "\n");
}

juce::var MoshOps::okResult (const juce::String& command, juce::var data)
{
    auto* o = new DynamicObject();
    o->setProperty ("ok", true);
    o->setProperty ("command", command);
    if (! data.isVoid()) o->setProperty ("data", data);
    return var (o);
}

juce::var MoshOps::errResult (const juce::String& command, const juce::String& message)
{
    auto* o = new DynamicObject();
    o->setProperty ("ok", false);
    o->setProperty ("command", command);
    o->setProperty ("error", message);
    return var (o);
}

} // namespace mosh
