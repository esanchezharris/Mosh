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
    adoptEditMeters();                       // engine-output taps (Stage 14)
    startTimerHz (30);                       // telemetry decimated to 30 Hz, never per-block
}

MoshOps::~MoshOps()
{
    stopTimer();
    releaseAllMeterClients();
}

void MoshOps::releaseMeterClient (MeterClient& mc)
{
    // The held Plugin::Ptr guarantees the measurer is alive for removeClient,
    // even after the edit that owned the plugin is gone.
    if (mc.plugin != nullptr && mc.client != nullptr)
        if (auto* meter = dynamic_cast<te::LevelMeterPlugin*> (mc.plugin.get()))
            meter->measurer.removeClient (*mc.client);
    mc.plugin = nullptr;
    mc.client.reset();
}

void MoshOps::releaseAllMeterClients()
{
    for (auto& [key, mc] : meterClients)
        releaseMeterClient (mc);
    meterClients.clear();
}

void MoshOps::timerCallback()
{
    // reload/resetEmpty/collab-rebase swap the Edit object out from under us;
    // the old measurers died with it, so re-adopt before touching anything.
    if (&eng.edit() != meterEdit)
        adoptEditMeters();

    // Push a decimated transport delta while playing (and once on the
    // play-to-stop edge) so the UI playhead animates without polling (02 §4.2).
    // Levels ride in the same event (one feed for playhead AND meters).
    auto& transport = eng.edit().getTransport();
    const bool playing = transport.isPlaying();
    if (playing || wasPlaying)
    {
        auto tv = transportToVar();
        if (auto* o = tv.getDynamicObject())
            o->setProperty ("levels", meterLevels());
        emit ("transport", tv);
    }
    wasPlaying = playing;

    // Autosave (Stage 21): GUI sessions persist every ~90s when dirty — the
    // headless paths save on exit already.
    if (eng.hasAudio() && ++autosaveTicks >= 30 * 90)
    {
        autosaveTicks = 0;
        if (eng.edit().hasChangedSinceSaved())
            eng.save();
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

    // Single interception point for the session recorder (phase0 §5): observe
    // at depth 0 only, so IR-lowered sub-commands aren't double-recorded —
    // the execute_ir step carries the corpus view.
    ++execDepth;
    auto result = dispatch (name, args);
    --execDepth;
    if (execDepth == 0 && commandObserver)
        commandObserver (name, args, result);
    return result;
}

juce::var MoshOps::dispatch (const juce::String& name, const juce::var& args)
{
    if (name == "create_track")      return cmdCreateTrack (args);
    if (name == "rename_track")      return cmdRenameTrack (args);
    if (name == "remove_track")      return cmdRemoveTrack (args);
    if (name == "import_clip")       return cmdImportClip (args);
    if (name == "add_test_tone_clip")return cmdAddTestTone (args);
    if (name == "set_transport")     return cmdSetTransport (args);
    if (name == "list_audio_outputs") return cmdListAudioOutputs (args);
    if (name == "set_audio_output")  return cmdSetAudioOutput (args);
    if (name == "set_metronome")     return cmdSetMetronome (args);
    if (name == "set_send_gain")     return cmdSetSendGain (args);
    if (name == "set_master_volume") return cmdSetMasterVolume (args);
    if (name == "duplicate_clip")    return cmdDuplicateClip (args);
    if (name == "move_track")        return cmdMoveTrack (args);
    if (name == "choose_file")       return cmdChooseFile (args);
    if (name == "list_dir")          return cmdListDir (args);
    if (name == "audition_file")     return cmdAuditionFile (args);
    if (name == "stop_audition")     return cmdStopAudition (args);
    if (name == "list_audio_inputs") return cmdListAudioInputs (args);
    if (name == "set_audio_input")   return cmdSetAudioInput (args);
    if (name == "arm_track")         return cmdArmTrack (args);
    if (name == "set_input_monitor") return cmdSetInputMonitor (args);
    if (name == "set_count_in")      return cmdSetCountIn (args);
    if (name == "rename_clip")       return cmdRenameClip (args);
    if (name == "list_projects")     return cmdListProjects (args);
    if (name == "save_project_as")   return cmdSaveProjectAs (args);
    if (name == "open_project")      return cmdOpenProject (args);
    if (name == "set_clip_gain")     return cmdSetClipGain (args);
    if (name == "set_clip_reversed") return cmdSetClipReversed (args);
    if (name == "set_clip_loop")     return cmdSetClipLoop (args);
    if (name == "set_clip_fades")    return cmdSetClipFades (args);
    if (name == "get_automation")    return cmdGetAutomation (args);
    if (name == "clear_automation")  return cmdClearAutomation (args);
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
    // Stage 7 — MoshIR engine gaps
    if (name == "set_tempo")         return cmdSetTempo (args);
    if (name == "remove_tempo")     return cmdRemoveTempo (args);
    if (name == "set_time_sig")      return cmdSetTimeSig (args);
    if (name == "set_key")           return cmdSetKey (args);
    if (name == "add_notes")         return cmdAddNotes (args);
    if (name == "remove_notes")      return cmdRemoveNotes (args);
    if (name == "update_notes")      return cmdUpdateNotes (args);
    if (name == "transpose_notes")   return cmdTransposeNotes (args);
    if (name == "quantize_notes")    return cmdQuantizeNotes (args);
    if (name == "humanize_notes")    return cmdHumanizeNotes (args);
    if (name == "load_builtin_plugin") return cmdLoadBuiltin (args);
    if (name == "add_sampler_sound") return cmdAddSamplerSound (args);
    if (name == "remove_clip")       return cmdRemoveClip (args);
    if (name == "route_track")       return cmdRouteTrack (args);
    if (name == "add_send")          return cmdAddSend (args);
    if (name == "add_return")        return cmdAddReturn (args);
    if (name == "set_sidechain")     return cmdSetSidechain (args);
    if (name == "write_automation")  return cmdWriteAutomation (args);
    if (name == "set_clip_pitch")    return cmdSetClipPitch (args);
    if (name == "set_clip_stretch")  return cmdSetClipStretch (args);
    if (name == "slice_clip")        return cmdSliceClip (args);
    if (name == "create_section")    return cmdCreateSection (args);
    if (name == "remove_section")   return cmdRemoveSection (args);
    // Stage 8 — replay harness + determinism
    if (name == "get_state_hash")    return cmdGetStateHash (args);
    if (name == "generate_asset")    return cmdGenerateAsset (args);
    if (name == "execute_ir")        return irHook ? irHook (args)
                                                   : errResult (name, "IR executor not wired");
    // Stage 9 — recorder-directed commands: MoshOps validates + logs; the
    // SessionRecorder reacts via the command observer (layering stays clean).
    if (name == "set_tutorial")
    {
        if (args.getProperty ("url", var()).toString().isEmpty())
            return errResult (name, "missing 'url'");
        logLine (name, args, true, {}, false);
        return okResult (name);
    }
    if (name == "drop_marker")
    {
        if (! args.hasProperty ("videoTs"))
            return errResult (name, "missing 'videoTs' (seconds into the tutorial video)");
        logLine (name, args, true, {}, false);
        return okResult (name);
    }
    if (name == "set_consent")
    {
        if (! args.hasProperty ("consent"))
            return errResult (name, "missing 'consent'");
        logLine (name, args, true, {}, false);
        return okResult (name);
    }
    // Stage 11 — Monster v0
    if (name == "agent_propose")     return cmdAgentPropose (args);
    // Stage 10 — git-style session sync
    if (name.startsWith ("collab_"))
        return collabHook ? collabHook (name, args)
                          : errResult (name, "collab engine not wired");

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
        track = createAudioTrack ({});
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 15 — real-DAW basics
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdSetMetronome (const juce::var& args)
{
    auto& edit = eng.edit();
    // Playback aid, not musical state: bypass the undo manager (a metronome
    // toggle must never become an undo step), keep it out of the trajectory,
    // collab sync, and the canonical hash.
    edit.clickTrackEnabled.setValue ((bool) args.getProperty ("on", false), nullptr);
    if (args.hasProperty ("gain"))
        edit.clickTrackGain.setValue (juce::jlimit (0.2f, 1.0f,
            (float) (double) args.getProperty ("gain", 0.6)), nullptr);

    logLine ("set_metronome", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("set_metronome");
}

juce::var MoshOps::cmdSetSendGain (const juce::var& args)
{
    auto* send = dynamic_cast<te::AuxSendPlugin*> (
        findPlugin (args.getProperty ("trackId", var()).toString(),
                    (int) args.getProperty ("index", -1)));
    if (send == nullptr) return errResult ("set_send_gain", "no send at index");

    undoManager().beginNewTransaction ("set_send_gain");
    send->setGainDb (juce::jlimit (-96.0f, 12.0f, (float) (double) args.getProperty ("gainDb", 0.0)));
    logLine ("set_send_gain", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_send_gain");
}

juce::var MoshOps::cmdSetMasterVolume (const juce::var& args)
{
    auto vp = eng.edit().getMasterVolumePlugin();
    if (vp == nullptr) return errResult ("set_master_volume", "no master volume plugin");

    undoManager().beginNewTransaction ("set_master_volume");
    vp->setVolumeDb (juce::jlimit (-96.0f, 12.0f, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_master_volume", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_volume");
}

juce::var MoshOps::cmdDuplicateClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("duplicate_clip", "no clip: "
                                           + args.getProperty ("clipId", var()).toString());
    auto* track = args.hasProperty ("trackId")
                      ? findTrack (args.getProperty ("trackId", var()).toString())
                      : dynamic_cast<te::AudioTrack*> (clip->getTrack());
    if (track == nullptr) return errResult ("duplicate_clip", "no destination track");

    undoManager().beginNewTransaction ("duplicate_clip");
    auto state = clip->state.createCopy();
    // Fresh EditItemIDs for the copy and everything inside it (notes etc.) —
    // duplicate ids corrupt lookups and the canonical hash's ordinal mapping.
    te::EditItemID::remapIDs (state, nullptr, eng.edit());
    auto* copy = te::insertClipWithState (*track, state);
    if (copy == nullptr) return errResult ("duplicate_clip", "insertClipWithState failed");

    const double start = args.hasProperty ("startSeconds")
                             ? (double) args.getProperty ("startSeconds", 0.0)
                             : clip->getPosition().getEnd().inSeconds();   // FL-style: land after the source
    copy->setStart (tracktion::TimePosition::fromSeconds (start), false, true);

    auto* data = new DynamicObject();
    data->setProperty ("clipId", copy->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("duplicate_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("duplicate_clip", var (data));
}

juce::var MoshOps::cmdMoveTrack (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("move_track", "no track");

    auto& edit = eng.edit();
    undoManager().beginNewTransaction ("move_track");
    if (const auto beforeId = args.getProperty ("beforeTrackId", var()).toString(); beforeId.isNotEmpty())
    {
        auto* before = findTrack (beforeId);
        if (before == nullptr) return errResult ("move_track", "no track: " + beforeId);
        // Insert before `before`: the preceding sibling is whatever sits above it.
        auto tracks = te::getAudioTracks (edit);
        const int bi = tracks.indexOf (before);
        te::Track* preceding = bi > 0 ? static_cast<te::Track*> (tracks[bi - 1]) : nullptr;
        if (preceding == track)        // already there
        {
            logLine ("move_track", args, true, {}, true);
            return okResult ("move_track");
        }
        edit.moveTrack (track, te::TrackInsertPoint (nullptr, preceding));
    }
    else
    {
        edit.moveTrack (track, te::TrackInsertPoint::getEndOfTracks (edit));
    }

    // Track-order AsyncUpdater drain (same as createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    logLine ("move_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_track");
}

juce::var MoshOps::cmdChooseFile (const juce::var& args)
{
    // Test/headless override: dialogs can't open without a UI session.
    if (const auto forced = juce::SystemStats::getEnvironmentVariable ("MOSH_CHOOSE_FILE", {}); forced.isNotEmpty())
    {
        auto* d = new DynamicObject();
        d->setProperty ("path", forced);
        return okResult ("choose_file", var (d));
    }
    if (! eng.hasAudio())
        return errResult ("choose_file", "no UI session (headless) - set MOSH_CHOOSE_FILE for tests");

    const auto wildcard = args.getProperty ("wildcard", "*.wav;*.aif;*.aiff;*.mp3;*.flac;*.ogg").toString();
    auto initial = juce::File (juce::SystemStats::getEnvironmentVariable ("MOSH_SAMPLE_LIBRARY", {}));
    if (! initial.isDirectory())
        initial = juce::File::getSpecialLocation (juce::File::userHomeDirectory);

    juce::FileChooser fc (args.getProperty ("title", "Choose an audio file").toString(), initial, wildcard);
    if (! fc.browseForFileToOpen())     // JUCE_MODAL_LOOPS_PERMITTED=1 (CMakeLists)
    {
        auto* d = new DynamicObject();
        d->setProperty ("cancelled", true);
        return okResult ("choose_file", var (d));
    }
    auto* d = new DynamicObject();
    d->setProperty ("path", fc.getResult().getFullPathName());
    return okResult ("choose_file", var (d));
}

// ─────────────────────────────────────────────────────────────────────────────
// Crate browser (Stage 18). Rooted at MOSH_SAMPLE_LIBRARY; every path arg is
// RELATIVE to that root and traversal-guarded — the browser can never escape
// the crate. All three commands are read-only/playback aids (excluded from
// the recorder and collab sync).
// ─────────────────────────────────────────────────────────────────────────────
namespace
{
    juce::File crateRootDir()
    {
        const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_SAMPLE_LIBRARY", {}).trim();
        if (env.isNotEmpty() && juce::File (env).isDirectory())
            return juce::File (env);
        auto fallback = juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                            .getChildFile ("Splice").getChildFile ("sounds");
        return fallback.isDirectory()
                   ? fallback
                   : juce::File::getSpecialLocation (juce::File::userMusicDirectory);
    }

    bool isAudioFile (const juce::File& f)
    {
        static const juce::StringArray exts { ".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a" };
        return exts.contains (f.getFileExtension().toLowerCase());
    }

    // Resolve a relative crate path; {} if it escapes the root.
    juce::File resolveCratePath (const juce::String& rel)
    {
        auto root = crateRootDir();
        if (rel.isEmpty()) return root;
        if (rel.contains ("..")) return {};
        auto f = root.getChildFile (rel);
        if (! f.getFullPathName().startsWith (root.getFullPathName())) return {};
        return f;
    }
}

juce::var MoshOps::cmdListDir (const juce::var& args)
{
    auto root = crateRootDir();
    auto* data = new DynamicObject();
    juce::var dataHolder (data);   // owns the object across the early error returns
    data->setProperty ("root", root.getFullPathName());

    if (const auto query = args.getProperty ("query", var()).toString().trim(); query.isNotEmpty())
    {
        // Recursive filename search, capped — the browser's search box.
        Array<var> hits;
        int count = 0;
        for (const auto& f : root.findChildFiles (juce::File::findFiles, true,
                                                  "*" + query + "*", juce::File::FollowSymlinks::no))
        {
            if (! isAudioFile (f)) continue;
            if (count++ >= 200) { data->setProperty ("truncated", true); break; }
            auto* e = new DynamicObject();
            e->setProperty ("name", f.getFileName());
            e->setProperty ("path", f.getRelativePathFrom (root));
            hits.add (var (e));
        }
        data->setProperty ("files", hits);
        data->setProperty ("dirs", Array<var>());
        return okResult ("list_dir", dataHolder);
    }

    auto dir = resolveCratePath (args.getProperty ("path", var()).toString());
    if (dir == juce::File() || ! dir.isDirectory())
        return errResult ("list_dir", "bad path");

    Array<var> dirs, files;
    for (const auto& d : dir.findChildFiles (juce::File::findDirectories, false))
        if (! d.isHidden())
            dirs.add (d.getFileName());
    for (const auto& f : dir.findChildFiles (juce::File::findFiles, false))
        if (isAudioFile (f))
        {
            auto* e = new DynamicObject();
            e->setProperty ("name", f.getFileName());
            e->setProperty ("path", f.getRelativePathFrom (crateRootDir()));
            files.add (var (e));
        }
    data->setProperty ("dirs", dirs);
    data->setProperty ("files", files);
    return okResult ("list_dir", dataHolder);
}

juce::var MoshOps::cmdAuditionFile (const juce::var& args)
{
    auto f = resolveCratePath (args.getProperty ("path", var()).toString());
    if (f == juce::File() || ! f.existsAsFile())
        return errResult ("audition_file", "bad path");
    if (! eng.auditionFile (f))
        return errResult ("audition_file", "no audio session");
    auto* data = new DynamicObject();
    data->setProperty ("file", f.getFullPathName());
    return okResult ("audition_file", var (data));
}

juce::var MoshOps::cmdStopAudition (const juce::var&)
{
    eng.stopAudition();
    return okResult ("stop_audition");
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording (Stage 19). Arming follows the engine's own example pattern:
// assign the wave-input instance to the track (setTarget) then enable
// recording for it; the existing set_transport {action:"record"} starts the
// take and stop(false,…) COMMITS it as a clip on the track.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdRenameClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("rename_clip", "no clip");
    const auto name = args.getProperty ("name", var()).toString().trim();
    if (name.isEmpty()) return errResult ("rename_clip", "missing 'name'");

    undoManager().beginNewTransaction ("rename_clip");
    clip->setName (name);
    logLine ("rename_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_clip");
}

// ─────────────────────────────────────────────────────────────────────────────
// Automation lanes (Stage 22). get_automation lists every parameter on the
// track that HAS a curve (volume/pan + visible plugins), with points in
// (beats, normalized 0..1) — the exact shape write_automation consumes, so the
// lane UI round-trips losslessly through the lane-replace semantics.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Project management (Stage 26). Projects are copy-based snapshots under
// <sessionParent>/projects/<name>/ (edit + session audio). The live edit
// ALWAYS stays at the session path, so its absolute audio references hold:
// save-as copies session files OUT, open copies them back IN then reloads.
// Machine-local workflow — excluded from the recorder and collab sync
// (a project switch is not a replayable musical op; the oplog stays the
// source of truth for shared sessions).
// ─────────────────────────────────────────────────────────────────────────────
namespace
{
    juce::File projectsDir (MoshEngine& eng)
    {
        return eng.sessionDir().getParentDirectory().getChildFile ("projects");
    }
    juce::String sanitizeProjectName (const juce::String& raw)
    {
        return juce::File::createLegalFileName (raw.trim());
    }
}

juce::var MoshOps::cmdListProjects (const juce::var&)
{
    Array<var> names;
    for (const auto& d : projectsDir (eng).findChildFiles (juce::File::findDirectories, false))
        if (d.getChildFile ("session.tracktionedit").existsAsFile())
            names.add (d.getFileName());
    auto* data = new DynamicObject();
    data->setProperty ("projects", names);
    data->setProperty ("current",
        eng.sessionDir().getChildFile ("project-name.txt").loadFileAsString().trim());
    return okResult ("list_projects", var (data));
}

juce::var MoshOps::cmdSaveProjectAs (const juce::var& args)
{
    const auto name = sanitizeProjectName (args.getProperty ("name", var()).toString());
    if (name.isEmpty()) return errResult ("save_project_as", "missing 'name'");

    eng.save();
    auto dest = projectsDir (eng).getChildFile (name);
    dest.deleteRecursively();
    dest.createDirectory();
    if (! eng.editFile().copyFileTo (dest.getChildFile ("session.tracktionedit")))
        return errResult ("save_project_as", "copy failed");
    auto audioSrc = eng.sessionDir().getChildFile ("audio");
    if (audioSrc.isDirectory())
        audioSrc.copyDirectoryTo (dest.getChildFile ("audio"));
    eng.sessionDir().getChildFile ("project-name.txt").replaceWithText (name);

    logLine ("save_project_as", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("name", name);
    return okResult ("save_project_as", var (data));
}

juce::var MoshOps::cmdOpenProject (const juce::var& args)
{
    const auto name = sanitizeProjectName (args.getProperty ("name", var()).toString());
    auto src = projectsDir (eng).getChildFile (name);
    if (! src.getChildFile ("session.tracktionedit").existsAsFile())
        return errResult ("open_project", "no project: " + name);

    // Preserve the current work before swapping.
    eng.save();
    eng.edit().getTransport().stop (false, false);

    // Drain background proxy/render jobs before files change under them
    // (reloadFromFileNoSave drains again before the edit swap).
    eng.drainRenderJobs();

    src.getChildFile ("session.tracktionedit").copyFileTo (eng.editFile());
    auto audioDst = eng.sessionDir().getChildFile ("audio");
    auto audioSrc = src.getChildFile ("audio");
    if (audioSrc.isDirectory())
    {
        for (const auto& f : audioSrc.findChildFiles (juce::File::findFiles, false))
            f.copyFileTo (audioDst.getChildFile (f.getFileName()));
    }
    eng.reloadFromFileNoSave();
    eng.sessionDir().getChildFile ("project-name.txt").replaceWithText (name);

    logLine ("open_project", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("name", name);
    return okResult ("open_project", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Clip inspector (Stage 24): gain + reverse join the existing pitch/stretch/
// slice commands. Both are AudioClipBase properties — wave clips only.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdSetClipGain (const juce::var& args)
{
    auto* acb = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (acb == nullptr) return errResult ("set_clip_gain", "no audio clip");

    undoManager().beginNewTransaction ("set_clip_gain");
    acb->setGainDB (juce::jlimit (-48.0f, 24.0f, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_clip_gain", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_gain");
}

juce::var MoshOps::cmdSetClipReversed (const juce::var& args)
{
    auto* acb = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (acb == nullptr) return errResult ("set_clip_reversed", "no audio clip");

    undoManager().beginNewTransaction ("set_clip_reversed");
    acb->setIsReversed ((bool) args.getProperty ("reversed", false));
    // Reversing spawns a proxy-render job whose worker hops onto the message
    // thread via callBlocking — service it NOW; in headless command bursts
    // nothing else pumps and the job times out + asserts at shutdown.
    eng.drainRenderJobs (4000);
    logLine ("set_clip_reversed", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_reversed");
}

// ─────────────────────────────────────────────────────────────────────────────
// Clip looping + fades (Stage 29). Looping uses the engine's beat-based loop
// range: content repeats every loopBeats when the clip is stretched longer.
// Fades are AudioClipBase fade in/out; autoCrossfade makes overlapping clips
// on a track crossfade automatically.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdSetClipLoop (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("set_clip_loop", "no clip");

    undoManager().beginNewTransaction ("set_clip_loop");
    const double loopBeats = (double) args.getProperty ("loopBeats", 0.0);
    if (loopBeats <= 0.0)
        clip->setLoopRangeBeats ({});   // loop off
    else
        clip->setLoopRangeBeats ({ tracktion::BeatPosition(),
                                   tracktion::BeatPosition::fromBeats (loopBeats) });
    logLine ("set_clip_loop", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_loop");
}

juce::var MoshOps::cmdSetClipFades (const juce::var& args)
{
    auto* acb = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (acb == nullptr) return errResult ("set_clip_fades", "no audio clip");

    undoManager().beginNewTransaction ("set_clip_fades");
    if (args.hasProperty ("fadeInSec"))
        acb->setFadeIn (tracktion::TimeDuration::fromSeconds (
            juce::jmax (0.0, (double) args.getProperty ("fadeInSec", 0.0))));
    if (args.hasProperty ("fadeOutSec"))
        acb->setFadeOut (tracktion::TimeDuration::fromSeconds (
            juce::jmax (0.0, (double) args.getProperty ("fadeOutSec", 0.0))));
    if (args.hasProperty ("autoCrossfade"))
        acb->setAutoCrossfade ((bool) args.getProperty ("autoCrossfade", false));
    logLine ("set_clip_fades", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_fades");
}

juce::var MoshOps::cmdGetAutomation (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("get_automation", "no track");

    auto& ts = eng.edit().tempoSequence;
    auto laneFor = [&] (te::AutomatableParameter& param) -> juce::var
    {
        Array<var> points;
        auto& curve = param.getCurve();
        for (int i = 0; i < curve.getNumPoints(); ++i)
        {
            auto* p = new DynamicObject();
            p->setProperty ("beats", ts.toBeats (curve.getPointTime (i)).inBeats());
            p->setProperty ("value", param.valueRange.convertTo0to1 (curve.getPointValue (i)));
            p->setProperty ("curve", curve.getPointCurve (i));
            points.add (var (p));
        }
        return points;
    };

    Array<var> lanes;
    if (auto* vp = track->getVolumePlugin())
    {
        if (vp->volParam != nullptr && vp->volParam->hasAutomationPoints())
        {
            auto* l = new DynamicObject();
            l->setProperty ("mixer", "volume");
            l->setProperty ("label", "volume");
            l->setProperty ("points", laneFor (*vp->volParam));
            lanes.add (var (l));
        }
        if (vp->panParam != nullptr && vp->panParam->hasAutomationPoints())
        {
            auto* l = new DynamicObject();
            l->setProperty ("mixer", "pan");
            l->setProperty ("label", "pan");
            l->setProperty ("points", laneFor (*vp->panParam));
            lanes.add (var (l));
        }
    }
    auto vis = visiblePlugins (*track);
    for (int pi = 0; pi < vis.size(); ++pi)
    {
        auto* plugin = vis[pi];
        const int n = juce::jmin (64, plugin->getNumAutomatableParameters());
        for (int i = 0; i < n; ++i)
        {
            auto param = plugin->getAutomatableParameter (i);
            if (param == nullptr || ! param->hasAutomationPoints()) continue;
            auto* l = new DynamicObject();
            l->setProperty ("pluginIndex", pi);
            l->setProperty ("paramName", param->getParameterName());
            l->setProperty ("label", plugin->getName() + " · " + param->getParameterName());
            l->setProperty ("points", laneFor (*param));
            lanes.add (var (l));
        }
    }

    auto* data = new DynamicObject();
    data->setProperty ("lanes", lanes);
    return okResult ("get_automation", var (data));
}

juce::var MoshOps::cmdClearAutomation (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("clear_automation", "no track");

    te::AutomatableParameter::Ptr param;
    if (const auto mixer = args.getProperty ("mixer", var()).toString(); mixer.isNotEmpty())
    {
        if (auto* vp = track->getVolumePlugin())
            param = (mixer == "pan") ? vp->panParam : vp->volParam;
    }
    else if (auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                                        (int) args.getProperty ("pluginIndex", -1)))
        param = findParamByName (*plugin, args.getProperty ("paramName", var()).toString());
    if (param == nullptr) return errResult ("clear_automation", "no such param");

    undoManager().beginNewTransaction ("clear_automation");
    param->getCurve().clear (&undoManager());
    logLine ("clear_automation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("clear_automation");
}

juce::var MoshOps::cmdListAudioInputs (const juce::var&)
{
    Array<var> devices;
    for (auto& name : eng.listAudioInputDevices())
        devices.add (name);
    auto* data = new DynamicObject();
    data->setProperty ("devices", devices);
    data->setProperty ("current", eng.currentAudioInputDevice());
    return okResult ("list_audio_inputs", var (data));
}

juce::var MoshOps::cmdSetAudioInput (const juce::var& args)
{
    const auto device = args.getProperty ("device", var()).toString().trim();
    if (device.isEmpty()) return errResult ("set_audio_input", "missing 'device'");

    eng.edit().getTransport().stop (false, false);
    if (auto err = eng.setAudioInputDevice (device); err.isNotEmpty())
        return errResult ("set_audio_input", err);

    logLine ("set_audio_input", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("current", eng.currentAudioInputDevice());
    return okResult ("set_audio_input", var (data));
}

juce::var MoshOps::cmdArmTrack (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("arm_track", "no track");
    const bool on = (bool) args.getProperty ("on", true);

    // Stage 25: arm EVERY usable input — the wave device for audio takes AND
    // any MIDI inputs (physical keyboards + the virtual "All MIDI Ins"), so a
    // sampler/synth track records MIDI clips from a keyboard.
    juce::Array<te::InputDeviceInstance*> candidates;
    for (auto* i : eng.edit().getAllInputDevices())
        if (i != nullptr)
        {
            const auto type = i->getInputDevice().getDeviceType();
            if (type == te::InputDevice::waveDevice
                || type == te::InputDevice::physicalMidiDevice
                || type == te::InputDevice::virtualMidiDevice)
                candidates.add (i);
        }
    if (candidates.isEmpty())
        return errResult ("arm_track", "no input devices open - pick one (set_audio_input)");

    undoManager().beginNewTransaction ("arm_track");
    bool armed = false;
    for (auto* inst : candidates)
    {
        if (on && ! inst->getTargets().contains (track->itemID))
            if (auto r = inst->setTarget (track->itemID, true, &undoManager()); ! r.has_value())
                continue;   // some instances can refuse (busy elsewhere) — arm the rest
        inst->setRecordingEnabled (track->itemID, on);
        armed = armed || inst->isRecordingEnabled (track->itemID);
    }
    if (on && ! armed)
        return errResult ("arm_track", "no input instance accepted the track");

    logLine ("arm_track", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("armed", armed);
    return okResult ("arm_track", var (data));
}

// Stage 25: input monitoring (per-device MonitorMode) + count-in. Both are
// playback aids — never undoable, recorded, synced, or hashed.
juce::var MoshOps::cmdSetInputMonitor (const juce::var& args)
{
    if (! eng.hasAudio()) return errResult ("set_input_monitor", "no audio session");
    const bool on = (bool) args.getProperty ("on", false);
    int touched = 0;
    for (auto* dev : eng.engine().getDeviceManager().getWaveInputDevices())
        if (dev != nullptr)
        {
            dev->setMonitorMode (on ? te::InputDevice::MonitorMode::on
                                    : te::InputDevice::MonitorMode::automatic);
            ++touched;
        }
    if (touched == 0) return errResult ("set_input_monitor", "no wave input device");
    logLine ("set_input_monitor", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("set_input_monitor");
}

juce::var MoshOps::cmdSetCountIn (const juce::var& args)
{
    const int bars = juce::jlimit (0, 2, (int) args.getProperty ("bars", 0));
    eng.edit().setCountInMode (bars == 0 ? te::Edit::CountIn::none
                               : bars == 1 ? te::Edit::CountIn::oneBar
                                           : te::Edit::CountIn::twoBar);
    logLine ("set_count_in", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("set_count_in");
}

juce::var MoshOps::cmdListAudioOutputs (const juce::var&)
{
    Array<var> devices;
    for (auto& name : eng.listAudioOutputDevices())
    {
        auto* d = new DynamicObject();
        d->setProperty ("name", name);
        d->setProperty ("virtualSink", MoshEngine::looksLikeVirtualSink (name));
        devices.add (var (d));
    }
    auto* data = new DynamicObject();
    data->setProperty ("devices", devices);
    data->setProperty ("current", eng.currentAudioOutputDevice());
    data->setProperty ("warning", eng.audioDeviceWarning());
    return okResult ("list_audio_outputs", var (data));
}

juce::var MoshOps::cmdSetAudioOutput (const juce::var& args)
{
    const auto device = args.getProperty ("device", var()).toString().trim();
    if (device.isEmpty()) return errResult ("set_audio_output", "missing 'device'");

    // Machine-local preference — never an edit mutation, never undoable, never
    // synced or recorded (a collaborator's speakers are not session state).
    eng.edit().getTransport().stop (false, false);
    if (auto err = eng.setAudioOutputDevice (device); err.isNotEmpty())
        return errResult ("set_audio_output", err);

    logLine ("set_audio_output", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("current", eng.currentAudioOutputDevice());
    return okResult ("set_audio_output", var (data));
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

    // `index` is a VISIBLE index (meter taps don't count) — map to the raw list.
    const int vIndex = (int) args.getProperty ("index", -1);
    auto vis = visiblePlugins (*track);
    const int rawIndex = (vIndex < 0 || vIndex >= vis.size())
                             ? track->pluginList.getPlugins().size()
                             : track->pluginList.indexOf (vis[vIndex]);
    track->pluginList.insertPlugin (plugin, rawIndex, nullptr);
    ensureMeterLast (*track);

    auto* data = new DynamicObject();
    data->setProperty ("index", visiblePluginIndex (*track, plugin.get()));
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
    auto vis = visiblePlugins (*track);
    if (from < 0 || from >= vis.size()) return errResult ("reorder_plugin", "bad index");

    te::Plugin::Ptr p = vis[from];
    undoManager().beginNewTransaction ("reorder_plugin");
    p->removeFromParent();
    auto vis2 = visiblePlugins (*track);
    const int rawTo = (to < 0 || to >= vis2.size())
                          ? track->pluginList.getPlugins().size()
                          : track->pluginList.indexOf (vis2[to]);
    track->pluginList.insertPlugin (p, rawTo, nullptr);
    ensureMeterLast (*track);
    logLine ("reorder_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("reorder_plugin");
}

juce::var MoshOps::cmdSetPluginParam (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("set_plugin_param", "no plugin");

    // Two-tier addressing (phase0 §3.4): semantic name (preferred) or raw index.
    te::AutomatableParameter::Ptr param;
    if (const auto pname = args.getProperty ("paramName", var()).toString(); pname.isNotEmpty())
    {
        param = findParamByName (*plugin, pname);
        if (param == nullptr)
            return errResult ("set_plugin_param", "no param named: " + pname);
    }
    else
    {
        const int pi = (int) args.getProperty ("paramIndex", -1);
        if (pi < 0 || pi >= plugin->getNumAutomatableParameters())
            return errResult ("set_plugin_param", "bad paramIndex");
        param = plugin->getAutomatableParameter (pi);
    }
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

    const int vIndex = (int) args.getProperty ("index", -1);
    auto vis = visiblePlugins (*track);
    const int rawIndex = (vIndex < 0 || vIndex >= vis.size())
                             ? track->pluginList.getPlugins().size()
                             : track->pluginList.indexOf (vis[vIndex]);
    track->pluginList.insertPlugin (plugin, rawIndex, nullptr);
    ensureMeterLast (*track);

    auto* data = new DynamicObject();
    data->setProperty ("index", visiblePluginIndex (*track, plugin.get()));
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
    // Deterministic layer ids (phase0 §4 req 1): a per-edit counter persisted in
    // session state — NEVER wall-clock, which breaks replay hash equality.
    auto moshSession = eng.edit().state.getOrCreateChildWithName (Identifier ("MOSH_SESSION"), nullptr);
    const int rlSeq = (int) moshSession.getProperty ("nextRenderLayerSeq", 1);
    moshSession.setProperty ("nextRenderLayerSeq", rlSeq + 1, nullptr);
    auto node = RenderLayer::create ("rl-" + String (rlSeq),
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

    // Stems (Stage 30): one file per track, rendered via tracksToDo bits.
    if ((bool) args.getProperty ("stems", false))
    {
        juce::WavAudioFormat wavFormat;
        auto stemDir = file.getParentDirectory()
                           .getChildFile (file.getFileNameWithoutExtension() + "-stems");
        stemDir.createDirectory();
        auto tracks = te::getAudioTracks (edit);
        Array<var> files;
        for (int i = 0; i < tracks.size(); ++i)
        {
            auto* tr = tracks[i];
            if (tr == nullptr || tr->getClips().isEmpty()) continue;
            te::Renderer::Parameters params (edit);
            auto stemFile = stemDir.getChildFile (
                juce::File::createLegalFileName (String (i + 1) + "-"
                    + (tr->getName().isNotEmpty() ? tr->getName() : "track")) + ".wav");
            stemFile.deleteFile();
            params.destFile = stemFile;
            params.audioFormat = &wavFormat;
            params.bitDepth = juce::jlimit (16, 32, (int) args.getProperty ("bitDepth", 24));
            params.sampleRateForAudio = juce::jmax (22050.0, (double) args.getProperty ("sampleRate", 48000.0));
            params.time = { tracktion::TimePosition(), tracktion::TimePosition::fromSeconds (len) };
            juce::BigInteger one;
            one.setBit (te::getAllTracks (edit).indexOf (tr));
            params.tracksToDo = one;
            auto out = te::Renderer::renderToFile ("Mosh stem", params);
            if (out.existsAsFile() && out.getSize() > 0)
                files.add (out.getFullPathName());
        }
        if (files.isEmpty())
            return errResult ("export_audio", "no stems rendered (empty tracks?)");
        logLine ("export_audio", args, true, {}, false);
        auto* data = new DynamicObject();
        data->setProperty ("stemDir", stemDir.getFullPathName());
        data->setProperty ("files", files);
        return okResult ("export_audio", var (data));
    }

    // Export options (Stage 21): sample rate / bit depth / loop-range render
    // via the full Parameters path; the simple whole-edit overload otherwise.
    bool ok = false;
    if (args.hasProperty ("sampleRate") || args.hasProperty ("bitDepth") || args.hasProperty ("loopOnly"))
    {
        juce::WavAudioFormat wavFormat;
        te::Renderer::Parameters params (edit);
        params.destFile = file;
        params.audioFormat = &wavFormat;
        // The field comment says "empty = all tracks" but the implementation
        // requires set bits (the simple overload passes all tracks explicitly).
        params.tracksToDo = te::toBitSet (te::getAllTracks (edit));
        params.bitDepth = juce::jlimit (16, 32, (int) args.getProperty ("bitDepth", 24));
        params.sampleRateForAudio = juce::jmax (22050.0, (double) args.getProperty ("sampleRate", 48000.0));
        if ((bool) args.getProperty ("loopOnly", false) && edit.getTransport().looping.get())
            params.time = edit.getTransport().getLoopRange();
        else
            params.time = { tracktion::TimePosition(), tracktion::TimePosition::fromSeconds (len) };
        auto out = te::Renderer::renderToFile ("Mosh export", params);
        ok = out.existsAsFile() && out.getSize() > 0;
    }
    else
    {
        // Synchronous whole-edit render (useThread=false blocks until the file
        // is written).
        ok = te::Renderer::renderToFile (edit, file, false)
             && file.existsAsFile() && file.getSize() > 0;
    }

    logLine ("export_audio", args, ok, ok ? String() : String ("render produced no file"), false);
    if (! ok) return errResult ("export_audio", "export render failed");

    // Compressed formats (Stage 27): render WAV, then hand off to the system
    // encoders — lame for MP3 (homebrew), afconvert for M4A/AAC (built-in).
    const auto format = args.getProperty ("format", "wav").toString().toLowerCase();
    if (format == "mp3" || format == "m4a")
    {
        auto out = file.withFileExtension (format);
        out.deleteFile();
        juce::ChildProcess enc;
        bool started = false;
        if (format == "mp3")
        {
            juce::File lame ("/opt/homebrew/bin/lame");
            if (! lame.existsAsFile()) lame = juce::File ("/usr/local/bin/lame");
            if (! lame.existsAsFile())
                return errResult ("export_audio", "mp3 needs lame (brew install lame); m4a works without it");
            started = enc.start (juce::StringArray { lame.getFullPathName(), "-b", "320",
                                                     file.getFullPathName(), out.getFullPathName() });
        }
        else
        {
            started = enc.start (juce::StringArray { "/usr/bin/afconvert", "-f", "m4af", "-d", "aac",
                                                     file.getFullPathName(), out.getFullPathName() });
        }
        if (! started || ! enc.waitForProcessToFinish (60000) || ! out.existsAsFile() || out.getSize() == 0)
            return errResult ("export_audio", format + " encode failed");
        file.deleteFile();   // the WAV was an intermediate
        file = out;
    }

    auto* data = new DynamicObject();
    data->setProperty ("file", file.getFullPathName());
    data->setProperty ("bytes", (juce::int64) file.getSize());
    data->setProperty ("seconds", len);
    return okResult ("export_audio", var (data));
}

te::AudioTrack* MoshOps::createAudioTrack (const juce::String& name)
{
    auto& edit = eng.edit();
    auto track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr, false);
    if (track == nullptr)
        return nullptr;

    if (name.isNotEmpty())
        track->setName (name);

    ensureTrackMeter (*track);   // every track ships its tap (hash/snapshot skip type "level")

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
        ensureMeterLast (track);    // the tap stays post-fader
        return dynamic_cast<te::VolumeAndPanPlugin*> (plugin.get());
    }

    return nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine-output meters (Stage 14). One te::LevelMeterPlugin on the master
// chain and one per audio track; LevelMeasurer only measures while a Client is
// registered, so the 30 Hz timer keeps one client per meter and polls them
// into the transport event. Excluded from the canonical hash + snapshot rack.
// ─────────────────────────────────────────────────────────────────────────────
te::LevelMeterPlugin* MoshOps::ensureMasterMeter()
{
    auto& edit = eng.edit();
    if (auto* existing = edit.getMasterPluginList().getPluginsOfType<te::LevelMeterPlugin>().getLast())
        return existing;

    if (auto plugin = edit.getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {}))
    {
        edit.getMasterPluginList().insertPlugin (plugin, -1, nullptr);
        return dynamic_cast<te::LevelMeterPlugin*> (plugin.get());
    }
    return nullptr;
}

te::LevelMeterPlugin* MoshOps::ensureTrackMeter (te::AudioTrack& track)
{
    if (auto* existing = track.pluginList.getPluginsOfType<te::LevelMeterPlugin>().getLast())
        return existing;

    if (auto plugin = eng.edit().getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {}))
    {
        track.pluginList.insertPlugin (plugin, -1, nullptr);
        return dynamic_cast<te::LevelMeterPlugin*> (plugin.get());
    }
    return nullptr;
}

juce::Array<te::Plugin*> MoshOps::visiblePlugins (te::AudioTrack& track)
{
    juce::Array<te::Plugin*> out;
    for (auto* p : track.pluginList.getPlugins())
        if (p != nullptr && p->getPluginType() != te::LevelMeterPlugin::xmlTypeName)
            out.add (p);
    return out;
}

int MoshOps::visiblePluginIndex (te::AudioTrack& track, te::Plugin* plugin)
{
    return visiblePlugins (track).indexOf (plugin);
}

void MoshOps::ensureMeterLast (te::AudioTrack& track)
{
    auto* meter = track.pluginList.getPluginsOfType<te::LevelMeterPlugin>().getLast();
    if (meter == nullptr)
    {
        ensureTrackMeter (track);     // appends at the end
        return;
    }
    auto plugins = track.pluginList.getPlugins();
    if (! plugins.isEmpty() && plugins.getLast().get() == meter)
        return;
    te::Plugin::Ptr keep (meter);
    keep->removeFromParent();
    track.pluginList.insertPlugin (keep, -1, nullptr);   // index<0 appends (engine source)
}

void MoshOps::adoptEditMeters()
{
    // Unregister from the previous edit's measurers FIRST — graph nodes keep
    // meter plugins alive past their edit, and a measurer must never hold a
    // pointer to a destroyed client (guard-malloc-proven UAF otherwise).
    releaseAllMeterClients();
    meterEdit = &eng.edit();

    bool inserted = meterEdit->getMasterPluginList().getPluginsOfType<te::LevelMeterPlugin>().isEmpty();
    ensureMasterMeter();
    for (auto* t : te::getAudioTracks (*meterEdit))
        if (t != nullptr && t->pluginList.getPluginsOfType<te::LevelMeterPlugin>().isEmpty())
        {
            inserted = true;
            ensureTrackMeter (*t);
        }

    // Adoption only happens on fresh edits (construction, reload, resetEmpty)
    // whose undo history is empty; meter insertion must never become the
    // user's first undoable step.
    if (inserted)
        meterEdit->getUndoManager().clearUndoHistory();
}

juce::var MoshOps::meterLevels()
{
    std::map<juce::String, bool> seen;

    auto read = [this, &seen] (te::LevelMeterPlugin& meter) -> juce::var
    {
        const auto key = meter.itemID.toString();
        seen[key] = true;
        auto& mc = meterClients[key];
        if (mc.client == nullptr)
        {
            mc.plugin = &meter;     // refcounted — keeps the measurer reachable
            mc.client = std::make_unique<te::LevelMeasurer::Client>();
            meter.measurer.addClient (*mc.client);
        }
        juce::Array<var> lr;
        lr.add (juce::roundToInt (mc.client->getAndClearAudioLevel (0).dB * 10.0f) / 10.0);
        lr.add (juce::roundToInt (mc.client->getAndClearAudioLevel (1).dB * 10.0f) / 10.0);
        return lr;
    };

    auto* o = new DynamicObject();
    if (auto* mm = eng.edit().getMasterPluginList().getPluginsOfType<te::LevelMeterPlugin>().getLast())
        o->setProperty ("master", read (*mm));

    auto* trackLevels = new DynamicObject();
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* m = t->pluginList.getPluginsOfType<te::LevelMeterPlugin>().getLast())
                trackLevels->setProperty (t->itemID.toString(), read (*m));
    o->setProperty ("tracks", var (trackLevels));

    // Prune clients whose meter left the edit — unregister through the held
    // Plugin::Ptr first (the plugin may still be alive inside a graph node).
    for (auto it = meterClients.begin(); it != meterClients.end();)
    {
        if (seen.count (it->first) > 0) { ++it; continue; }
        releaseMeterClient (it->second);
        it = meterClients.erase (it);
    }

    return var (o);
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

    // Mixer surfaces (Stage 17): sends/returns carry their bus + gain; any
    // plugin keyed from another track exposes its sidechain source.
    if (auto* send = dynamic_cast<te::AuxSendPlugin*> (&p))
    {
        o->setProperty ("busNumber", send->getBusNumber());
        o->setProperty ("gainDb", send->getGainDb());
    }
    if (auto* ret = dynamic_cast<te::AuxReturnPlugin*> (&p))
        o->setProperty ("busNumber", ret->busNumber.get());
    if (p.getSidechainSourceID().isValid())
        o->setProperty ("sidechainSourceId", p.getSidechainSourceID().toString());

    // Sampler pads (Stage 14): the drum-rack panel needs the loaded sounds.
    if (auto* sp = dynamic_cast<te::SamplerPlugin*> (&p))
    {
        Array<var> sounds;
        for (int i = 0; i < sp->getNumSounds(); ++i)
        {
            auto* so = new DynamicObject();
            so->setProperty ("name", sp->getSoundName (i));
            so->setProperty ("keyNote", sp->getKeyNote (i));
            so->setProperty ("minNote", sp->getMinKey (i));
            so->setProperty ("maxNote", sp->getMaxKey (i));
            sounds.add (var (so));
        }
        o->setProperty ("sounds", sounds);
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

    // Tempo map (Stage 28): every tempo setting with its bar + wall-time —
    // the UI's piecewise ruler/snap math reads exactly this. NOT in the
    // canonical hash beyond the base tempo (hash-v2 parked, like master vol).
    {
        Array<var> tmap;
        auto& seq = edit.tempoSequence;
        auto& ts0 = seq.getTimeSigAt (tracktion::TimePosition());
        const double beatsPerBar = ts0.numerator.get() * 4.0 / ts0.denominator.get();
        for (int i = 0; i < seq.getNumTempos(); ++i)
            if (auto* t = seq.getTempo (i))
            {
                auto* e = new DynamicObject();
                e->setProperty ("bar", 1 + (int) std::lround (t->getStartBeat().inBeats() / beatsPerBar));
                e->setProperty ("beat", t->getStartBeat().inBeats());
                e->setProperty ("bpm", t->getBpm());
                e->setProperty ("timeSec", seq.toTime (t->getStartBeat()).inSeconds());
                tmap.add (var (e));
            }
        session->setProperty ("tempoMap", tmap);
    }
    session->setProperty ("editFile", eng.editFile().getFullPathName());

    // Stage 14: device truth in the UI (rung 1's silence was a BlackHole
    // default output nobody could see).
    session->setProperty ("hasAudio", eng.hasAudio());
    session->setProperty ("audioOutputDevice", eng.currentAudioOutputDevice());
    session->setProperty ("audioInputDevice", eng.currentAudioInputDevice());
    // Stage 25: monitoring + count-in state.
    {
        bool mon = false;
        if (eng.hasAudio())
            for (auto* dev : eng.engine().getDeviceManager().getWaveInputDevices())
                if (dev != nullptr && dev->getMonitorMode() == te::InputDevice::MonitorMode::on)
                    mon = true;
        session->setProperty ("inputMonitor", mon);
        const auto ci = edit.getCountInMode();
        session->setProperty ("countInBars", ci == te::Edit::CountIn::oneBar ? 1
                                            : ci == te::Edit::CountIn::twoBar ? 2 : 0);
    }

    // Stage 26: the named project this session was last saved-as/opened-from.
    session->setProperty ("projectName",
        eng.sessionDir().getChildFile ("project-name.txt").loadFileAsString().trim());

    // Stage 15: master fader + metronome state.
    if (auto mv = edit.getMasterVolumePlugin())
        session->setProperty ("masterVolumeDb", mv->getVolumeDb());
    session->setProperty ("metronome", edit.clickTrackEnabled.get());
    if (eng.audioDeviceWarning().isNotEmpty())
        session->setProperty ("audioWarning", eng.audioDeviceWarning());
    if (eng.audioDeviceError().isNotEmpty())
        session->setProperty ("audioError", eng.audioDeviceError());

    // Stage 7: musical context (tempo map start, key, sections).
    auto& timeSig = edit.tempoSequence.getTimeSigAt (tracktion::TimePosition());
    session->setProperty ("timeSigNumerator", timeSig.numerator.get());
    session->setProperty ("timeSigDenominator", timeSig.denominator.get());
    if (auto moshSession = edit.state.getChildWithName (juce::Identifier ("MOSH_SESSION")); moshSession.isValid())
    {
        session->setProperty ("keyRoot", moshSession.getProperty ("keyRoot", ""));
        session->setProperty ("keyScale", moshSession.getProperty ("keyScale", ""));
    }
    Array<var> sections;
    if (auto arrange = edit.state.getChildWithName (juce::Identifier ("MOSH_ARRANGE")); arrange.isValid())
        for (int i = 0; i < arrange.getNumChildren(); ++i)
        {
            auto s = arrange.getChild (i);
            auto* so = new DynamicObject();
            so->setProperty ("name", s.getProperty ("name"));
            so->setProperty ("startBar", (int) s.getProperty ("startBar"));
            so->setProperty ("lengthBars", (int) s.getProperty ("lengthBars"));
            sections.add (var (so));
        }
    session->setProperty ("sections", sections);

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

    // Plugin chain (Stage 3), in VISIBLE-index space (Stage 14): the meter tap
    // is observability, not a device — it never appears and never occupies an
    // index, so these indices round-trip through every plugin command.
    juce::Array<var> plugins;
    auto vis = visiblePlugins (t);
    for (int i = 0; i < vis.size(); ++i)
        plugins.add (pluginToVar (*vis[i], i));
    o->setProperty ("plugins", plugins);

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

    // Recording (Stage 19): armed = any input instance record-enabled for us.
    bool armed = false;
    for (auto* inst : eng.edit().getAllInputDevices())
        if (inst != nullptr && inst->isRecordingEnabled (t.itemID))
            armed = true;
    o->setProperty ("armed", armed);

    // Routing (Stage 17): destination track id, or "" for the master/device.
    if (auto* dest = t.getOutput().getDestinationTrack())
        o->setProperty ("routeTo", dest->itemID.toString());
    else
        o->setProperty ("routeTo", "");
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
        // Inspector fields (Stage 24).
        o->setProperty ("pitchSemis", w->getPitchChange());
        o->setProperty ("speedRatio", w->getSpeedRatio());
        o->setProperty ("gainDb", w->getGainDB());
        o->setProperty ("reversed", w->getIsReversed());
        o->setProperty ("loopBeats", w->getLoopRangeBeats().getLength().inBeats());
        o->setProperty ("fadeInSec", w->getFadeIn().inSeconds());
        o->setProperty ("fadeOutSec", w->getFadeOut().inSeconds());
        o->setProperty ("autoCrossfade", w->getAutoCrossfade());
    }
    else if (auto* mc = dynamic_cast<te::MidiClip*> (&c))
    {
        o->setProperty ("type", "midi");
        // Notes inline (Stage 14): the clip preview + drum-rack step grid read
        // these. Capped at 512 like the external-param cap — tutorial patterns
        // are tiny; a full piano-roll fetch can become its own command later.
        Array<var> notes;
        int count = 0;
        for (auto* n : mc->getSequence().getNotes())
        {
            if (n == nullptr) continue;
            if (count++ >= 512) break;
            auto* no = new DynamicObject();
            no->setProperty ("pitch", n->getNoteNumber());
            no->setProperty ("startBeats", n->getStartBeat().inBeats());
            no->setProperty ("durBeats", n->getLengthBeats().inBeats());
            no->setProperty ("vel", n->getVelocity());
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
    // Visible-index space (Stage 14): the meter tap never occupies an index.
    auto* track = findTrack (trackId);
    if (track == nullptr) return nullptr;
    auto plugins = visiblePlugins (*track);
    return (index >= 0 && index < plugins.size()) ? plugins[index] : nullptr;
}

te::MidiClip* MoshOps::findMidiClip (const juce::String& id)
{
    return dynamic_cast<te::MidiClip*> (findClip (id));
}

te::AutomatableParameter::Ptr MoshOps::findParamByName (te::Plugin& p, const juce::String& name)
{
    // Semantic addressing (phase0 §3.4): exact (case-insensitive) match wins,
    // else first contains-match, else common producer aliases — engine param
    // names are version-fragile, the semantic names are the corpus's.
    auto scan = [&p] (const juce::String& want) -> te::AutomatableParameter::Ptr
    {
        te::AutomatableParameter::Ptr partial;
        for (int i = 0; i < p.getNumAutomatableParameters(); ++i)
        {
            auto param = p.getAutomatableParameter (i);
            const auto have = param->getParameterName().toLowerCase();
            if (have == want) return param;
            if (partial == nullptr && have.contains (want)) partial = param;
        }
        return partial;
    };

    const auto want = name.toLowerCase();
    if (auto direct = scan (want)) return direct;

    static const std::map<juce::String, juce::StringArray> aliases = {
        { "cutoff",    { "frequency", "freq" } },
        { "resonance", { "q", "res" } },
        { "volume",    { "level", "gain" } },
        { "time",      { "delay", "length" } },
        { "mix",       { "wet", "amount" } },
    };
    if (auto it = aliases.find (want); it != aliases.end())
        for (const auto& alt : it->second)
            if (auto param = scan (alt.toLowerCase())) return param;
    return nullptr;
}

double MoshOps::beatsToSeconds (double beats)
{
    return eng.edit().tempoSequence.toTime (tracktion::BeatPosition::fromBeats (beats)).inSeconds();
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
