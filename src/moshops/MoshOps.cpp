#include "MoshOps.h"
#include "state/Ids.h"
#include "state/RenderLayer.h"
#include "plugins/neural/NeuralInsertPlugin.h"
#include <thread>

namespace mosh
{
using namespace juce;

MoshOps::MoshOps (MoshEngine& engineToUse)
    : eng (engineToUse), pluginHost (engineToUse.engine())
{
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    pluginHost.initialise();                 // formats + curated VST3 scan
    startTimerHz (30);                       // telemetry decimated to 30 Hz, never per-block
}

MoshOps::~MoshOps() { stopTimer(); }

void MoshOps::timerCallback()
{
    // Push a decimated transport delta while playing (and once on the
    // play→stop edge) so the UI playhead animates without polling (02 §4.2).
    auto& transport = eng.edit().getTransport();
    const bool playing = transport.isPlaying();
    if (playing || wasPlaying)
        emit ("transport", transportToVar());
    wasPlaying = playing;
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
    if (name == "add_test_tone_clip")return cmdAddTestTone (args);
    if (name == "set_transport")     return cmdSetTransport (args);
    if (name == "undo")              return cmdUndo (args);
    if (name == "redo")              return cmdRedo (args);
    if (name == "save")              return cmdSave (args);
    if (name == "reload")            return cmdReload (args);
    if (name == "add_render_layer")  return cmdAddRenderLayer (args);
    if (name == "move_clip")         return cmdMoveClip (args);
    if (name == "trim_clip")         return cmdTrimClip (args);
    if (name == "split_clip")        return cmdSplitClip (args);
    if (name == "set_track_volume")  return cmdSetTrackVolume (args);
    if (name == "set_track_pan")     return cmdSetTrackPan (args);
    if (name == "set_track_mute")    return cmdSetTrackMute (args);
    if (name == "set_track_solo")    return cmdSetTrackSolo (args);
    if (name == "get_clip_peaks")    return cmdGetClipPeaks (args);
    if (name == "list_plugins")      return cmdListPlugins (args);
    if (name == "load_plugin")       return cmdLoadPlugin (args);
    if (name == "remove_plugin")     return cmdRemovePlugin (args);
    if (name == "reorder_plugin")    return cmdReorderPlugin (args);
    if (name == "set_plugin_param")  return cmdSetPluginParam (args);
    if (name == "bypass_plugin")     return cmdBypassPlugin (args);
    if (name == "open_plugin_editor")return cmdOpenPluginEditor (args);
    if (name == "add_midi_clip")     return cmdAddMidiClip (args);
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
    if (name == "list_colors")       return cmdListColors (args);
    if (name == "export_audio")      return cmdExportAudio (args);

    return errResult (name, "unknown command: " + name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdCreateTrack (const juce::var& args)
{
    undoManager().beginNewTransaction ("create_track");
    auto& edit = eng.edit();
    auto track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr);
    if (track == nullptr)
    {
        logLine ("create_track", args, false, "insert failed", true);
        return errResult ("create_track", "insert failed");
    }

    const auto name = args.getProperty ("name", var()).toString();
    if (name.isNotEmpty())
        track->setName (name);

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

juce::var MoshOps::cmdImportClip (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("import_clip", "missing 'file'");

    File file (path);
    if (! file.existsAsFile()) return errResult ("import_clip", "file not found: " + path);

    auto& edit = eng.edit();
    auto id = args.getProperty ("trackId", var()).toString();
    auto* track = id.isNotEmpty() ? findTrack (id) : nullptr;
    if (track == nullptr)
    {
        auto tracks = te::getAudioTracks (edit);
        track = tracks.isEmpty() ? nullptr : tracks.getFirst();
    }

    undoManager().beginNewTransaction ("import_clip");
    if (track == nullptr)
        track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr).get();
    if (track == nullptr) return errResult ("import_clip", "no track");

    te::AudioFile audioFile (edit.engine, file);
    if (! audioFile.isValid()) return errResult ("import_clip", "invalid audio file");

    const double start = (double) args.getProperty ("startSeconds", 0.0);
    const double len = audioFile.getLength();
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = file.getFileNameWithoutExtension();

    auto clip = track->insertWaveClip (name, file,
        { { tracktion::TimePosition::fromSeconds (start), tracktion::TimeDuration::fromSeconds (len) }, {} }, false);
    if (clip == nullptr)
    {
        logLine ("import_clip", args, false, "insert failed", true);
        return errResult ("import_clip", "insertWaveClip failed");
    }

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("import_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("import_clip", var (data));
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
    eng.reloadFromFile();
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

juce::var MoshOps::cmdSetTrackVolume (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_volume", "no track");
    auto* vp = track->getVolumePlugin();
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
    auto* vp = track->getVolumePlugin();
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
    for (auto& d : pluginHost.available())
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", PluginHost::idFor (d));
        o->setProperty ("name", d.name);
        o->setProperty ("format", d.pluginFormatName);
        o->setProperty ("manufacturer", d.manufacturerName);
        o->setProperty ("isInstrument", d.isInstrument);
        plugins.add (var (o));
    }
    auto* data = new DynamicObject();
    data->setProperty ("plugins", plugins);
    return okResult ("list_plugins", var (data));
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

juce::var MoshOps::cmdOpenPluginEditor (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("open_plugin_editor", "no plugin");
    pluginHost.openEditor (*plugin);          // native pop-out (not undoable)
    logLine ("open_plugin_editor", args, true, {}, false);
    return okResult ("open_plugin_editor");
}

juce::var MoshOps::cmdAddMidiClip (const juce::var& args)
{
    auto& edit = eng.edit();
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    undoManager().beginNewTransaction ("add_midi_clip");
    if (track == nullptr)
        track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr).get();
    if (track == nullptr) return errResult ("add_midi_clip", "no track");

    const double start = (double) args.getProperty ("start", 0.0);
    const double length = (double) args.getProperty ("length", 2.0);
    auto clip = track->insertMIDIClip (args.getProperty ("name", "MIDI").toString(),
        { tracktion::TimePosition::fromSeconds (start), tracktion::TimePosition::fromSeconds (start + length) }, nullptr);
    if (clip == nullptr) return errResult ("add_midi_clip", "insertMIDIClip failed");

    auto& seq = clip->getSequence();
    if (auto notes = args.getProperty ("notes", var()); notes.isArray())
    {
        for (auto& n : *notes.getArray())
            seq.addNote ((int) n.getProperty ("pitch", 60),
                         tracktion::BeatPosition::fromBeats ((double) n.getProperty ("start", 0.0)),
                         tracktion::BeatDuration::fromBeats ((double) n.getProperty ("length", 1.0)),
                         (int) n.getProperty ("velocity", 100), 0, &undoManager());
    }
    else
    {
        // Default: a C-major arpeggio so a synth has something to play (gate).
        const int pattern[] = { 60, 64, 67, 72 };
        for (int i = 0; i < 4; ++i)
            seq.addNote (pattern[i], tracktion::BeatPosition::fromBeats ((double) i),
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
// Stage 4 — Tier-A real-time neural insert
// ─────────────────────────────────────────────────────────────────────────────
namespace
{
    NeuralInsertPlugin* asNeural (te::Plugin* p) { return dynamic_cast<NeuralInsertPlugin*> (p); }
}

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
        for (int i = 0; i < 2400; ++i)   // up to ~120s — generative renders are slow (model load + diffusion + QA)
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
        lane = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr).get();
        if (lane != nullptr) lane->setName ("Neural Renders");
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6 — export (the full producer loop ends here)
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdExportAudio (const juce::var& args)
{
    auto& edit = eng.edit();
    auto file = args.getProperty ("file", var()).toString().isNotEmpty()
                    ? juce::File (args.getProperty ("file", var()).toString())
                    : eng.sessionDir().getChildFile ("exports")
                          .getChildFile ("mix-" + String (Time::getCurrentTime().toMilliseconds()))
                          .withFileExtension ("wav");
    file.getParentDirectory().createDirectory();
    file.deleteFile();

    // Render exclusivity (01 §5): detach the Edit from the device before an
    // offline render (asserts otherwise). No-op when no device is attached.
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();

    const double len = juce::jmax (0.1, edit.getLength().inSeconds());

    // Synchronous whole-edit render (useThread=false blocks until the file is
    // written; the Parameters overload starts a BACKGROUND job and returns early).
    const bool ok = te::Renderer::renderToFile (edit, file, false)
                    && file.existsAsFile() && file.getSize() > 0;

    logLine ("export_audio", args, ok, ok ? String() : String ("render produced no file"), false);
    if (! ok) return errResult ("export_audio", "export render failed");

    auto* data = new DynamicObject();
    data->setProperty ("file", file.getFullPathName());
    data->setProperty ("bytes", (juce::int64) file.getSize());
    data->setProperty ("seconds", len);
    return okResult ("export_audio", var (data));
}

juce::var MoshOps::pluginToVar (te::Plugin& p, int index)
{
    auto* o = new DynamicObject();
    o->setProperty ("index", index);
    o->setProperty ("name", p.getName());
    o->setProperty ("type", p.getPluginType());
    o->setProperty ("enabled", p.isEnabled());
    auto* ext = dynamic_cast<te::ExternalPlugin*> (&p);
    o->setProperty ("external", ext != nullptr);
    o->setProperty ("isInstrument", ext != nullptr && ext->isSynth());
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
    session->setProperty ("editFile", eng.editFile().getFullPathName());

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

    // Plugin chain (Stage 3). Indexed within pluginList (built-ins included).
    juce::Array<var> plugins;
    auto pl = t.pluginList.getPlugins();
    for (int i = 0; i < pl.size(); ++i)
        if (pl[i] != nullptr)
            plugins.add (pluginToVar (*pl[i], i));
    o->setProperty ("plugins", plugins);

    // Mixer state (Stage 2 mixer stub).
    if (auto* vp = t.getVolumePlugin())
    {
        o->setProperty ("volumeDb", vp->getVolumeDb());
        o->setProperty ("pan", vp->getPan());
    }
    o->setProperty ("mute", t.isMuted (false));
    o->setProperty ("solo", t.isSolo (false));
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

    if (auto* w = dynamic_cast<te::WaveAudioClip*> (&c))
    {
        o->setProperty ("type", "wave");
        o->setProperty ("sourceFile", w->getCurrentSourceFile().getFullPathName());
        o->setProperty ("sourceLength", w->getSourceLength().inSeconds());
    }
    else if (dynamic_cast<te::MidiClip*> (&c) != nullptr)
        o->setProperty ("type", "midi");
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
