#include <algorithm>
#include <cmath>
#include "MoshOps.h"
#include "moshops/RecoveryIds.h"
#include "files/DirectoryListing.h"
#include "MoshOpsInternal.h"
#include "AgentMemoryStore.h"
#include "DrumPattern.h"
#include "AutomationMode.h"
#include "AutomationCurveWrite.h"
#include "ClipGainEnvelope.h"
#include "ExportRange.h"
#include "ScanProgress.h"
#include "StemExport.h"
#include "engine/SourceRef.h"
#include "engine/RenderArtifacts.h"
#include "state/Ids.h"
#include "state/RenderLayer.h"
#include "state/Migrations.h"
#include "state/SafeMode.h"
#include "state/CountIn.h"
#include "state/Section.h"
#include "state/Annotation.h"
#include "state/Lyrics.h"
#include "multiplayer/LogicalId.h"
#include "multiplayer/TrackCommit.h"
#include "plugins/moshfx/MoshFxPlugins.h"
#if MOSH_HAVE_ANIRA
 #include "plugins/transform/RaveInsertPlugin.h"
#endif
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
    juce::var feedbackCandidatesToVar (const std::vector<moshfx::FeedbackCandidate>& candidates,
                                       bool includeDepth)
    {
        juce::Array<juce::var> arr;
        for (const auto& c : candidates)
        {
            auto* o = new juce::DynamicObject();
            o->setProperty ("frequencyHz", c.frequencyHz);
            o->setProperty ("score", c.score);
            if (includeDepth)
                o->setProperty ("depthDb", c.depthDb);
            arr.add (juce::var (o));
        }
        return juce::var (arr);
    }

    std::vector<float> readXFeedbackPreviewSamples (te::AudioTrack& track, double& sampleRate)
    {
        sampleRate = 0.0;
        for (auto* clip : track.getClips())
            if (auto* wave = dynamic_cast<te::WaveAudioClip*> (clip))
            {
                juce::AudioFormatManager fm;
                fm.registerBasicFormats();
                std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (wave->getCurrentSourceFile()));
                if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0)
                    continue;

                const int samples = juce::jlimit (0, 16384, (int) reader->lengthInSamples);
                juce::AudioBuffer<float> buffer (1, samples);
                if (! reader->read (&buffer, 0, samples, 0, true, true))
                    continue;

                sampleRate = reader->sampleRate;
                std::vector<float> out ((size_t) samples);
                std::copy (buffer.getReadPointer (0), buffer.getReadPointer (0) + samples, out.begin());
                return out;
            }

        return {};
    }

    juce::var xFeedbackPreviewReadout (te::AudioTrack& track, te::Plugin& plugin)
    {
        auto normParam = [&plugin] (int index, float fallback)
        {
            if (auto p = plugin.getAutomatableParameter (index))
                return p->getCurrentNormalisedValue();
            return fallback;
        };

        moshfx::XFeedbackSettings settings;
        settings.sensitivity = normParam (0, 0.65f);
        settings.maxCuts = juce::jlimit (1, 4, juce::roundToInt (1.0f + normParam (1, 1.0f / 3.0f) * 3.0f));
        settings.maxDepthDb = 3.0f + normParam (2, 15.0f / 33.0f) * 33.0f;
        settings.autoSuppress = normParam (4, 0.0f) >= 0.5f;

        double sampleRate = 0.0;
        auto samples = readXFeedbackPreviewSamples (track, sampleRate);
        auto candidates = moshfx::detectFeedbackCandidates (samples.data(), (int) samples.size(), sampleRate, settings);

        auto* o = new juce::DynamicObject();
        o->setProperty ("kind", "feedback");
        o->setProperty ("candidates", feedbackCandidatesToVar (candidates, false));
        o->setProperty ("activeCuts", settings.autoSuppress ? feedbackCandidatesToVar (candidates, true)
                                                            : juce::var (juce::Array<juce::var>()));
        return juce::var (o);
    }

    bool isGeneratedRecipeCommandAllowed (const juce::String& name)
    {
        return name == "set_tempo"
            || name == "set_key"
            || name == "set_time_signature"
            || name == "create_track"
            || name == "assign_sample"
            || name == "add_midi_clip"
            || name == "import_clip";
    }

    bool generatedRecipeRefName (const juce::String& value, juce::String& name)
    {
        if (value.startsWith ("${") && value.endsWithChar ('}') && value.length() > 3)
        {
            name = value.substring (2, value.length() - 1);
            return name.isNotEmpty();
        }
        return false;
    }

    juce::var resolveGeneratedRecipeRefs (const juce::var& value, const juce::NamedValueSet& refs,
                                          juce::StringArray& missing)
    {
        if (value.isString())
        {
            juce::String name;
            const auto s = value.toString();
            if (generatedRecipeRefName (s, name))
            {
                if (const auto* found = refs.getVarPointer (juce::Identifier (name)))
                    return *found;
                missing.add (s);
            }
            return value;
        }

        if (auto* arr = value.getArray())
        {
            juce::Array<juce::var> out;
            for (auto& item : *arr)
                out.add (resolveGeneratedRecipeRefs (item, refs, missing));
            return juce::var (out);
        }

        if (auto* obj = value.getDynamicObject())
        {
            auto* out = new juce::DynamicObject();
            auto& props = obj->getProperties();
            for (int i = 0; i < props.size(); ++i)
            {
                const auto name = props.getName (i);
                out->setProperty (name, resolveGeneratedRecipeRefs (props.getValueAt (i), refs, missing));
            }
            return juce::var (out);
        }

        return value;
    }

    void captureGeneratedRecipeRefs (const juce::var& call, const juce::var& result,
                                     juce::NamedValueSet& refs)
    {
        auto data = result.getProperty ("data", juce::var());
        if (! data.isObject())
            return;

        auto capture = call.getProperty ("capture", juce::var());
        if (auto* obj = capture.getDynamicObject())
        {
            auto& props = obj->getProperties();
            for (int i = 0; i < props.size(); ++i)
            {
                const auto name = props.getName (i);
                auto value = data.getProperty (props.getValueAt (i).toString(), juce::var());
                if (! value.isVoid())
                    refs.set (name, value);
            }
        }

        const auto bind = call.getProperty ("bind", juce::var()).toString();
        if (bind.isNotEmpty())
        {
            auto value = data.getProperty ("trackId", juce::var());
            if (value.isVoid()) value = data.getProperty ("clipId", juce::var());
            if (value.isVoid()) value = data.getProperty ("id", juce::var());
            if (! value.isVoid())
                refs.set (juce::Identifier (bind), value);
        }
    }
}

MoshOps::MoshOps (MoshEngine& engineToUse)
    : eng (engineToUse), pluginHost (engineToUse.engine()),
      trainerRegistry (engineToUse.sessionDir())
{
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    // CAP-PRJ-005 — a per-process token scoping every history stamp. mosh-log.jsonl
    // outlives the process; the UndoManager does not. Without this, a line stamped
    // "txn 3" by yesterday's session would look like a reachable point today and
    // restore the producer somewhere they never were.
    historyToken_ = juce::Uuid().toDashedString().upToFirstOccurrenceOf ("-", false, false);
    invalidateCommandLogCache();
    initRecoveryJournal();                    // A3 — read a crashed tail into memory, then start fresh
    initTxnLedger();                          // FS-B2a — surface a crash-orphaned agent transaction
    pluginHost.initialise();                 // formats + curated VST3 scan
    previewFormats.registerBasicFormats();   // audition (file preview) reader formats
    // Live-note audition: we ARE the wasted-message listener, registered for our whole
    // lifetime and read around each individual injection (see MoshOps.Live.cpp).
    eng.edit().addWastedMidiMessagesListener (this);
    startTimerHz (30);                       // telemetry decimated to 30 Hz, never per-block

    // MP-001 — the live session. Its background poll loop calls back here (on the
    // message thread) to apply peer commits, feed the lock guard, and push presence
    // to the WebView. No relay echo: a remote apply repaints locally only.
    mpSession_ = std::make_unique<MultiplayerSession> (
        [this] (const juce::var& msg) { applyMultiplayerCommitMessage (msg); },
        [this] (const juce::String& type, juce::var payload) { emit (type, payload); },
        [this] (bool active, const juce::String& self, const std::map<juce::String, juce::String>& locks)
        {
            if (active) { lockManager_.activate (self); lockManager_.setLocks (locks); }
            else        { lockManager_.deactivate(); }
        },
        // PR-2: the message-thread part ONLY (content-address + serialize; NO
        // upload) -- the session's own worker uploads the returned stemFiles[]
        // before publishing bootstrap_state. cmdMpSerializeProject (the public,
        // directly-callable command) is UNCHANGED and keeps uploading synchronously
        // itself, so existing direct-call tests stay valid.
        [this] { return serializeProjectForBootstrapAnswer(); },   // provide
        [this] (const juce::var& bundle) { return validateBootstrapBundle (bundle); },  // preflight
        [this] (const juce::var& bundle)
        {
            auto* command = new DynamicObject();
            command->setProperty ("command", "mp_apply_bootstrap");
            command->setProperty ("args", bundle);
            return execute (var (command));
        },                                                                              // adopt
        [this] (const juce::var& msg) { cmdMpApplyStructural (msg); });                 // structural
    refreshMpStemDir();
}

MoshOps::~MoshOps()
{
    // Editor parameter mirrors capture this MoshOps instance. Cancel any in-flight
    // gesture and detach the listeners before other MoshOps members are destroyed.
    // MainWindow/the WebView bridge is already gone at this point, so teardown must not
    // flush a late editor callback into the event sink. Ordinary editor close still does.
    pluginHost.closeAllEditors();
    stopTimer();
    unregisterAllMeterClients();       // balances addClient() for the per-track meter taps only —
                                        // masterClient is a separate registration (see below)
    // masterClient (line ~736's ctx->masterLevels.addClient) is never balanced by the
    // per-track path above. Main.cpp's shutdown() destroys MoshOps BEFORE the engine
    // (moshOps.reset() precedes engine.reset()), so if a playback context is still
    // live here (quit-while-playing), its master LevelMeasurer keeps a raw pointer to
    // masterClient — which is about to be freed with the rest of `this`. The audio
    // thread would then write through that dangling pointer on the next block. Mirror
    // the addClient bookkeeping (lastSeenContext tracks exactly the context we last
    // registered with, and is nulled out everywhere the context is freed) to remove it
    // here while the context — and `this` — are both still valid.
    if (lastSeenContext != nullptr)
    {
        lastSeenContext->masterLevels.removeClient (masterClient);
        lastSeenContext = nullptr;
    }
    if (previewWired) adm().removeAudioCallback (&previewPlayer);   // stop audio-thread access first
    stopAudition();
    // Silence anything the keyboard/piano roll left sounding, then detach the listener.
    // Order matters: releaseAllVoices injects, which can call back into us, so we must
    // still be registered while it runs — and must not stay registered on the Edit, which
    // Main.cpp destroys after this object.
    releaseAllVoices();
    eng.edit().removeWastedMidiMessagesListener (this);
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

    // Live-note safety net. Force-release any voice past its own TTL — which covers both
    // a blip's short lifetime and a held note whose note-off never arrived (WebView crash,
    // frozen page, dropped event). Running it here means it lives in the native process
    // and survives anything the UI does; it is a no-op when nothing is held.
    sweepStuckVoices();

    // REC-002 — publish the "Mosh Keyboard" virtual MIDI input as soon as audio comes up,
    // so it is in the track input picker BEFORE the producer goes looking for it. Doing
    // this lazily (on the first audition) would mean the picker was empty exactly when
    // someone was trying to work out how to record their keyboard. Guarded internally, so
    // this is a bool test on every tick after the first.
    if (eng.hasAudio())
        ensureKeyboardInputDevice();

    // Lane A — drive the render-ahead scheduler off the transport clock while a Live clip plays.
    // Gated on hasAudio() so headless --selftest (which never arms it) is untouched.
    if (renderAhead_.active && playing && eng.hasAudio())
        renderAheadTick (transport.getPosition().inSeconds());

    if (mpSession_ != nullptr && mpSession_->active())
    {
        const auto nowMs = Time::getMillisecondCounterHiRes();
        if (nowMs - lastPresenceBroadcastMs >= 250.0)
        {
            lastPresenceBroadcastMs = nowMs;
            mpSession_->broadcastPresence (transport.getPosition().inSeconds(),
                                           transport.isPlaying(),
                                           transport.isRecording());
        }
    }

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

    // CAP-AUT-006 — the mute button follows its curve. Same discipline as transport and
    // levels: a per-track rail OUTSIDE the snapshot, so a mute edge never re-creates the
    // snapshot object and re-renders the whole tree. Deliberately NOT folded into the
    // `levels` payload above — that one is gated on metering being enabled, and a
    // producer who turned meters off would silently get a mute button that stopped
    // following. Deliberately NOT gated on hasAudio() or on playing either: the curve is
    // evaluated from the transport position on the message thread, so the button is also
    // correct while the transport is parked mid-curve.
    {
        auto payload = muteAutomationAtPlayhead();
        const bool any = payload.getProperty ("tracks", var()).size() > 0;
        // Emit while anything is automated, plus exactly once on the falling edge — the
        // UI has to be told when the last curve went away, or a button would stay stuck
        // showing the state the vanished curve left behind.
        if (any || hadMuteAutomation)
            emit ("mute_automation", payload);
        hadMuteAutomation = any;
    }

    // Master spectral feed (Moshi reactivity). Only live with a real playback context
    // (an audio device) — headless / --selftest has none, so the tap is NEVER inserted
    // and the edit state is untouched. One zero on the play→stop edge so Moshi settles.
    const bool spectrumLive = playing && transport.getCurrentPlaybackContext() != nullptr;
    if (spectrumLive)            { emitSpectrum (true);  spectrumActive = true; }
    else if (spectrumActive)     { emitSpectrum (false); spectrumActive = false; }

    // FIT-003 — live running-count progress for an in-flight async plugin rescan.
    // cmdRescanPlugins' AU/deep branch sets scanSampling_ before spawning its detached
    // scan thread and clears it in that thread's callAsync completion; both of those
    // run on the message thread, same as this timer, so scanSampling_/scanFormat_/
    // scanStartMs_/lastScanCount_/lastScanEmitMs_ (all MoshOps-private) need no
    // synchronization. getNumTypes() itself IS a genuine cross-thread read: the
    // background scan thread concurrently mutates the SAME KnownPluginList via
    // addType()/scanAndAddFile() inside PluginHost::rescan(). That's safe because
    // KnownPluginList internally guards its type array with its own CriticalSection
    // (typesArrayLock in juce_KnownPluginList.h) — getNumTypes()/addType() both take
    // it, so this is an ordinary locked read, not a race. Decimated: emit only when
    // the catalog grew, or ~500 ms have passed, so a fast VST3 tail doesn't spam 30 Hz
    // and a stalled AU still ticks `elapsedMs` forward for the UI.
    if (scanSampling_)
    {
        const auto now = Time::getMillisecondCounterHiRes();
        const int count = eng.engine().getPluginManager().knownPluginList.getNumTypes();
        if (count != lastScanCount_ || (now - lastScanEmitMs_) >= 500.0)
        {
            lastScanCount_ = count;
            lastScanEmitMs_ = now;
            emit ("plugin_scan_progress",
                  makeScanProgressPayload (scanFormat_, count, /*done=*/false,
                                            (int) (now - scanStartMs_)));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::executeFromUi (const juce::var& command)
{
    const juce::ScopedValueSetter<bool> guard (
        projectEpochManagedByUi_,
        (bool) command.getProperty ("_moshProjectEpochPrepared", false));
    return execute (command);
}

juce::var MoshOps::execute (const juce::var& command)
{
    // FS-B2a — re-entrancy depth. execute() is re-entered from INSIDE handlers (the
    // multiplayer apply path, cmdSketchBeatbox, cmdGenerateBeatRecipe), so the
    // transaction guard must govern the OUTERMOST call only: a manifested composite
    // command's internal steps cannot each be expected to carry transaction metadata,
    // and requiring it would break both composites. A recovery replay is exempt for the
    // same reason.
    struct DepthGuard
    {
        explicit DepthGuard (int& d) : depth (d) { ++depth; }
        ~DepthGuard() { --depth; }
        int& depth;
    } depthGuard (execDepth_);

    const bool outermost = (execDepth_ == 1) && ! replayingRecovery_;

    if (outermost)
    {
        juce::var early;
        if (txnPreDispatch (command, early))
            return early;   // refused or replayed: no dispatch, no mutation, no journal
    }

    auto result = executeImpl (command);

    if (outermost)
        txnPostDispatch (result);

    // A3 — feed the crash-recovery journal (single chokepoint; skipped during a replay).
    if (! replayingRecovery_)
        appendRecoveryJournal (command.getProperty ("command", var()).toString(),
                               command.getProperty ("args", var()), result);
    return result;
}

juce::var MoshOps::executeFileBrowserReadOnly (const juce::File& sessionDir,
                                                const juce::var& command)
{
    const auto name = command.getProperty ("command", var()).toString();
    if (name != "list_directory")
        return errResult (name, "command is not safe for the file-browser worker");

    const auto args = command.getProperty ("args", var (new DynamicObject()));
    return okResult (name, directory_listing::buildData (sessionDir, args));
}

juce::var MoshOps::executeImpl (const juce::var& command)
{
    const auto name = command.getProperty ("command", var()).toString();
    const auto args = command.getProperty ("args", var (new DynamicObject()));

    if (name.isEmpty())
        return errResult (name, "missing 'command'");

    // MP-001 lock guard — the single chokepoint. When a multiplayer session is
    // active, reject any mutation to a track / clip / structure currently locked by
    // the OTHER peer. Multi-clip commands check every resolved affected track
    // (fail-closed: unclassified commands need the session lock).
    // No session => no-op, so single-player behaviour is unchanged. A REMOTE apply
    // (applyingRemote_) bypasses the guard — it is the peer's change landing, not a
    // local edit, so it must not be blocked by the peer's own lock.
    if (lockManager_.isActive() && ! applyingRemote_)
    {
        const auto scope = LockManager::classify (name);
        if (scope != LockManager::Scope::Unguarded)
        {
            for (const auto& key : lockKeysFor (scope, args))
            {
                const auto decision = lockManager_.decide (scope, key);
                if (! decision.allow)
                    return errResult (name, "blocked: " + decision.reason);
            }
        }
    }

    // FREEZE GUARD — one chokepoint, after the MP lock guard's own shape. A frozen
    // track (moshFrozen on its state) refuses clip-CONTENT and DEVICE mutations:
    // the track's audio is the rendered file and the chain is parked, so editing
    // either would silently change nothing audible. Whole-clip structure (move /
    // duplicate / remove / rename), mixer, and project ops stay allowed (Live's rule).
    {
        static const juce::StringArray frozenLocked {
            "add_note", "set_note", "remove_note", "quantize_notes", "transform_velocities", "transform_notes",
            "consolidate_clips", "crop_clip", "split_clip", "trim_clip", "set_clip_loop",
            "promote_take_region",
            "set_clip_gain", "write_clip_gain_curve", "set_clip_fade", "set_clip_reverse", "set_clip_crossfade",
            "normalize_clip", "set_clip_warp", "stretch_clip",
            "load_plugin", "load_builtin", "remove_plugin", "reorder_plugin",
            "set_plugin_param", "bypass_plugin", "open_plugin_editor",
            "set_track_automation_mode", "write_automation_curve",
            "add_automation_point", "set_automation_point", "remove_automation_point",
            "clear_automation", "replace_instrument", "hot_swap_instrument",
        };
        if (frozenLocked.contains (name))
        {
            auto isFrozen = [&] (te::Track* target) {
                return target != nullptr && target->state.hasProperty (ids::moshFrozen);
            };
            const auto tid = args.getProperty ("trackId", var()).toString();
            if (tid.isNotEmpty() && isFrozen (findTrack (tid)))
                return errResult (name, "track is frozen (unfreeze it first)");
            const auto cid = args.getProperty ("clipId", var()).toString();
            if (cid.isNotEmpty())
                if (auto* c = findClip (cid); isFrozen (c != nullptr ? c->getTrack() : nullptr))
                    return errResult (name, "track is frozen (unfreeze it first)");
            if (auto* clipIds = args.getProperty ("clipIds", var()).getArray())
                for (auto& id : *clipIds)
                    if (auto* c = findClip (id.toString()); isFrozen (c != nullptr ? c->getTrack() : nullptr))
                        return errResult (name, "track is frozen (unfreeze it first)");
        }
    }

    if (name == "create_track")      return cmdCreateTrack (args);
    if (name == "rename_track")      return cmdRenameTrack (args);
    if (name == "set_track_color")   return cmdSetTrackColor (args);
    if (name == "set_track_icon")    return cmdSetTrackIcon (args);
    if (name == "move_track")        return cmdMoveTrack (args);
    if (name == "create_section")    return cmdCreateSection (args);
    if (name == "rename_section")    return cmdRenameSection (args);
    if (name == "move_section")      return cmdMoveSection (args);
    if (name == "remove_section")    return cmdRemoveSection (args);
    if (name == "create_clip_group")  return cmdCreateClipGroup (args);
    if (name == "ungroup_clip_group") return cmdUngroupClipGroup (args);
    if (name == "regroup_clip_group") return cmdRegroupClipGroup (args);
    if (name == "rename_clip_group")  return cmdRenameClipGroup (args);
    // LYR-001 — Finish-My-Song lyric sheet (per-track).
    if (name == "create_lyric_sheet")   return cmdCreateLyricSheet (args);
    if (name == "remove_lyric_sheet")   return cmdRemoveLyricSheet (args);
    if (name == "set_lyric_constraint") return cmdSetLyricConstraint (args);
    if (name == "set_lyric_line")       return cmdSetLyricLine (args);
    if (name == "remove_lyric_line")    return cmdRemoveLyricLine (args);
    if (name == "get_rhymes")           return cmdGetRhymes (args);
    if (name == "complete_lyrics")      return cmdCompleteLyrics (args);
    if (name == "fill_lyric_gap")       return cmdFillLyricGap (args);
    if (name == "suggest_next_line")    return cmdSuggestNextLine (args);
    if (name == "regenerate_lyric")     return cmdRegenerateLyric (args);
    if (name == "cancel_lyric_job")     return cmdCancelLyricJob (args);
    if (name == "accept_lyric_proposal") return cmdAcceptLyricProposal (args);
    if (name == "assert_lyric_line")    return cmdAssertLyricLine (args);
    if (name == "reject_lyric_proposal") return cmdRejectLyricProposal (args);
    if (name == "analyze_lyrics")       return cmdAnalyzeLyrics (args);
    if (name == "get_lyric_corpus_stats") return cmdGetLyricCorpusStats (args);
    if (name == "build_lyrics_from_clip") return cmdBuildLyricsFromClip (args);
    if (name == "build_skeleton_from_clip") return cmdBuildSkeletonFromClip (args);
    if (name == "confirm_skeleton")     return cmdConfirmSkeleton (args);
    // AGT-MEM (Phase-B memory lane, M1) — the native agent-memory store.
    if (name == "agent_memory_write")   return cmdAgentMemoryWrite (args);
    if (name == "agent_memory_read")    return cmdAgentMemoryRead (args);
    // AGT-MEM (M3) — the memory drawer's per-item delete + per-tier clear.
    if (name == "agent_memory_delete")  return cmdAgentMemoryDelete (args);
    if (name == "agent_memory_clear")   return cmdAgentMemoryClear (args);
    // Annotations broadcast over MP (shared collaborator comments). create self-broadcasts
    // its resolved cross-peer id; the rest address by that id via the generic wrapper.
    if (name == "create_annotation") return cmdCreateAnnotation (args);
    if (name == "edit_annotation")   return broadcastStructuralIfActive (name, args, cmdEditAnnotation (args));
    if (name == "move_annotation")   return broadcastStructuralIfActive (name, args, cmdMoveAnnotation (args));
    if (name == "remove_annotation") return broadcastStructuralIfActive (name, args, cmdRemoveAnnotation (args));
    if (name == "remove_track")      return cmdRemoveTrack (args);
    if (name == "import_clip")       return cmdImportClip (args);
    if (name == "import_clip_data")  return cmdImportClipData (args);
    if (name == "add_test_tone_clip")return cmdAddTestTone (args);
    if (name == "set_transport")     return cmdSetTransport (args);
    if (name == "set_tempo")         return broadcastStructuralIfActive (name, args, cmdSetTempo (args));
    if (name == "set_time_signature")return broadcastStructuralIfActive (name, args, cmdSetTimeSignature (args));
    if (name == "set_metronome")     return broadcastStructuralIfActive (name, args, cmdSetMetronome (args));
    if (name == "undo")              return cmdUndo (args);
    if (name == "redo")              return cmdRedo (args);
    if (name == "jump_to_history")   return cmdJumpToHistory (args);   // CAP-PRJ-005
    if (name == "batch_begin")       return cmdBatchBegin (args);
    if (name == "batch_end")         return cmdBatchEnd (args);
    if (name == "batch_status")      return cmdBatchStatus (args);      // FS-B2a
    if (name == "batch_rollback")    return cmdBatchRollback (args);    // FS-B2a
    if (name == "save")              return cmdSave (args);
    if (name == "reload")            return cmdReload (args);
    if (name == "recover_session")   return cmdRecoverSession (args);   // A3 — replay the crash tail
    if (name == "discard_recovery")  return cmdDiscardRecovery (args);  // A3 — drop the crash tail
    if (name == "open_without_plugins") return cmdOpenWithoutPlugins (args);  // FS-T2 — plugin-crash safe mode
    if (name == "add_render_layer")  return cmdAddRenderLayer (args);
    if (name == "move_clip")         return cmdMoveClip (args);
    if (name == "trim_clip")         return cmdTrimClip (args);
    if (name == "split_clip")        return cmdSplitClip (args);
    if (name == "consolidate_clips") return cmdConsolidateClips (args);
    if (name == "crop_clip")      return cmdCropClip (args);
    if (name == "bounce_track")    return cmdBounceTrack (args);
    if (name == "freeze_track")    return cmdFreezeTrack (args);
    if (name == "unfreeze_track")  return cmdUnfreezeTrack (args);
    if (name == "remove_clip")       return cmdRemoveClip (args);
    if (name == "rename_clip")       return cmdRenameClip (args);
    if (name == "set_clip_mute")     return cmdSetClipMute (args);
    if (name == "set_clip_gain")     return cmdSetClipGain (args);
    if (name == "write_clip_gain_curve") return cmdWriteClipGainCurve (args);
    if (name == "set_clip_fade")     return cmdSetClipFade (args);
    if (name == "set_clip_reverse")  return cmdSetClipReverse (args);
    if (name == "set_clip_loop")     return cmdSetClipLoop (args);
    if (name == "set_clip_crossfade") return cmdSetClipCrossfade (args);
    if (name == "normalize_clip")    return cmdNormalizeClip (args);
    if (name == "relink_clip")       return cmdRelinkClip (args);
    if (name == "set_clip_warp")     return cmdSetClipWarp (args);
    if (name == "stretch_clip")      return cmdStretchClip (args);
    if (name == "detect_clip_bpm")   return cmdDetectClipBpm (args);
    if (name == "duplicate_clip")    return cmdDuplicateClip (args);
    if (name == "delete_time_range") return cmdDeleteTimeRange (args);
    if (name == "insert_time")       return cmdInsertTime (args);      // CAP-CLP-017
    if (name == "paste_clip")        return cmdPasteClip (args);
    if (name == "set_track_volume")  return cmdSetTrackVolume (args);
    if (name == "set_track_pan")     return cmdSetTrackPan (args);
    if (name == "set_track_mute")    return cmdSetTrackMute (args);
    if (name == "set_track_solo")    return cmdSetTrackSolo (args);
    if (name == "set_track_active")  return cmdSetTrackActive (args);
    if (name == "arm_track")         return cmdArmTrack (args);
    if (name == "stop_recording")    return cmdStopRecording (args);
    if (name == "set_input_monitor") return cmdSetInputMonitor (args);
    if (name == "list_takes")        return cmdListTakes (args);
    if (name == "set_current_take")  return cmdSetCurrentTake (args);
    if (name == "promote_take_region") return cmdPromoteTakeRegion (args);
    if (name == "keep_take")         return cmdKeepTake (args);
    if (name == "mark_take")         return cmdMarkTake (args);
    if (name == "set_master_volume") return broadcastStructuralIfActive (name, args, cmdSetMasterVolume (args));
    if (name == "set_master_pan")    return broadcastStructuralIfActive (name, args, cmdSetMasterPan (args));
    // Master-bus plugins — mirror the per-track plugin commands one level up (see
    // cmdLoadPlugin/cmdRemovePlugin/etc below); SessionGlobal like set_master_volume/pan
    // above (the master bus is one shared resource, not a track), so mutations sync to
    // peers via the same LWW broadcastStructural replay. open_master_plugin_editor is a
    // viewer-local pop-out (no state to sync) — Unguarded, exactly like open_plugin_editor.
    if (name == "load_master_plugin")      return broadcastStructuralIfActive (name, args, cmdLoadMasterPlugin (args));
    if (name == "load_master_builtin")     return broadcastStructuralIfActive (name, args, cmdLoadMasterBuiltin (args));
    if (name == "remove_master_plugin")    return broadcastStructuralIfActive (name, args, cmdRemoveMasterPlugin (args));
    if (name == "reorder_master_plugin")   return broadcastStructuralIfActive (name, args, cmdReorderMasterPlugin (args));
    if (name == "bypass_master_plugin")    return broadcastStructuralIfActive (name, args, cmdBypassMasterPlugin (args));
    if (name == "set_master_plugin_param") return broadcastStructuralIfActive (name, args, cmdSetMasterPluginParam (args));
    if (name == "open_master_plugin_editor") return cmdOpenMasterPluginEditor (args);
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
    if (name == "file_peaks")        return cmdFilePeaks (args);
    if (name == "list_plugins")      return cmdListPlugins (args);
    if (name == "list_builtins")     return cmdListBuiltins (args);
    if (name == "load_plugin")       return cmdLoadPlugin (args);
    if (name == "load_builtin")      return cmdLoadBuiltin (args);
    if (name == "set_track_type")    return cmdSetTrackType (args);
    if (name == "load_drum_kit")     return cmdLoadDrumKit (args);
    if (name == "assign_sample")     return cmdAssignSample (args);
    if (name == "set_drum_lane")     return cmdSetDrumLane (args);
    if (name == "set_drum_pad")      return cmdSetDrumPad (args);
    if (name == "clear_drum_pad")    return cmdClearDrumPad (args);
    if (name == "apply_choke")       return cmdApplyChoke (args);
    if (name == "list_drum_kits")    return cmdListDrumKits (args);
    if (name == "remove_plugin")     return cmdRemovePlugin (args);
    if (name == "reorder_plugin")    return cmdReorderPlugin (args);
    if (name == "set_plugin_param")  return cmdSetPluginParam (args);
    if (name == "bypass_plugin")     return cmdBypassPlugin (args);
    if (name == "rescan_plugins")        return cmdRescanPlugins (args);
    if (name == "get_plugin_blocklist")  return cmdGetPluginBlocklist (args);
    if (name == "unblock_plugin")        return cmdUnblockPlugin (args);
    if (name == "clear_plugin_blocklist")return cmdClearPluginBlocklist (args);
    if (name == "block_plugin")          return cmdBlockPlugin (args);
    if (name == "add_automation_point")    return cmdAddAutomationPoint (args);
    if (name == "remove_automation_point") return cmdRemoveAutomationPoint (args);
    if (name == "set_automation_point")    return cmdSetAutomationPoint (args);
    if (name == "clear_automation")        return cmdClearAutomation (args);
    if (name == "set_track_automation_mode") return cmdSetTrackAutomationMode (args);
    if (name == "write_automation_curve")    return cmdWriteAutomationCurve (args);
    if (name == "open_plugin_editor")return cmdOpenPluginEditor (args);
    if (name == "add_midi_clip")     return cmdAddMidiClip (args);
    if (name == "add_drum_pattern")  return cmdAddDrumPattern (args);
    if (name == "transcribe_clip")   return cmdTranscribeClip (args);
    if (name == "sketch_beatbox")    return cmdSketchBeatbox (args);
    if (name == "generate_beat_recipe") return cmdGenerateBeatRecipe (args);
    if (name == "add_note")          return cmdAddNote (args);
    if (name == "remove_note")       return cmdRemoveNote (args);
    if (name == "set_note")          return cmdSetNote (args);
    if (name == "quantize_notes")    return cmdQuantizeNotes (args);
    if (name == "transform_velocities") return cmdTransformVelocities (args);
    if (name == "transform_notes")   return cmdTransformNotes (args);
    if (name == "create_render_layer") return cmdCreateRenderLayer (args);
    if (name == "set_render_param")  return cmdSetRenderParam (args);
    if (name == "render_layer")      return cmdRenderLayer (args);
    if (name == "compile_render")    return cmdCompileRender (args);
    if (name == "cancel_render")     return cmdCancelRender (args);
    if (name == "accept_render")     return cmdAcceptRender (args);
    if (name == "reject_render")     return cmdRejectRender (args);
    if (name == "reset_render_layer") return cmdResetRenderLayer (args);
    if (name == "render_ahead_arm")  return cmdRenderAheadArm (args);   // Lane A — arm/disarm "Live"
    if (name == "render_ahead_tick") return cmdRenderAheadTick (args);  // Lane A — explicit clock tick (run-script)
    if (name == "bypass_layer")      return cmdBypassLayer (args);
    if (name == "freeze_layer")      return cmdFreezeLayer (args);
    if (name == "unfreeze_layer")    return cmdUnfreezeLayer (args);
    if (name == "bounce_layer_to_clip") return cmdBounceLayerToClip (args);
    if (name == "remove_render_layer") return cmdRemoveRenderLayer (args);
    if (name == "list_colors")       return cmdListColors (args);
    if (name == "list_loras")        return cmdListLoras (args);
    if (name == "list_transform_targets") return cmdListTransformTargets (args);
    if (name == "list_rave_models")  return cmdListRaveModels (args);   // Lane B — non-gated fs scan
   #if MOSH_HAVE_ANIRA
    if (name == "add_rave_insert")   return cmdAddRaveInsert (args);
    if (name == "set_rave_param")    return cmdSetRaveParam (args);
    if (name == "load_rave_model")   return cmdLoadRaveModel (args);
    if (name == "reset_rave")        return cmdResetRave (args);
   #endif
    if (name == "export_audio")      return cmdExportAudio (args);
    if (name == "export_stems")      return cmdExportStems (args);
    if (name == "list_audio_devices")return cmdListAudioDevices (args);
    if (name == "list_midi_inputs")  return cmdListMidiInputs (args);
    if (name == "get_command_log")   return cmdGetCommandLog (args);
    if (name == "set_audio_device")  return cmdSetAudioDevice (args);
    if (name == "retry_audio_device")return cmdRetryAudioDevice (args);
    if (name == "set_buffer_size")   return cmdSetBufferSize (args);
    if (name == "set_audio_threads") return cmdSetAudioThreads (args);
    if (name == "list_directory")    return cmdListDirectory (args);
    if (name == "audition_file")     return cmdAuditionFile (args);
    if (name == "stop_audition")     return cmdStopAudition (args);
    // Live note audition (MoshOps.Live.cpp) — transient, like the two above: no
    // transaction, no log line, no snapshot event. See that file's header for why.
    if (name == "audition_note")     return cmdAuditionNote (args);
    if (name == "all_notes_off")     return cmdAllNotesOff (args);
    if (name == "new_project")       return cmdNewProject (args);
    if (name == "open_project")      return cmdOpenProject (args);
    if (name == "open_recent")       return cmdOpenRecent (args);
    if (name == "save_as")           return cmdSaveAs (args);
    if (name == "set_project_settings") return cmdSetProjectSettings (args);
    if (name == "set_key")           return broadcastStructuralIfActive (name, args, cmdSetKey (args));
    if (name == "set_count_in")      return broadcastStructuralIfActive (name, args, cmdSetCountIn (args));
    // REC-001 — broadcast like set_count_in: record options are project-wide state a
    // multiplayer peer must see, not a viewer-local preference. capture_midi is NOT
    // broadcast the same way — it creates clips, so it invalidates the snapshot and
    // resyncs through the ordinary structural path.
    if (name == "set_record_options") return broadcastStructuralIfActive (name, args, cmdSetRecordOptions (args));
    if (name == "capture_midi")      return cmdCaptureMidi (args);
    if (name == "create_group_track") return cmdCreateGroupTrack (args);
    if (name == "mp_serialize_track") return cmdMpSerializeTrack (args);
    if (name == "apply_remote_track") return cmdApplyRemoteTrack (args);
    if (name == "mp_sync_locks")      return cmdMpSyncLocks (args);
    if (name == "mp_create_session")  return cmdMpCreateSession (args);
    if (name == "mp_join_session")    return cmdMpJoinSession (args);
    if (name == "mp_leave_session")   return cmdMpLeaveSession (args);
    if (name == "mp_claim_track")     return cmdMpClaimTrack (args);
    if (name == "mp_commit_track")    return cmdMpCommitTrack (args);
    if (name == "mp_broadcast_selection") return cmdMpBroadcastSelection (args);
    if (name == "mp_send_signal")    return cmdMpSendSignal (args);
    if (name == "mp_serialize_project") return cmdMpSerializeProject (args);
    if (name == "mp_apply_bootstrap")   return cmdMpApplyBootstrap (args);
    if (name == "mp_fetch_missing_stems") return cmdMpFetchMissingStems (args);
    if (name == "mp_apply_structural")  return cmdMpApplyStructural (args);
    if (name == "ungroup_track")      return cmdUngroupTrack (args);
    if (name == "list_wave_inputs")   return cmdListWaveInputs (args);
    if (name == "set_track_input")    return cmdSetTrackInput (args);
    if (name == "list_track_outputs") return cmdListTrackOutputs (args);
    if (name == "set_track_output")   return cmdSetTrackOutput (args);
    if (name == "insert_tempo_change")    return cmdInsertTempoChange (args);
    if (name == "set_tempo_curve")        return cmdSetTempoCurve (args);
    if (name == "remove_tempo_change")    return cmdRemoveTempoChange (args);
    if (name == "insert_time_sig_change") return cmdInsertTimeSigChange (args);
    if (name == "remove_time_sig_change") return cmdRemoveTimeSigChange (args);
    // Stage 7 — type-beat LoRA training
    if (name == "import_training_source")  return cmdImportTrainingSource (args);
    if (name == "list_training_sources")   return cmdListTrainingSources (args);
    if (name == "approve_training_source") return cmdApproveTrainingSource (args);
    if (name == "build_training_corpus")   return cmdBuildTrainingCorpus (args);
    if (name == "submit_training_job")     return cmdSubmitTrainingJob (args);
    if (name == "training_job_status")     return cmdTrainingJobStatus (args);
    if (name == "cancel_training_job")     return cmdCancelTrainingJob (args);
    if (name == "import_lora_adapter")     return cmdImportLoraAdapter (args);
    if (name == "activate_lora_adapter")   return cmdActivateLoraAdapter (args);
    if (name == "list_lora_adapters")      return cmdListLoraAdapters (args);

    return errResult (name, "unknown command: " + name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

std::vector<juce::String> MoshOps::lockKeysFor (LockManager::Scope scope, const juce::var& args)
{
    using Scope = LockManager::Scope;
    std::vector<juce::String> keys;
    auto addTrackKey = [&keys] (te::Track* track)
    {
        if (track == nullptr)
            return;
        const auto key = logicalid::track (track->state);
        if (key.isNotEmpty() && std::find (keys.begin(), keys.end(), key) == keys.end())
            keys.push_back (key);
    };

    if (scope == Scope::SessionGlobal)
    {
        keys.push_back (LockManager::sessionKey());
        return keys;
    }

    if (scope == Scope::Track)
    {
        if (auto* t = findTrack (args.getProperty ("trackId", var()).toString()))
        {
            addTrackKey (t);
            return keys;
        }
        // Track-scoped composites may target via clipId only (add_drum_pattern) —
        // resolve through the clip so a peer's track lock still guards them.
        if (auto* c = findClip (args.getProperty ("clipId", var()).toString()))
            addTrackKey (c->getTrack());
        return keys;   // unresolvable target -> empty collection; the handler errors
    }

    if (scope == Scope::Clip)
    {
        auto addClipTrack = [this, &addTrackKey] (const juce::var& clipId)
        {
            if (auto* clip = findClip (clipId.toString()))
                addTrackKey (clip->getTrack());
        };
        if (auto* c = findClip (args.getProperty ("clipId", var()).toString()))
        {
            addTrackKey (c->getTrack());
            if (const auto group = findClipGroupForClip (c->itemID.toString(), true); group.isValid())
                for (auto* member : clipGroupMembers (group)) addTrackKey (member->getTrack());
        }
        if (auto* clipIds = args.getProperty ("clipIds", var()).getArray())
            for (auto& clipId : *clipIds)
                addClipTrack (clipId);
        return keys;
    }

    return keys;
}

juce::var MoshOps::cmdUndo (const juce::var& args)
{
    const bool did = undoManager().undo();
    // CAP-PRJ-005 — walk the mirror's cursor with the UndoManager's. Doing it HERE
    // (before logLine's syncUndoMirror) is what tells the mirror this was a move along
    // the existing timeline rather than a new transaction; see syncUndoMirror().
    if (did && txnCursor_ > 0) --txnCursor_;
    if (did) { eng.markDirty(); ++editRevision_; }   // edit content changed → needs re-save (gap 1)
    logLine ("undo", args, did, did ? String() : String ("nothing to undo"), false);
    emitSnapshotInvalidated();
    return okResult ("undo", var (did));
}

juce::var MoshOps::cmdRedo (const juce::var& args)
{
    const bool did = undoManager().redo();
    if (did && txnCursor_ < (int) txnIds_.size()) ++txnCursor_;   // CAP-PRJ-005 (see cmdUndo)
    if (did) { eng.markDirty(); ++editRevision_; }   // edit content changed → needs re-save (gap 1)
    logLine ("redo", args, did, did ? String() : String ("nothing to redo"), false);
    emitSnapshotInvalidated();
    return okResult ("redo", var (did));
}

// CAP-PRJ-005 — jump to a point in undo history.
//
// Pro Tools, Reaper and Live all show a history list you CLICK AN ENTRY IN, and all
// three restore to that point rather than asking for a step count. This is that, over
// the list the producer already has (the command log). The argument is the log line's
// own `txn` stamp — an identity, resolved against the live undo timeline here, at click
// time. Everything that could make a step COUNT wrong (a non-undoable command in the
// middle, a batch collapsing many commands into one transaction, a discarded redo tail,
// an evicted oldest transaction, a stale line from a previous session) shows up here as
// "not found" — a refusal the producer can read, never a silent landing somewhere else.
juce::var MoshOps::cmdJumpToHistory (const juce::var& args)
{
    const auto target = args.getProperty ("txn", var()).toString().trim();
    if (target.isEmpty())
        return errResult ("jump_to_history", "txn is required (the history stamp of the point to restore)");

    // An open agent transaction owns the undo head and proves ownership by comparing it
    // (AgentTxn::planRollback). Walking the stack out from under it would make that proof
    // a lie, so refuse while one is open — including the LEGACY untagged batch, which
    // txnPreDispatch does not gate.
    if (inBatch)
        return errResult ("jump_to_history", "a batch is open; end or roll it back before jumping");

    syncUndoMirror();

    if (! target.startsWith (historyToken_ + ":"))
        return errResult ("jump_to_history",
                          "that point belongs to an earlier session and can no longer be restored");

    const auto suffix = target.fromLastOccurrenceOf (":", false, false);
    if (suffix.isEmpty() || ! suffix.containsOnly ("0123456789"))
        return errResult ("jump_to_history", "malformed txn stamp: " + target);
    const juce::int64 wanted = suffix.getLargeIntValue();

    int destination = -1;
    if (wanted == 0)
    {
        destination = 0;                       // the session's own starting point
    }
    else
    {
        for (int i = 0; i < (int) txnIds_.size(); ++i)
            if (txnIds_[(size_t) i] == wanted)
            { destination = i + 1; break; }    // "after transaction i" == cursor i+1
    }

    if (destination < 0)
    {
        logLine ("jump_to_history", args, false, "point no longer in the undo history", false);
        return errResult ("jump_to_history",
                          "that point is no longer in the undo history (it was undone past and "
                          "overwritten by a later edit, or dropped as the history filled)");
    }

    const int from = txnCursor_;
    int undone = 0, redone = 0;

    while (txnCursor_ > destination)
    {
        if (! undoManager().undo())
            break;                             // the UndoManager disagrees: stop, report what happened
        --txnCursor_;
        ++undone;
    }
    while (txnCursor_ < destination)
    {
        if (! undoManager().redo())
            break;
        ++txnCursor_;
        ++redone;
    }

    const bool arrived = (txnCursor_ == destination);
    if (undone > 0 || redone > 0) { eng.markDirty(); ++editRevision_; }

    logLine ("jump_to_history", args, arrived,
             arrived ? String() : String ("the undo history moved while jumping"), false);
    emitSnapshotInvalidated();

    if (! arrived)
        return errResult ("jump_to_history", "the undo history moved while jumping; stopped at "
                                             + currentHistoryTxn());

    auto* data = new DynamicObject();
    data->setProperty ("txn", currentHistoryTxn());
    data->setProperty ("undone", undone);
    data->setProperty ("redone", redone);
    data->setProperty ("from", from);
    data->setProperty ("depth", txnCursor_);
    return okResult ("jump_to_history", var (data));
}

// Agent batch grouping: batch_begin opens ONE undo transaction; every command run
// while inBatch skips its own beginNewTransaction (see beginTxn), so the whole batch
// is a single undo step. batch_end closes it. The agent ("Monster changes") brackets
// its edits with these so one Undo reverts the entire batch.
//
// FS-B2a — TWO MODES, and the split is the safety property of the whole change:
//   • NO transactionId  ⇒ the LEGACY path, byte-identical to the pre-FS-B2a behaviour.
//     Every existing caller (runAgentBatch, cmdSketchBeatbox and cmdGenerateBeatRecipe's
//     ownBatch pattern, the existing --selftest batch section) keeps working untouched.
//   • WITH transactionId ⇒ the identified, manifest-validated, exactly-rollbackable
//     transaction defined by docs/first-stranger-program/lanes/fs-b2.md.
juce::var MoshOps::cmdBatchBegin (const juce::var& args)
{
    const auto txnId = args.getProperty ("transactionId", var()).toString().trim();

    if (txnId.isEmpty())
    {
        // ── LEGACY MODE (unchanged) ──
        if (inBatch)
            return errResult ("batch_begin", "a batch is already open");
        const auto label = args.getProperty ("name", var ("agent edit")).toString();
        beginUndoTransaction (label);
        inBatch = true;
        logLine ("batch_begin", args, true, {}, false);
        return okResult ("batch_begin");
    }

    // ── TRANSACTIONAL MODE ──
    // A crash left something unresolved: no further skill may run until T2's recovery has
    // proved the pre- or post-transaction state. fs-b2.md is explicit that B2 "may not
    // call a crash-interrupted edit clean merely because the in-memory inBatch flag
    // disappeared".
    if (! unresolvedTxnIds_.isEmpty())
        return errResult ("batch_begin",
                          agenttxn::codeUnresolvedRestart() + ": transaction "
                          + unresolvedTxnIds_[0] + " from a previous run is unresolved; "
                          "recover or discard the session before running a skill");

    const auto name = args.getProperty ("name", var()).toString();
    std::vector<agenttxn::ManifestEntry> manifest;
    juce::String manifestError;
    if (! agenttxn::parseManifest (args.getProperty ("commands", var()), manifest, manifestError))
        return errResult ("batch_begin", agenttxn::codeManifestRejected() + ": " + manifestError);

    const auto digest = agenttxn::manifestDigest (name, manifest);

    // Idempotent retry: SAME id + semantically identical manifest returns the existing
    // status. This is what makes a lost batch_begin response safe to retry.
    if (txn_ != nullptr && txn_->id == txnId)
    {
        if (txn_->manifestDigest != digest)
            return errResult ("batch_begin",
                              agenttxn::codeIdentityConflict() + ": transaction " + txnId
                              + " already exists with a different manifest");
        auto status = txnStatusVar (*txn_);
        if (auto* o = status.getDynamicObject()) o->setProperty ("replayed", true);
        return okResult ("batch_begin", status);
    }

    if (txn_ != nullptr && txn_->isOpen())
        return errResult ("batch_begin",
                          agenttxn::codeAlreadyOpen() + ": transaction " + txn_->id
                          + " is still " + txn_->status);

    if (inBatch)
        return errResult ("batch_begin", "a batch is already open");

    // Manifest PREFLIGHT against the engine-owned registry — before the Tracktion
    // transaction opens, so a rejection mutates nothing and leaves no open transaction.
    for (const auto& e : manifest)
    {
        juce::String reason;
        if (mosh::txnsafe::classify (e.command, reason) != mosh::txnsafe::Class::Safe)
            return errResult ("batch_begin",
                              agenttxn::codeManifestRejected() + ": step "
                              + juce::String (e.index) + " — " + reason);
    }

    auto record = std::make_unique<agenttxn::Record>();
    record->id              = txnId;
    record->name            = name;
    record->label           = agenttxn::labelFor (txnId);
    record->status          = agenttxn::statusOpen();
    record->manifestDigest  = digest;
    record->preFingerprint  = txnFingerprint();
    record->revisionAtBegin = editRevision_;
    for (const auto& e : manifest)
    {
        agenttxn::Entry entry;
        entry.requestId = e.requestId;
        entry.command   = e.command;
        record->entries.push_back (entry);
    }

    // beginNewTransaction is LAZY (juce_UndoManager.cpp:223 only sets a flag; the
    // ActionSet appears on the first perform), so an empty transaction leaves the undo
    // stack completely untouched — which is what lets rollback distinguish "we own a
    // non-empty head" from "there is nothing of ours to undo".
    beginUndoTransaction (record->label);
    inBatch = true;
    txn_ = std::move (record);

    logLine ("batch_begin", args, true, {}, false);
    appendTxnLedger (*txn_);
    return okResult ("batch_begin", txnStatusVar (*txn_));
}

juce::var MoshOps::cmdBatchEnd (const juce::var& args)
{
    const auto txnId = args.getProperty ("transactionId", var()).toString().trim();

    if (txnId.isEmpty())
    {
        // ── LEGACY MODE (unchanged) ──
        if (! inBatch)
            return errResult ("batch_end", "no batch is open");
        inBatch = false;
        logLine ("batch_end", args, true, {}, false);
        emitSnapshotInvalidated();
        return okResult ("batch_end");
    }

    // ── TRANSACTIONAL MODE: batch_end IS the commit ──
    if (txn_ == nullptr || txn_->id != txnId)
        return errResult ("batch_end",
                          agenttxn::codeUnknownTxn() + ": no transaction " + txnId
                          + " — query batch_status rather than inferring from this failure");

    // Idempotent: a lost commit RESPONSE is resolved by repeating the call (or by
    // batch_status), never by a blind second mutation.
    if (txn_->status == agenttxn::statusCommitted())
    {
        auto status = txnStatusVar (*txn_);
        if (auto* o = status.getDynamicObject()) o->setProperty ("replayed", true);
        return okResult ("batch_end", status);
    }
    if (! txn_->isOpen())
        return errResult ("batch_end",
                          agenttxn::codeUnknownTxn() + ": transaction " + txnId
                          + " is " + txn_->status + " and cannot be committed");

    if (txn_->anyFailed() || ! txn_->allResolved())
    {
        txn_->status      = agenttxn::statusFailed();
        txn_->failureCode = agenttxn::codeIncomplete();
        appendTxnLedger (*txn_);
        return errResult ("batch_end",
                          agenttxn::codeIncomplete() + ": " + juce::String (txn_->appliedCount())
                          + " of " + juce::String ((int) txn_->entries.size())
                          + " manifested commands applied; roll back instead of committing");
    }

    // Structural proof that this transaction — and nothing else — owns the edit's head.
    const int  headActions = undoManager().getNumActionsInCurrentTransaction();
    const auto headName    = undoManager().getUndoDescription();
    if (headActions > 0 && headName != txn_->label)
    {
        txn_->status      = agenttxn::statusNeedsRecovery();
        txn_->failureCode = agenttxn::codeUndoHeadMismatch();
        inBatch = false;
        appendTxnLedger (*txn_);
        return errResult ("batch_end",
                          agenttxn::codeUndoHeadMismatch() + ": the undo head is \"" + headName
                          + "\", not this transaction; the edit state cannot be proven");
    }
    if (headActions == 0 && txnFingerprint() != txn_->preFingerprint)
    {
        // Nothing entered the undo system, yet the session changed — something mutated
        // outside the one mutation path. Refuse rather than commit an unprovable edit.
        txn_->status      = agenttxn::statusNeedsRecovery();
        txn_->failureCode = agenttxn::codeFingerprintMismatch();
        inBatch = false;
        appendTxnLedger (*txn_);
        return errResult ("batch_end",
                          agenttxn::codeFingerprintMismatch() + ": the session changed without "
                          "entering the undo system; the edit state cannot be proven");
    }
    if (editRevision_ < txn_->revisionAtBegin)
    {
        txn_->status      = agenttxn::statusNeedsRecovery();
        txn_->failureCode = agenttxn::codeFingerprintMismatch();
        inBatch = false;
        appendTxnLedger (*txn_);
        return errResult ("batch_end",
                          agenttxn::codeFingerprintMismatch() + ": edit revision went backwards");
    }

    inBatch        = false;
    txn_->status   = agenttxn::statusCommitted();
    txn_->failureCode.clear();
    logLine ("batch_end", args, true, {}, false);
    appendTxnLedger (*txn_);
    emitSnapshotInvalidated();
    return okResult ("batch_end", txnStatusVar (*txn_));
}

// The authoritative read. fs-b2.md: "The status is the authority after any rejected
// promise, bridge disconnect, timeout, or duplicate call." Read-only — no transaction, no
// mutation, and (following get_rhymes / get_lyric_corpus_stats) no JSONL line.
juce::var MoshOps::cmdBatchStatus (const juce::var& args)
{
    const auto txnId = args.getProperty ("transactionId", var()).toString().trim();
    if (txnId.isEmpty())
        return errResult ("batch_status", "missing 'transactionId'");

    // A crash-orphaned id is NEVER reported as "nothing happened".
    if (unresolvedTxnIds_.contains (txnId))
    {
        auto* o = new DynamicObject();
        o->setProperty ("found", true);
        o->setProperty ("transactionId", txnId);
        o->setProperty ("status", agenttxn::statusNeedsRecovery());
        o->setProperty ("failureCode", agenttxn::codeUnresolvedRestart());
        o->setProperty ("canCommit", false);
        o->setProperty ("canRollback", false);
        o->setProperty ("revision", editRevision_);
        return okResult ("batch_status", var (o));
    }

    if (txn_ == nullptr || txn_->id != txnId)
    {
        auto* o = new DynamicObject();
        o->setProperty ("found", false);
        o->setProperty ("transactionId", txnId);
        o->setProperty ("revision", editRevision_);
        return okResult ("batch_status", var (o));
    }

    return okResult ("batch_status", txnStatusVar (*txn_));
}

// The ONLY automatic skill rollback. Never a generic undo: fs-b2.md requires it to prove
// this transaction owns the UndoManager head, undo exactly that transaction, and verify
// the pre-state fingerprint before it will report rolled_back.
//
// The head-ownership gate is not defensive decoration — it is the G14 empty-transaction
// class. With zero actions in the current set, UndoManager::undo() reaches back and
// destroys the PREVIOUS edit (juce_UndoManager.cpp:256 getCurrentSet()), so a rollback
// that skipped this check would silently revert unrelated work.
juce::var MoshOps::cmdBatchRollback (const juce::var& args)
{
    const auto txnId = args.getProperty ("transactionId", var()).toString().trim();
    if (txnId.isEmpty())
        return errResult ("batch_rollback", "missing 'transactionId'");

    if (txn_ == nullptr || txn_->id != txnId)
        return errResult ("batch_rollback",
                          agenttxn::codeUnknownTxn() + ": no transaction " + txnId
                          + " — performing no undo");

    // Idempotent once rolled back.
    if (txn_->status == agenttxn::statusRolledBack())
    {
        auto status = txnStatusVar (*txn_);
        if (auto* o = status.getDynamicObject()) o->setProperty ("replayed", true);
        return okResult ("batch_rollback", status);
    }
    if (txn_->status == agenttxn::statusCommitted())
        return errResult ("batch_rollback",
                          agenttxn::statusNeedsRecovery() + ": transaction " + txnId
                          + " is already committed; performing no undo");
    if (txn_->status == agenttxn::statusNeedsRecovery())
        return errResult ("batch_rollback",
                          agenttxn::statusNeedsRecovery() + ": transaction " + txnId
                          + " needs human recovery; performing no undo");

    const int  headActions = undoManager().getNumActionsInCurrentTransaction();
    const auto headName    = undoManager().getUndoDescription();
    const auto plan        = agenttxn::planRollback (headActions, headName, txn_->label);

    if (plan == agenttxn::RollbackPlan::RefuseForeignHead)
    {
        txn_->status      = agenttxn::statusNeedsRecovery();
        txn_->failureCode = agenttxn::codeUndoHeadMismatch();
        inBatch = false;
        appendTxnLedger (*txn_);
        return errResult ("batch_rollback",
                          agenttxn::codeUndoHeadMismatch() + ": the undo head is \"" + headName
                          + "\", not this transaction; performing no undo");
    }

    if (plan == agenttxn::RollbackPlan::UndoOurs)
    {
        undoManager().undo();
        eng.markDirty();
        ++editRevision_;
        emitSnapshotInvalidated();
    }
    inBatch = false;

    // Exactness check: the session must be back at the captured pre-state.
    const auto now = txnFingerprint();
    if (now != txn_->preFingerprint)
    {
        txn_->status      = agenttxn::statusNeedsRecovery();
        txn_->failureCode = agenttxn::codeFingerprintMismatch();
        appendTxnLedger (*txn_);
        return errResult ("batch_rollback",
                          agenttxn::codeFingerprintMismatch() + ": the undo did not restore the "
                          "pre-transaction state; the edit needs human recovery");
    }

    txn_->status = agenttxn::statusRolledBack();
    txn_->failureCode.clear();
    logLine ("batch_rollback", args, true, {}, false);
    appendTxnLedger (*txn_);
    return okResult ("batch_rollback", txnStatusVar (*txn_));
}

// ── FS-B2a support ───────────────────────────────────────────────────────────────

// The canonical semantic fingerprint of the session. Memoized on editRevision_, which
// beginTxn/cmdUndo/cmdRedo/cmdBatchRollback bump on every Edit mutation.
//
// The memo is worth having: snapshot() is measured at ~330 ms / 3.7 MiB at 100 tracks
// (see emitTrackPatch's note), and a two-command skill run asks for the fingerprint six to
// eight times — at begin, at each ledger record, and at every batch_status the harness
// consults. Without the memo that is a couple of seconds of message-thread time on a large
// session, on the synchronous execute_command path.
//
// SOUNDNESS, stated because a stale fingerprint would silently weaken the exactness check:
// the only writes that change the snapshot WITHOUT bumping editRevision_ are the handful of
// non-undoable engine/device preferences that never call beginTxn (set_metronome,
// set_input_monitor, arm_track, …). Every one of those is classified NonUndoable, so it can
// never be a manifest step; and while a transaction is open the guard refuses it as an
// untagged mutation. So no such write can land between a fingerprint being captured and the
// same fingerprint being compared. If a future command mutates the Edit without going
// through beginTxn, it MUST bump editRevision_ — that is the invariant this memo rests on.
juce::String MoshOps::txnFingerprint()
{
    if (txnFingerprintRevision_ == editRevision_ && txnFingerprintCache_.isNotEmpty())
        return txnFingerprintCache_;

    txnFingerprintCache_    = agenttxn::fingerprint (snapshot());
    txnFingerprintRevision_ = editRevision_;
    return txnFingerprintCache_;
}

juce::var MoshOps::txnStatusVar (const agenttxn::Record& record)
{
    Array<var> entries;
    for (int i = 0; i < (int) record.entries.size(); ++i)
    {
        const auto& e = record.entries[(size_t) i];
        auto* eo = new DynamicObject();
        eo->setProperty ("index", i);
        eo->setProperty ("requestId", e.requestId);
        eo->setProperty ("command", e.command);
        eo->setProperty ("state", e.state);
        // The RESULT envelope only. The command's args are deliberately never recorded
        // here or in the ledger — they carry file paths, lyric text and track names.
        if (! e.result.isVoid()) eo->setProperty ("result", e.result);
        entries.add (var (eo));
    }

    auto* o = new DynamicObject();
    o->setProperty ("found", true);
    o->setProperty ("transactionId", record.id);
    o->setProperty ("name", record.name);
    o->setProperty ("status", record.status);
    if (record.failureCode.isNotEmpty()) o->setProperty ("failureCode", record.failureCode);
    o->setProperty ("revisionAtBegin", record.revisionAtBegin);
    o->setProperty ("revision", editRevision_);
    o->setProperty ("preFingerprint", record.preFingerprint);
    o->setProperty ("fingerprint", txnFingerprint());
    o->setProperty ("manifestCount", (int) record.entries.size());
    o->setProperty ("applied", record.appliedCount());
    o->setProperty ("canCommit", record.status == agenttxn::statusOpen()
                                     && record.allResolved() && ! record.anyFailed());
    o->setProperty ("canRollback", record.isOpen());
    o->setProperty ("entries", entries);
    return var (o);
}

void MoshOps::initTxnLedger()
{
    txnLedgerFile = eng.sessionDir().getChildFile (agenttxn::ledgerFileName());
    if (! txnLedgerFile.existsAsFile())
        return;

    const auto lines = StringArray::fromLines (txnLedgerFile.loadFileAsString());
    unresolvedTxnIds_ = agenttxn::unresolvedIdsIn (lines);
}

void MoshOps::appendTxnLedger (const agenttxn::Record& record)
{
    if (txnLedgerFile == File())
        return;

    const auto line = JSON::toString (
        agenttxn::makeLedgerRecord (record.id, record.name, record.status, record.failureCode,
                                    editRevision_, record.preFingerprint, txnFingerprint(),
                                    record.appliedCount(), (int) record.entries.size()),
        true);
    txnLedgerFile.appendText (line + "\n");

    // "Bounded" per fs-b2.md: a long session must not grow this without limit. Trim from
    // the FRONT, and only whole lines, so the surviving tail stays parseable — and only
    // once nothing is unresolved, so trimming can never erase the evidence of a crash.
    static constexpr int kMaxLedgerLines = 500;
    static constexpr int kKeepLedgerLines = 200;
    if (unresolvedTxnIds_.isEmpty())
    {
        auto lines = StringArray::fromLines (txnLedgerFile.loadFileAsString());
        while (lines.size() > 0 && lines[lines.size() - 1].trim().isEmpty())
            lines.remove (lines.size() - 1);
        if (lines.size() > kMaxLedgerLines)
        {
            lines.removeRange (0, lines.size() - kKeepLedgerLines);
            txnLedgerFile.replaceWithText (lines.joinIntoString ("\n") + "\n");
        }
    }
}

// T2 coordination. fs-b2.md requires an unresolved transaction to block skills "until
// T2's snapshot+journal recovery has proved either the complete pre-transaction or
// complete post-transaction state". Those are exactly T2's two human-gated outcomes:
//   recover_session  → the journal tail was replayed ⇒ the POST-transaction state stands;
//   discard_recovery → the tail was dropped ⇒ the last SAVED (pre-transaction) state stands.
// Either way the ambiguity is gone and a terminal record is written. Note the limit
// honestly: this trusts T2's journal to be the faithful record of the crash tail — it is
// the strongest proof available, not an independent one.
// The guard. Runs on the OUTERMOST execute() only (see execute()'s DepthGuard).
//
// While a transaction is open this is the wall fs-b2.md asks for: "every mutation must
// carry matching metadata and match the next manifest entry. Untagged UI mutations, relay
// mutations, out-of-order calls, and extra calls are refused without mutation."
//
// FAIL-CLOSED: a command is admitted only if it is the manifest's next entry or is named
// in readOnlyDuringTransaction(). Anything else is refused — including a brand-new command
// nobody remembered to classify.
bool MoshOps::txnPreDispatch (const juce::var& command, juce::var& early)
{
    const auto name = command.getProperty ("command", var()).toString();
    const auto meta = command.getProperty ("transaction", var());
    const bool hasMeta = meta.getDynamicObject() != nullptr;

    pendingTxnIndex_ = -1;
    pendingTxnEnvelopeDigest_.clear();

    // The boundary commands validate their own ids; never intercept them.
    if (name == "batch_begin" || name == "batch_end" || name == "batch_rollback"
        || name == "batch_status")
        return false;

    const bool open = (txn_ != nullptr && txn_->isOpen());

    if (! hasMeta)
    {
        if (! open)
            return false;   // no transaction: ordinary behaviour, entirely unchanged

        if (mosh::txnsafe::isReadOnlyDuringTransaction (name))
            return false;   // reads stay available for the length of a skill run

        // A foreign mutation — local UI, or a peer's op landing through applyingRemote_.
        // Refused WITHOUT touching transaction state, exactly as the contract requires.
        early = errResult (name,
                           agenttxn::codeInProgress() + ": agent transaction " + txn_->id
                           + " is open; this change was not applied");
        return true;
    }

    // Metadata present. Resolve it against a transaction, whatever its status: a retry
    // arriving after commit must still replay rather than double-apply.
    const auto metaId    = meta.getProperty ("transactionId", var()).toString().trim();
    const auto requestId = meta.getProperty ("requestId", var()).toString().trim();
    const int  metaIndex = (int) meta.getProperty ("index", var (-1));

    if (txn_ == nullptr || txn_->id != metaId)
    {
        early = errResult (name,
                           agenttxn::codeUnknownTxn() + ": no transaction " + metaId
                           + " — query batch_status");
        return true;
    }

    auto* entry = txn_->findByRequestId (requestId);
    if (entry == nullptr)
    {
        early = errResult (name,
                           agenttxn::codeManifestMismatch() + ": requestId " + requestId
                           + " is not in transaction " + metaId + "'s manifest");
        return true;
    }

    const auto entryIndex = txn_->indexOfRequestId (requestId);
    // The envelope's identity is command + args: a retry that quietly changed an argument
    // must be rejected, not replayed.
    auto* envelope = new DynamicObject();
    envelope->setProperty ("command", name);
    envelope->setProperty ("args", command.getProperty ("args", var()));
    const auto digest = agenttxn::digestOf (var (envelope));

    if (entry->state != agenttxn::entryPending())
    {
        // Already resolved: this is a RETRY after a lost response.
        if (entry->envelopeDigest != digest)
        {
            early = errResult (name,
                               agenttxn::codeEnvelopeConflict() + ": requestId " + requestId
                               + " was already used with different content");
            return true;
        }
        // Return the RECORDED result and apply nothing. This is what makes a command retry
        // non-duplicating.
        auto replay = entry->result;
        if (auto* o = replay.getDynamicObject())
            o->setProperty ("replayed", true);
        early = replay;
        return true;
    }

    if (! open)
    {
        early = errResult (name,
                           agenttxn::codeUnknownTxn() + ": transaction " + metaId + " is "
                           + txn_->status + "; no further commands may run");
        return true;
    }
    if (entryIndex != txn_->nextIndex)
    {
        early = errResult (name,
                           agenttxn::codeManifestMismatch() + ": expected manifest step "
                           + juce::String (txn_->nextIndex) + ", got step "
                           + juce::String (entryIndex));
        return true;
    }
    if (metaIndex != entryIndex)
    {
        early = errResult (name,
                           agenttxn::codeManifestMismatch() + ": envelope declares index "
                           + juce::String (metaIndex) + " for manifest step "
                           + juce::String (entryIndex));
        return true;
    }
    if (entry->command != name)
    {
        early = errResult (name,
                           agenttxn::codeManifestMismatch() + ": manifest step "
                           + juce::String (entryIndex) + " is " + entry->command);
        return true;
    }

    // Admitted. Hand the index/digest to txnPostDispatch, which records the outcome.
    pendingTxnIndex_          = entryIndex;
    pendingTxnEnvelopeDigest_ = digest;
    return false;
}

void MoshOps::txnPostDispatch (const juce::var& result)
{
    if (pendingTxnIndex_ < 0 || txn_ == nullptr)
        return;

    const int index = pendingTxnIndex_;
    const auto digest = pendingTxnEnvelopeDigest_;
    pendingTxnIndex_ = -1;
    pendingTxnEnvelopeDigest_.clear();

    if (index >= (int) txn_->entries.size())
        return;

    auto& entry = txn_->entries[(size_t) index];
    const bool ok = (bool) result.getProperty ("ok", false);
    entry.state          = ok ? agenttxn::entryApplied() : agenttxn::entryFailed();
    entry.envelopeDigest = digest;
    entry.result         = result;
    txn_->nextIndex      = index + 1;

    if (! ok)
    {
        // A resolved command failure is the transaction's failure. It stays OPEN for
        // rollback (canRollback), but no further manifested command may run.
        txn_->status      = agenttxn::statusFailed();
        txn_->failureCode = agenttxn::codeCommandFailed();
        appendTxnLedger (*txn_);
    }
}

void MoshOps::resolveUnresolvedTxns (bool provedPostState)
{
    // ONLY the startup set — ids orphaned by a PREVIOUS process, whose in-memory state is
    // genuinely gone and for which the file on disk is therefore the whole truth.
    //
    // An in-process transaction is deliberately NOT resolvable this way, and the
    // distinction is not pedantic: cmdDiscardRecovery drops the journal but does not
    // reload the edit, so relabelling a live open transaction "rolled_back" would claim a
    // restoration that never happened — the exact class of lie this whole contract exists
    // to prevent. A live transaction resolves through batch_end or batch_rollback; a live
    // needs_recovery one resolves through a human, which is what needs_recovery means.
    if (unresolvedTxnIds_.isEmpty())
        return;

    const auto ids = unresolvedTxnIds_;
    unresolvedTxnIds_.clear();   // cleared FIRST so appendTxnLedger may trim again

    const auto terminal = provedPostState ? agenttxn::statusCommitted()
                                          : agenttxn::statusRolledBack();
    for (const auto& id : ids)
    {
        agenttxn::Record resolved;
        resolved.id     = id;
        resolved.name   = "(recovered)";
        resolved.status = terminal;
        appendTxnLedger (resolved);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 7 — parameter automation. A parameter is addressed by
// (trackId, pluginIndex, paramIndex); values cross the seam normalised 0–1 and
// are mapped to the parameter's real range here. Times are in seconds.
// ─────────────────────────────────────────────────────────────────────────────
te::AutomatableParameter* MoshOps::findParam (const juce::String& trackId, int pluginIndex, int paramIndex)
{
    auto* plugin = findPlugin (trackId, pluginIndex);
    if (plugin == nullptr) return nullptr;
    if (paramIndex < 0 || paramIndex >= plugin->getNumAutomatableParameters()) return nullptr;
    return plugin->getAutomatableParameter (paramIndex).get();
}

juce::var MoshOps::cmdAddMidiClip (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    beginTxn ("add_midi_clip");
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult ("add_midi_clip", "no track");

    // DRM-001 — default-instrument policy: a MIDI clip on an instrument-less track
    // would be silent, so auto-load the sane default in the same transaction (drum
    // track → sampler+kit, else → 4OSC). SKIP it when the track already carries WAVE
    // audio — a front-of-chain synth clears the track buffer and would silence those
    // clips. No-op too when an instrument is already present (never clobbers a choice).
    {
        bool hasWaveClips = false;
        for (auto* c : track->getClips())
            if (dynamic_cast<te::WaveAudioClip*> (c)) { hasWaveClips = true; break; }
        if (! hasWaveClips)
        {
            const bool drum = track->state.getProperty (ids::trackType, "audio").toString() == "drum";
            ensureDefaultInstrument (*track, drum);
        }
    }

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
    // Otherwise the clip is left EMPTY: a new MIDI clip from the "+ MIDI" button has
    // no notes — the user programs it in the piano roll. (No default arpeggio: that
    // surprised users with phantom notes. Callers wanting seed content pass `notes`.)

    ensureTrackMeter (*track);   // METER-001 — after the instrument load above so the tap stays post-fader

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("add_midi_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_midi_clip", var (data));
}

// DRM-002 — add_drum_pattern: a whole drum grid in ONE undoable command. The DSL
// parser (DrumPattern.h) is mirrored 1:1 by ui/src/ui/drumPatternUtil.ts, and the
// mock case in bridge.mock.ts mirrors THIS handler's semantics + error strings.
// Policy (owner-approved design, docs/superpowers/specs/2026-07-10-add-drum-pattern-design.md):
// clipId → per-lane replace (only the lanes named in the pattern are cleared, then
// re-laid); else a new clip lands on trackId (omitted → new "Drums" drum track).
// Instrument-less target → trackType "drum" + kit in the SAME transaction (the
// DRM-001 posture: the pattern must be audible, and specifically as DRUMS, not
// 4OSC); instrument present → untouched (melodic-808 / custom kits keep working);
// wave-audio target → error (a front-of-chain sampler clears the track buffer).
juce::var MoshOps::cmdAddDrumPattern (const juce::var& args)
{
    // Literal per-arg reads: the agent-catalog contract test regex-matches these.
    const auto pattern     = args.getProperty ("pattern", var());
    const auto trackId     = args.getProperty ("trackId", var()).toString();
    const auto clipId      = args.getProperty ("clipId", var()).toString();
    const int  stepsPerBar = (int) args.getProperty ("stepsPerBar", 16);
    const int  bars        = (int) args.getProperty ("bars", 0);
    int        velocity    = (int) args.getProperty ("velocity", 100);
    const double start     = (double) args.getProperty ("start", 0.0);
    const auto clipName    = args.getProperty ("name", "Drums").toString();

    // Agents often send velocity on a 0-1 scale, or as fractional MIDI — the
    // literal (int) read above truncates those to 0 and the parse fails. Normalize
    // the two reasonable shapes from the raw var instead (MIRRORED in
    // drumPatternUtil.ts normalizeDrumVelocity — keep in lockstep).
    {
        const double rawVelocity = (double) args.getProperty ("velocity", 100);
        if (rawVelocity > 0.0 && rawVelocity < 1.0)
            velocity = juce::jmax (1, (int) std::lround (rawVelocity * 127.0));
        else if (std::abs (rawVelocity - (double) std::lround (rawVelocity)) > 1e-9)
            velocity = (int) std::lround (rawVelocity);
    }

    // Validate + parse + resolve the target BEFORE the transaction: every error
    // path below leaves no empty undo step (the cmdLoadDrumKit discipline).
    const auto parsed = parseDrumPattern (pattern, stepsPerBar, bars, velocity);
    if (! parsed.ok)
        return errResult ("add_drum_pattern", parsed.error);
    const auto laneHasPitch = [&parsed] (int pitch)
    {
        for (int p : parsed.lanePitches) if (p == pitch) return true;
        return false;
    };

    te::MidiClip* targetClip = nullptr;
    te::AudioTrack* track = nullptr;
    if (clipId.isNotEmpty())
    {
        targetClip = dynamic_cast<te::MidiClip*> (findClip (clipId));
        if (targetClip == nullptr)
            return errResult ("add_drum_pattern", "no midi clip with that id");
    }
    else if (trackId.isNotEmpty())
    {
        track = findTrack (trackId);
        if (track == nullptr)
            return errResult ("add_drum_pattern", "no track with that id");
        for (auto* c : track->getClips())
            if (dynamic_cast<te::WaveAudioClip*> (c) != nullptr)
                return errResult ("add_drum_pattern",
                    juce::String (juce::CharPointer_UTF8 ("track holds wave audio — a drum sampler would silence it; use a drum track")));
    }

    beginTxn ("add_drum_pattern");
    juce::String outClipId, outTrackId;
    int noteCount = 0;
    auto& ts = eng.edit().tempoSequence;

    if (targetClip != nullptr)
    {
        // Per-lane replace: drop ONLY the named lanes' notes (descending keeps
        // indices valid — the cmdAssignSample pad-removal idiom), then re-lay.
        auto& seq = targetClip->getSequence();
        for (int i = seq.getNumNotes(); --i >= 0;)
            if (auto* n = seq.getNote (i))
                if (laneHasPitch (n->getNoteNumber()))
                    seq.removeNote (*n, &undoManager());

        const int beatsPerBar = ts.getTimeSigAt (targetClip->getPosition().getStart()).numerator.get();
        const double sb = drumPatternStepBeats ((double) beatsPerBar, parsed.stepsPerBar);
        for (const auto& s : parsed.steps)
            seq.addNote (s.pitch, tracktion::BeatPosition::fromBeats (s.step * sb),
                         tracktion::BeatDuration::fromBeats (sb), s.velocity, 0, &undoManager());
        noteCount = seq.getNumNotes();
        outClipId = targetClip->itemID.toString();
        if (auto* tr = targetClip->getTrack())
            outTrackId = tr->itemID.toString();
    }
    else
    {
        if (track == nullptr)
        {
            track = createAudioTrack ("Drums");
            if (track == nullptr) return errResult ("add_drum_pattern", "no track");
            track->state.setProperty (ids::trackType, "drum", &undoManager());
            ensureDefaultInstrument (*track, true);
        }
        else if (! trackHasInstrument (*track))
        {
            if (track->state.getProperty (ids::trackType, "audio").toString() != "drum")
                track->state.setProperty (ids::trackType, "drum", &undoManager());
            ensureDefaultInstrument (*track, true);
        }
        // else: the track's instrument choice is respected (raw-pitch lanes can
        // drive an assign_sample'd melodic 808 or a custom pad map).

        const auto startTime = tracktion::TimePosition::fromSeconds (start);
        const int beatsPerBar = ts.getTimeSigAt (startTime).numerator.get();
        const double sb = drumPatternStepBeats ((double) beatsPerBar, parsed.stepsPerBar);
        const auto endTime = ts.toTime (tracktion::BeatPosition::fromBeats (
            ts.toBeats (startTime).inBeats() + (double) parsed.bars * beatsPerBar));
        auto clip = track->insertMIDIClip (clipName, { startTime, endTime }, nullptr);
        if (clip == nullptr) return errResult ("add_drum_pattern", "insertMIDIClip failed");

        auto& seq = clip->getSequence();
        for (const auto& s : parsed.steps)
            seq.addNote (s.pitch, tracktion::BeatPosition::fromBeats (s.step * sb),
                         tracktion::BeatDuration::fromBeats (sb), s.velocity, 0, &undoManager());
        noteCount = seq.getNumNotes();
        outClipId = clip->itemID.toString();
        outTrackId = track->itemID.toString();
    }

    // METER-001 — self-healing for both branches (targetClip's own track may pre-date
    // this fix; the new-track branch's instrument load is already behind us here).
    // Resolved via outTrackId (not the `track` local, which stays null in the
    // per-lane-replace/targetClip branch) so one call covers both paths.
    if (auto* mt = findTrack (outTrackId))
        ensureTrackMeter (*mt);

    auto* data = new DynamicObject();
    data->setProperty ("clipId", outClipId);
    data->setProperty ("trackId", outTrackId);
    data->setProperty ("noteCount", noteCount);
    data->setProperty ("steps", parsed.totalSteps);
    data->setProperty ("bars", parsed.bars);
    logLine ("add_drum_pattern", args, true, {}, true);
    emitSnapshotInvalidated();
    if (targetClip != nullptr)
        reactiveTouch (outClipId);   // add_note parity: a re-laid pattern re-fires a live re-imagine
    return okResult ("add_drum_pattern", var (data));
}

// Audio -> MIDI: transcribe a wave clip with Basic Pitch (out-of-process, via the
// service /transcribe). ASYNC — inference is ~1-3s, so we run it off the message
// thread and emit transcribe_status {working|done|error}; on success the result is
// landed via the existing add_midi_clip mutation path (a new, time-aligned MIDI
// track). v1 transcribes the whole SOURCE file and places notes from 0 (exact for an
// untrimmed take; a trimmed/offset clip is a documented refinement).
juce::var MoshOps::cmdTranscribeClip (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto mode = args.getProperty ("mode", "mono").toString();
    if (mode != "mono" && mode != "poly") mode = "mono";

    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (w == nullptr) return errResult ("transcribe_clip", "no wave clip with that id");
    const auto srcFile = w->getCurrentSourceFile();
    if (! srcFile.existsAsFile()) return errResult ("transcribe_clip", "clip has no readable source audio");

    const double clipStart = w->getPosition().getStart().inSeconds();
    const auto srcName = w->getName();
    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    const double bpm = tempo != nullptr ? tempo->getBpm() : 120.0;

    // Land a transcription result (notes in SECONDS) as a new, time-aligned MIDI track
    // via the existing add_midi_clip mutation path. ALWAYS runs on the message thread
    // (inline for wait:true; via callAsync for the async GUI path). Returns the
    // command result so the synchronous caller (harness / agent) sees the new ids.
    auto land = [this, clipId, srcName, clipStart, bpm] (bool ok, const juce::String& err, const juce::var& notesVar) -> juce::var
    {
        if (! ok || ! notesVar.isArray())
        {
            const auto msg = err.isNotEmpty() ? err : juce::String ("transcription unavailable");
            emit ("transcribe_status", [&] { auto* o = new juce::DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return juce::var (o); }());
            return errResult ("transcribe_clip", msg);
        }
        // Convert seconds -> clip-local beats.
        juce::Array<var> notes;
        double maxEndS = 0.0;
        for (auto& n : *notesVar.getArray())
        {
            const double s = (double) n.getProperty ("start", 0.0);
            const double e = (double) n.getProperty ("end", 0.0);
            auto* note = new juce::DynamicObject();
            note->setProperty ("pitch", (int) n.getProperty ("pitch", 60));
            note->setProperty ("start", s * bpm / 60.0);
            note->setProperty ("length", juce::jmax (0.0625, (e - s) * bpm / 60.0));
            note->setProperty ("velocity", (int) n.getProperty ("velocity", 100));
            notes.add (juce::var (note));
            maxEndS = juce::jmax (maxEndS, e);
        }
        auto* a = new juce::DynamicObject();
        a->setProperty ("name", juce::String (juce::CharPointer_UTF8 ("MIDI \xe2\x80\xa2 ")) + srcName);   // "MIDI • <clip>"
        a->setProperty ("start", clipStart);
        a->setProperty ("length", juce::jmax (1.0, maxEndS + 0.1));
        a->setProperty ("notes", juce::var (notes));
        auto addRes = cmdAddMidiClip (juce::var (a));   // new track + clip + notes; emits snapshot_invalidated
        auto addData = addRes.getProperty ("data", var());

        emit ("transcribe_status", [&] { auto* o = new juce::DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("state", "done");
            o->setProperty ("noteCount", (int) notes.size()); return juce::var (o); }());

        auto* d = new juce::DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("noteCount", (int) notes.size());
        d->setProperty ("trackId", addData.getProperty ("trackId", var()));
        d->setProperty ("midiClipId", addData.getProperty ("clipId", var()));
        return okResult ("transcribe_clip", juce::var (d));
    };

    emit ("transcribe_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("state", "working");
        o->setProperty ("mode", mode); return var (o); }());
    logLine ("transcribe_clip", args, true, {}, false);

    // Synchronous mode (harness / agent): block on the transcription + land inline.
    if ((bool) args.getProperty ("wait", false))
    {
        auto result = jobManager.transcribe (srcFile, mode);
        return land ((bool) result.getProperty ("ok", false),
                     result.getProperty ("error", var()).toString(),
                     result.getProperty ("notes", var()));
    }

    // Async (GUI): inference off the message thread; land via callAsync.
    std::thread ([this, srcFile, mode, land]
    {
        auto result = jobManager.transcribe (srcFile, mode);
        const bool ok = (bool) result.getProperty ("ok", false);
        const auto err = result.getProperty ("error", var()).toString();
        auto notesVar = result.getProperty ("notes", var());
        juce::MessageManager::callAsync ([land, ok, err, notesVar] { land (ok, err, notesVar); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("transcribe_clip", var (data));
}

// Sketch Phase 0 (the embodied-capture wedge): a recorded beatbox WAV + a KNOWN bpm
// becomes a real, editable drum clip, emitted PURELY as MoshOps. The transduction
// (onset detect → kick/snare/hat heuristic → 16th-grid quantise → velocity) runs
// out-of-process under the dedicated sketch venv via the service /sketch; the result
// is landed through the existing command bodies (set_tempo → create_track{drum} →
// add_midi_clip). Deterministic: same WAV + same bpm + same bars → same hits → same
// notes (the CLI fixes its analysis params and uses no RNG). Mirrors cmdTranscribeClip.
juce::var MoshOps::cmdSketchBeatbox (const juce::var& args)
{
    const auto file = args.getProperty ("file", var()).toString();
    const double bpm = (double) args.getProperty ("bpm", 0.0);
    const int    bars = juce::jlimit (1, 2, (int) args.getProperty ("bars", 1));
    const bool   wait = (bool) args.getProperty ("wait", false);

    juce::File wav (file);
    if (file.isEmpty() || ! wav.existsAsFile())
        return errResult ("sketch_beatbox", "no readable audio file: " + file);
    if (bpm < 20.0 || bpm > 300.0)
        return errResult ("sketch_beatbox", juce::String (juce::CharPointer_UTF8 ("bpm must be 20-300 (the tempo is known — box to a click)")));

    const auto srcName = wav.getFileNameWithoutExtension();

    // Land transduced hits ({step,role,velocity}) as drum MoshOps. ALWAYS on the message
    // thread (inline for wait:true; via callAsync for the async GUI path). Returns the
    // command result so the synchronous caller (harness / agent) sees the new ids + the
    // deterministic transduction artifacts (hits/notes) for an across-runs equality check.
    auto land = [this, file, bpm, bars, srcName] (bool ok, const juce::String& err, const juce::var& hitsVar) -> juce::var
    {
        if (! ok || ! hitsVar.isArray())
        {
            const auto msg = err.isNotEmpty() ? err : juce::String ("beatbox transduction unavailable");
            emit ("sketch_status", [&] { auto* o = new juce::DynamicObject();
                o->setProperty ("file", file); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return juce::var (o); }());
            return errResult ("sketch_beatbox", msg);
        }

        // role → GM percussion pitch (mirrors kDefaultKit: kick 36, snare 38, closed hat 42).
        auto rolePitch = [] (const juce::String& r) -> int {
            if (r == "snare") return 38;
            if (r == "hat")   return 42;
            return 36;   // kick (and the safe default)
        };

        const double sixteenth  = 0.25;            // beats — one 16th on the grid
        const double loopBeats  = bars * 4.0;      // 4/4
        const double loopSeconds = loopBeats * 60.0 / bpm;

        // Musical events (in clip-local BEATS) + a normalised copy of the hits. Neither
        // carries engine ids, so both are byte-identical across runs for the same input.
        juce::Array<var> notes, hitsOut;
        for (auto& h : *hitsVar.getArray())
        {
            const int step = (int) h.getProperty ("step", 0);
            const auto role = h.getProperty ("role", "kick").toString();
            const int vel  = juce::jlimit (1, 127, (int) h.getProperty ("velocity", 100));

            auto* note = new juce::DynamicObject();
            note->setProperty ("pitch", rolePitch (role));
            note->setProperty ("start", step * sixteenth);
            note->setProperty ("length", sixteenth);
            note->setProperty ("velocity", vel);
            notes.add (juce::var (note));

            auto* ho = new juce::DynamicObject();
            ho->setProperty ("step", step);
            ho->setProperty ("role", role);
            ho->setProperty ("velocity", vel);
            hitsOut.add (juce::var (ho));
        }

        auto recordOp = [] (const char* cmd, const juce::var& a) {
            auto* o = new juce::DynamicObject();
            o->setProperty ("command", cmd);
            o->setProperty ("args", a);
            return juce::var (o);
        };

        // Emit PURELY as MoshOps, via the existing command bodies (the one mutation path).
        // Coalesce the trio into ONE undo transaction so a single Ctrl-Z reverts the whole
        // "sketch a beatbox" action (otherwise it fragments into 3 steps and a partial undo
        // strands an empty drum track + altered tempo). Reuse the batch flag the agent uses
        // (beginTxn skips its own beginNewTransaction while inBatch); respect an outer batch.
        const bool ownBatch = ! inBatch;
        if (ownBatch) { beginUndoTransaction ("sketch_beatbox"); inBatch = true; }

        juce::Array<var> emitted;

        { auto* a = new juce::DynamicObject(); a->setProperty ("bpm", bpm);
          juce::var av (a); cmdSetTempo (av); emitted.add (recordOp ("set_tempo", av)); }

        juce::String trackId;
        { auto* a = new juce::DynamicObject(); a->setProperty ("type", "drum"); a->setProperty ("name", "Sketch");
          juce::var av (a); auto r = cmdCreateTrack (av);
          trackId = r.getProperty ("data", var()).getProperty ("trackId", var()).toString();
          emitted.add (recordOp ("create_track", av)); }

        juce::String clipId;
        { auto* a = new juce::DynamicObject();
          a->setProperty ("trackId", trackId);
          a->setProperty ("name", juce::String (juce::CharPointer_UTF8 ("Sketch \xe2\x80\xa2 ")) + srcName);   // "Sketch • <file>" (parity with transcribe)
          a->setProperty ("start", 0.0);
          a->setProperty ("length", loopSeconds);
          a->setProperty ("notes", juce::var (notes));
          juce::var av (a); auto r = cmdAddMidiClip (av);
          clipId = r.getProperty ("data", var()).getProperty ("clipId", var()).toString();
          emitted.add (recordOp ("add_midi_clip", av)); }

        if (ownBatch) inBatch = false;

        // §6 training byproduct — append the session tuple (RETAIN the user's own audio
        // ref: it is clean, owned provenance). Cheap to log now, expensive to reconstruct.
        {
            auto* t = new juce::DynamicObject();
            t->setProperty ("ts", juce::Time::getCurrentTime().toMilliseconds());
            t->setProperty ("tempo_bpm", bpm);
            t->setProperty ("bars", bars);
            juce::Array<var> mods; mods.add ("drums");
            t->setProperty ("modalities", juce::var (mods));
            auto* in = new juce::DynamicObject(); in->setProperty ("audio_ref", file);
            t->setProperty ("input", juce::var (in));
            auto* prim = new juce::DynamicObject(); prim->setProperty ("drums", juce::var (hitsOut));
            t->setProperty ("transduced_primitives", juce::var (prim));
            t->setProperty ("emitted_moshops", juce::var (emitted));
            auto* res = new juce::DynamicObject();
            res->setProperty ("trackId", trackId);
            res->setProperty ("midiClipId", clipId);
            res->setProperty ("noteCount", notes.size());
            t->setProperty ("result", juce::var (res));
            eng.sessionDir().getChildFile ("sketch-sessions.jsonl")
                .appendText (juce::JSON::toString (juce::var (t), true) + "\n");
        }

        emit ("sketch_status", [&] { auto* o = new juce::DynamicObject();
            o->setProperty ("file", file); o->setProperty ("state", "done");
            o->setProperty ("hitCount", (int) hitsOut.size());
            o->setProperty ("noteCount", (int) notes.size()); return juce::var (o); }());

        auto* d = new juce::DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("bpm", bpm);
        d->setProperty ("bars", bars);
        d->setProperty ("trackId", trackId);
        d->setProperty ("midiClipId", clipId);
        d->setProperty ("hitCount", (int) hitsOut.size());
        d->setProperty ("noteCount", (int) notes.size());
        d->setProperty ("hits", juce::var (hitsOut));   // transduced primitives (deterministic)
        d->setProperty ("notes", juce::var (notes));    // musical events in beats (deterministic)
        d->setProperty ("moshops", juce::var (emitted));
        return okResult ("sketch_beatbox", juce::var (d));
    };

    // sketch_status {working|done|error} mirrors transcribe_status for a future capture UI
    // (Phase 4). In Phase 0 the only caller is the agent/harness via wait:true, which surfaces
    // any failure directly in the command RESULT (errResult) — so an error is never swallowed;
    // the async branch's event is purely forward-looking until that UI lands.
    emit ("sketch_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("file", file); o->setProperty ("state", "working");
        o->setProperty ("bpm", bpm); o->setProperty ("bars", bars); return var (o); }());
    logLine ("sketch_beatbox", args, true, {}, false);

    // Synchronous (harness / agent): block on the transduction + land inline.
    if (wait)
    {
        auto result = jobManager.sketchBeatbox (wav, bpm, bars);
        return land ((bool) result.getProperty ("ok", false),
                     result.getProperty ("error", var()).toString(),
                     result.getProperty ("hits", var()));
    }

    // Async (GUI): onset analysis off the message thread; land via callAsync.
    std::thread ([this, wav, bpm, bars, land]
    {
        auto result = jobManager.sketchBeatbox (wav, bpm, bars);
        const bool ok = (bool) result.getProperty ("ok", false);
        const auto err = result.getProperty ("error", var()).toString();
        auto hitsVar = result.getProperty ("hits", var());
        juce::MessageManager::callAsync ([land, ok, err, hitsVar] { land (ok, err, hitsVar); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("sketch_beatbox", var (data));
}

juce::var MoshOps::cmdGenerateBeatRecipe (const juce::var& args)
{
    auto* body = new DynamicObject();
    if (args.hasProperty ("mood")) body->setProperty ("mood", args.getProperty ("mood", var()));
    if (args.hasProperty ("tempo")) body->setProperty ("tempo", args.getProperty ("tempo", var()));
    if (args.hasProperty ("key")) body->setProperty ("key", args.getProperty ("key", var()));
    if (args.hasProperty ("seed")) body->setProperty ("seed", args.getProperty ("seed", var()));
    if (args.hasProperty ("lead")) body->setProperty ("lead", args.getProperty ("lead", var()));
    if (args.hasProperty ("libraryDir")) body->setProperty ("libraryDir", args.getProperty ("libraryDir", var()));
    if (args.hasProperty ("paletteManifest")) body->setProperty ("paletteManifest", args.getProperty ("paletteManifest", var()));

    auto generated = jobManager.generateBeatRecipe (var (body));
    if (! generated.isObject() || ! (bool) generated.getProperty ("ok", false))
    {
        const auto msg = generated.isObject()
            ? generated.getProperty ("error", var ("recipe generation service unavailable")).toString()
            : juce::String ("recipe generation service unavailable");
        logLine ("generate_beat_recipe", args, false, msg, false);
        return errResult ("generate_beat_recipe", msg);
    }

    auto program = generated.getProperty ("program", var());
    auto commands = program.getProperty ("commands", var());
    if (! commands.isArray() || commands.size() == 0)
    {
        logLine ("generate_beat_recipe", args, false, "empty generated program", false);
        return errResult ("generate_beat_recipe", "empty generated program");
    }

    const bool ownBatch = ! inBatch;
    if (ownBatch)
    {
        beginUndoTransaction ("generate_beat_recipe");
        inBatch = true;
    }

    juce::NamedValueSet refs;
    juce::Array<var> applied;
    juce::String failure;
    int appliedCount = 0;

    for (auto& call : *commands.getArray())
    {
        const auto name = call.getProperty ("command", var()).toString();
        if (! isGeneratedRecipeCommandAllowed (name))
        {
            failure = "generated program contains disallowed command: " + name;
            break;
        }

        juce::StringArray missing;
        auto resolvedArgs = resolveGeneratedRecipeRefs (call.getProperty ("args", var (new DynamicObject())),
                                                        refs, missing);
        if (! missing.isEmpty())
        {
            failure = "generated program has unbound ref " + missing.joinIntoString (", ");
            break;
        }

        auto* step = new DynamicObject();
        step->setProperty ("command", name);
        step->setProperty ("args", resolvedArgs);
        auto stepResult = execute (var (step));
        const bool ok = (bool) stepResult.getProperty ("ok", false);

        auto* record = new DynamicObject();
        record->setProperty ("command", name);
        record->setProperty ("args", resolvedArgs);
        record->setProperty ("ok", ok);
        if (! ok)
            record->setProperty ("error", stepResult.getProperty ("error", var()).toString());
        applied.add (var (record));

        if (! ok)
        {
            failure = name + ": " + stepResult.getProperty ("error", var ("failed")).toString();
            break;
        }

        captureGeneratedRecipeRefs (call, stepResult, refs);
        ++appliedCount;
    }

    if (ownBatch)
        inBatch = false;

    if (failure.isNotEmpty())
    {
        if (ownBatch && appliedCount > 0)
        {
            undoManager().undo();
            eng.markDirty();
            emitSnapshotInvalidated();
        }
        logLine ("generate_beat_recipe", args, false, failure, false);
        return errResult ("generate_beat_recipe", failure);
    }

    logLine ("generate_beat_recipe", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("status", "done");
    data->setProperty ("recipeId", generated.getProperty ("recipeId", var()));
    data->setProperty ("commandCount", commands.size());
    data->setProperty ("appliedCount", appliedCount);
    data->setProperty ("unresolved", program.getProperty ("unresolved", var (Array<var>{})));
    data->setProperty ("provenance", generated.getProperty ("provenance", var()));
    data->setProperty ("applied", var (applied));
    return okResult ("generate_beat_recipe", var (data));
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

    // A `notes` ARRAY may replace the scalar pitch/start/length/velocity, so a chord —
    // several keys pressed together on the computer MIDI keyboard, or a pasted selection —
    // lands inside the ONE transaction opened below and undoes as a single step. Same
    // shape cmdAddMidiClip already accepts. (Deliberately not declared in the agent
    // catalog: ArgSpec models only string/number/boolean, and the contract test checks
    // that declared args are read, never the converse — add_midi_clip does the same.)
    struct NoteSpec { int pitch; double start; double length; int vel; };
    std::vector<NoteSpec> specs;
    const auto notesVar = args.getProperty ("notes", var());   // bind: the temporary would die
    if (auto* arr = notesVar.getArray())
    {
        for (auto& n : *arr)
            specs.push_back ({ juce::jlimit (0, 127, (int) n.getProperty ("pitch", 60)),
                               juce::jmax (0.0, (double) n.getProperty ("start", 0.0)),
                               juce::jmax (0.0625, (double) n.getProperty ("length", 1.0)),
                               juce::jlimit (1, 127, (int) n.getProperty ("velocity", 100)) });
        if (specs.empty()) return errResult ("add_note", "'notes' is empty");
    }
    else
    {
        specs.push_back ({ juce::jlimit (0, 127, (int) args.getProperty ("pitch", 60)),
                           juce::jmax (0.0, (double) args.getProperty ("start", 0.0)),
                           juce::jmax (0.0625, (double) args.getProperty ("length", 1.0)),
                           juce::jlimit (1, 127, (int) args.getProperty ("velocity", 100)) });
    }

    beginTxn ("add_note");
    auto& seq = mc->getSequence();
    Array<var> added;
    for (auto& s : specs)
    {
        auto* note = seq.addNote (s.pitch, tracktion::BeatPosition::fromBeats (s.start),
                                  tracktion::BeatDuration::fromBeats (s.length), s.vel, 0, &undoManager());
        // The index of the note we just made. MidiList keeps its notes sorted, so a new
        // note is NOT necessarily last — callers that need to address it (step record,
        // duplicate, "select what I just drew") would otherwise have to re-fetch the whole
        // snapshot and guess. Resolved by identity against the returned pointer.
        int idx = -1;
        for (int i = 0; i < seq.getNumNotes(); ++i)
            if (seq.getNote (i) == note) { idx = i; break; }
        added.add (idx);
    }
    logLine ("add_note", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3 — auto-re-render the live hidden audio
    auto* data = new DynamicObject();
    data->setProperty ("noteCount", seq.getNumNotes());
    data->setProperty ("noteIndex", added.size() == 1 ? added[0] : var (-1));
    data->setProperty ("noteIndexes", added);
    return okResult ("add_note", var (data));
}

juce::var MoshOps::cmdRemoveNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("remove_note", "no midi clip");
    auto& seq = mc->getSequence();
    const int idx = (int) args.getProperty ("noteIndex", -1);
    if (idx < 0 || idx >= seq.getNumNotes()) return errResult ("remove_note", "bad noteIndex");

    beginTxn ("remove_note");
    seq.removeNote (*seq.getNote (idx), &undoManager());
    logLine ("remove_note", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    return okResult ("remove_note");
}

juce::var MoshOps::cmdSetNote (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("set_note", "no midi clip");
    auto& seq = mc->getSequence();

    // An `edits` ARRAY may replace the scalar noteIndex/pitch/…, so a whole selection —
    // the piano roll's group drag — moves in ONE command and one undo step.
    //
    // It is not merely a convenience. setStartAndLength writes IDs::b, which triggers
    // tracktion's SYNCHRONOUS re-sort of the live MidiList, so a note can hop to a new
    // index the moment it is moved. N separate set_note calls therefore address stale
    // indices as soon as the first one changes a start — a real bug, caught by the
    // batched-move selftest below. Resolving every note POINTER up front, before any
    // mutation, is immune to that; it is the same guard cmdQuantizeNotes documents.
    struct Edit { te::MidiNote* note; juce::var spec; };
    std::vector<Edit> edits;
    const auto editsVar = args.getProperty ("edits", var());   // bind: the temporary would die
    if (auto* arr = editsVar.getArray())
    {
        for (auto& e : *arr)
        {
            const int i = (int) e.getProperty ("noteIndex", -1);
            if (i < 0 || i >= seq.getNumNotes()) return errResult ("set_note", "bad noteIndex");
            edits.push_back ({ seq.getNote (i), e });
        }
        if (edits.empty()) return errResult ("set_note", "'edits' is empty");
    }
    else
    {
        const int idx = (int) args.getProperty ("noteIndex", -1);
        if (idx < 0 || idx >= seq.getNumNotes()) return errResult ("set_note", "bad noteIndex");
        edits.push_back ({ seq.getNote (idx), args });
    }

    // One note's worth of the request. Its parameter is genuinely an args object — the
    // whole command's for a scalar call, one element of `edits` for a group one — which
    // is why the field reads below stay on `args` rather than an alias.
    auto applyOne = [this] (te::MidiNote* note, const juce::var& args)
    {
        if (note == nullptr) return;
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
        // Note DEACTIVATE (Ableton's `0` key) — a muted note keeps its place in the clip
        // and stays editable, it simply doesn't sound. This is the engine's own
        // MidiNote::mute field, so it costs nothing and persists with the edit; it is also
        // why per-note probability is NOT here (MidiNote has no such field, and faking one
        // would mean intervening in the MIDI playback path).
        if (args.hasProperty ("mute"))
            note->setMute ((bool) args.getProperty ("mute", false), &undoManager());
    };

    beginTxn ("set_note");
    for (auto& ed : edits)
        applyOne (ed.note, ed.spec);

    logLine ("set_note", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    return okResult ("set_note");
}

juce::var MoshOps::cmdQuantizeNotes (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("quantize_notes", "no midi clip");
    auto& seq = mc->getSequence();

    const double division = juce::jmax (0.03125, (double) args.getProperty ("division", 1.0));   // beats
    const double strength = juce::jlimit (0.0, 1.0, (double) args.getProperty ("strength", 1.0));
    // SWING (CAP-MID-004, #552) — 0..100, 0 = straight, and 0 is the DEFAULT. Swing DELAYS
    // every second subdivision of the quantize grid and leaves the on-beat subdivisions
    // exactly where they are; FL's Swing knob and Reaper's quantize-dialog swing slider
    // agree on that shape (Live reaches the same result through the Groove Pool), so it is
    // what the capability matrix's 2-of-4 rule licenses and all that is implemented here.
    //
    // 100 is the classic MPC 75% ceiling: the off-beat lands exactly HALFWAY to the next
    // on-beat, so no amount of swing can ever push a note onto (or past) its neighbour.
    // MPC% = 50 + swing/4, so the triplet feel (MPC 66.7%) is swing ≈ 67.
    //
    // The invariant: absent or 0 must leave this handler BYTE-IDENTICAL to the pre-swing
    // one. Hence `swingOffset > 0.0` gates the only new arithmetic and selects `q` ITSELF
    // rather than `q + 0.0` — the default path executes the same operations in the same
    // order as before, so every pre-existing quantize check passes unedited.
    const double swing = juce::jlimit (0.0, 100.0, (double) args.getProperty ("swing", 0.0));
    const double swingOffset = (swing / 100.0) * (division * 0.5);   // beats, ≤ half a subdivision

    beginTxn ("quantize_notes");
    int moved = 0, swung = 0;
    // Snapshot the note pointers ONCE before mutating: setStartAndLength() writes
    // IDs::b, which triggers tracktion's synchronous re-sort of the live MidiList
    // (the same hazard MidiList::moveAllBeatPositions/rescale guard against by
    // binding getNotes() once). Walking seq.getNote(i) live means a note that gets
    // re-sorted past an already-visited index is silently skipped; iterating a
    // fixed local list avoids that.
    juce::Array<te::MidiNote*> notes;
    for (int i = 0; i < seq.getNumNotes(); ++i)
        notes.add (seq.getNote (i));
    for (auto* note : notes)
    {
        const double start = note->getStartBeat().inBeats();
        const double slot  = std::round (start / division);       // which subdivision it belongs to
        const double q     = slot * division;
        // Odd slots are the "and"s — the second subdivision of every pair — and are the
        // ones swing pushes late. Even slots are the on-beats and never move.
        const bool offbeat = (std::llround (slot) % 2) != 0;
        const double target = (swingOffset > 0.0 && offbeat) ? q + swingOffset : q;
        // strength interpolates toward the SWUNG target, so a partial quantize keeps the
        // groove it is moving toward instead of pulling notes to a straight grid first.
        const double next = start + (target - start) * strength;
        if (std::abs (next - start) > 1.0e-6)
        {
            note->setStartAndLength (tracktion::BeatPosition::fromBeats (juce::jmax (0.0, next)),
                                     note->getLengthBeats(), &undoManager());
            ++moved;
            if (swingOffset > 0.0 && offbeat) ++swung;
        }
    }
    logLine ("quantize_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    auto* data = new DynamicObject();
    data->setProperty ("moved", moved);
    data->setProperty ("swung", swung);   // of `moved`, how many were off-beats pushed late
    return okResult ("quantize_notes", var (data));
}

// ── Live 12's velocity tool row (Randomize / Ramp / Deviation) ────────────────
// ONE command for the whole gesture — the producer perceives a single edit, so a
// fan-out of set_note calls would spam both undo and the JSONL log. Target = an
// explicit noteIndexes array (the editor's selection), else EVERY note in the
// clip (Live's rule for these tools). Modes:
//   randomize <amount> — uniform ±amount around each note's current velocity
//   ramp <lo> <hi>     — linear lo→hi across the targets in time order (ties by pitch)
//   deviate <amount>   — uniform offset in [-amount, +amount] per note
// (randomize and deviate share the ±amount shape by design in Live's row; each mode
// seeds independently so both stay deterministic.) Velocities clamp to 1..127.
// The randomness is SEEDED from the canonical args + the target notes' current
// state (FNV-1a → mt19937_64), so replaying the logged command against the same
// pre-state reproduces the exact same numbers — the JSONL log stays a program.
juce::var MoshOps::cmdTransformVelocities (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("transform_velocities", "no midi clip");
    const auto mode = args.getProperty ("mode", var()).toString();
    if (mode != "randomize" && mode != "ramp" && mode != "deviate")
        return errResult ("transform_velocities", "mode must be randomize|ramp|deviate");
    auto& seq = mc->getSequence();

    std::vector<te::MidiNote*> targets;
    const auto idxVar = args.getProperty ("noteIndexes", var());   // bind: the temporary would die
    if (auto* arr = idxVar.getArray())
    {
        if (arr->isEmpty()) return errResult ("transform_velocities", "'noteIndexes' is empty");
        for (auto& v : *arr)
        {
            const int i = (int) v;
            if (i < 0 || i >= seq.getNumNotes()) return errResult ("transform_velocities", "bad noteIndex");
            targets.push_back (seq.getNote (i));
        }
    }
    else
        for (int i = 0; i < seq.getNumNotes(); ++i)
            targets.push_back (seq.getNote (i));
    if (targets.empty()) return errResult ("transform_velocities", "no notes to transform");

    const int amount = juce::jlimit (0, 127, (int) args.getProperty ("amount", 0));
    const int lo     = juce::jlimit (1, 127, (int) args.getProperty ("lo", 1));
    const int hi     = juce::jlimit (1, 127, (int) args.getProperty ("hi", 127));
    if (mode == "ramp" && (! args.hasProperty ("lo") || ! args.hasProperty ("hi")))
        return errResult ("transform_velocities", "ramp needs 'lo' and 'hi'");
    if (mode != "ramp" && ! args.hasProperty ("amount"))
        return errResult ("transform_velocities", "mode needs 'amount'");

    // Deterministic seed: FNV-1a over mode/clip/args + each target's identity and
    // current velocity — identical command + identical pre-state ⇒ identical result.
    uint64_t h = 1469598103934665603ULL;
    auto mix = [&h] (uint64_t v) { h ^= v; h *= 1099511628211ULL; };
    const auto seedText = mode + "|" + args.getProperty ("clipId", var()).toString();
    for (int si = 0; si < seedText.length(); ++si) mix ((uint64_t) (uint8_t) seedText[si]);
    mix ((uint64_t) amount); mix ((uint64_t) lo); mix ((uint64_t) hi);
    for (auto* n : targets)
    {
        mix ((uint64_t) n->getNoteNumber());
        mix ((uint64_t) n->getVelocity());
        mix ((uint64_t) std::llround (n->getStartBeat().inBeats() * 1.0e6));
    }
    std::mt19937_64 rng (h);

    beginTxn ("transform_velocities");
    int changed = 0;
    if (mode == "ramp")
    {
        auto sorted = targets;
        std::sort (sorted.begin(), sorted.end(), [] (const te::MidiNote* a, const te::MidiNote* b) {
            if (a->getStartBeat() != b->getStartBeat()) return a->getStartBeat() < b->getStartBeat();
            return a->getNoteNumber() < b->getNoteNumber();
        });
        const int n = (int) sorted.size();
        for (int i = 0; i < n; ++i)
        {
            const double t = n > 1 ? (double) i / (double) (n - 1) : 0.0;
            const int v = juce::jlimit (1, 127, (int) std::lround (lo + (hi - lo) * t));
            if (v != sorted[i]->getVelocity()) { sorted[i]->setVelocity (v, &undoManager()); ++changed; }
        }
    }
    else
    {
        std::uniform_int_distribution<int> dist (-amount, amount);
        for (auto* n : targets)
        {
            const int v = juce::jlimit (1, 127, n->getVelocity() + dist (rng));
            if (v != n->getVelocity()) { n->setVelocity (v, &undoManager()); ++changed; }
        }
    }

    logLine ("transform_velocities", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    auto* data = new DynamicObject();
    data->setProperty ("mode", mode);
    data->setProperty ("changed", changed);
    return okResult ("transform_velocities", var (data));
}

juce::var MoshOps::cmdTransformNotes (const juce::var& args)
{
    auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (mc == nullptr) return errResult ("transform_notes", "no midi clip");
    const auto mode = args.getProperty ("mode", var()).toString();
    if (mode != "reverse" && mode != "invert" && mode != "legato"
        && mode != "humanize" && mode != "x2" && mode != "d2"
        && mode != "setLength" && mode != "addInterval" && mode != "fitToScale")
        return errResult ("transform_notes", "mode must be reverse|invert|legato|humanize|x2|d2|setLength|addInterval|fitToScale");
    auto& seq = mc->getSequence();

    // Targets: the explicit noteIndexes array, else ALL notes (Live's rule — same
    // as transform_velocities). Snapshot every target's state BEFORE any mutation:
    // setStartAndLength can re-sort the sequence mid-loop, so the math runs on the
    // captured values and applies by pointer.
    struct Target { te::MidiNote* n; double start, len; int pitch, vel; };
    std::vector<Target> targets;
    const auto idxVar = args.getProperty ("noteIndexes", var());   // bind: the temporary would die
    auto pushNote = [&] (int i) -> bool {
        if (i < 0 || i >= seq.getNumNotes()) return false;
        auto* n = seq.getNote (i);
        targets.push_back ({ n, n->getStartBeat().inBeats(), n->getLengthBeats().inBeats(),
                             n->getNoteNumber(), n->getVelocity() });
        return true;
    };
    if (auto* arr = idxVar.getArray())
    {
        if (arr->isEmpty()) return errResult ("transform_notes", "'noteIndexes' is empty");
        const int noteCount = seq.getNumNotes();
        if (arr->size() > noteCount)
            return errResult ("transform_notes", "too many noteIndexes");
        std::vector<bool> seen (static_cast<size_t> (noteCount), false);
        for (auto& v : *arr)
        {
            if (! v.isInt() && ! v.isInt64())
                return errResult ("transform_notes", "bad noteIndex");
            const auto rawIndex = static_cast<juce::int64> (v);
            if (rawIndex < 0 || rawIndex >= noteCount)
                return errResult ("transform_notes", "bad noteIndex");
            const int i = static_cast<int> (rawIndex);
            if (seen[static_cast<size_t> (i)])
                continue;
            seen[static_cast<size_t> (i)] = true;
            if (! pushNote (i)) return errResult ("transform_notes", "bad noteIndex");
        }
    }
    else
        for (int i = 0; i < seq.getNumNotes(); ++i)
            pushNote (i);
    if (targets.empty()) return errResult ("transform_notes", "no notes to transform");

    const int amount = juce::jlimit (0, 100, (int) args.getProperty ("amount", 0));
    if (mode == "humanize" && ! args.hasProperty ("amount"))
        return errResult ("transform_notes", "humanize needs 'amount'");
    const double lengthBeats = (double) args.getProperty ("lengthBeats", 0.0);
    if (mode == "setLength" && (! args.hasProperty ("lengthBeats") || lengthBeats <= 1.0e-4))
        return errResult ("transform_notes", "setLength needs 'lengthBeats' (beats > 0)");
    const int semitones = (int) args.getProperty ("semitones", 0);
    if (mode == "addInterval" && ! args.hasProperty ("semitones"))
        return errResult ("transform_notes", "addInterval needs 'semitones'");

    // fitToScale's mask: the voice.js NOTE_PC / SCALES domains, ported — the engine
    // has no mask helper (TempoProject's kNotePcNames/kScaleNames are validation
    // lists only). Lockstep with ui/src/musicalKey.ts, whose test parses voice.js —
    // the same truth in three places, two of them executable guards. The key is the
    // session key from the MOSH_PROJECT node (A/minor default, same as the snapshot).
    bool scaleMask[12] = {};
    if (mode == "fitToScale")
    {
        static const std::pair<const char*, int> kNotePc[] = {
            { "C", 0 }, { "C#", 1 }, { "Db", 1 }, { "D", 2 }, { "D#", 3 }, { "Eb", 3 },
            { "E", 4 }, { "F", 5 }, { "F#", 6 }, { "Gb", 6 }, { "G", 7 }, { "G#", 8 },
            { "Ab", 8 }, { "A", 9 }, { "A#", 10 }, { "Bb", 10 }, { "B", 11 } };
        static const struct { const char* name; std::initializer_list<int> offs; } kScales[] = {
            { "major", { 0, 2, 4, 5, 7, 9, 11 } }, { "minor", { 0, 2, 3, 5, 7, 8, 10 } },
            { "dorian", { 0, 2, 3, 5, 7, 9, 10 } }, { "mixolydian", { 0, 2, 4, 5, 7, 9, 10 } },
            { "pentatonic", { 0, 3, 5, 7, 10 } },
            { "chromatic", { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } } };
        auto proj = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
        const auto tonicName = proj.hasProperty (ids::musicalTonic)
                                   ? proj.getProperty (ids::musicalTonic).toString()
                                   : juce::String (kDefaultKeyTonic);
        const auto modeName = proj.hasProperty (ids::musicalMode)
                                  ? proj.getProperty (ids::musicalMode).toString()
                                  : juce::String (kDefaultKeyMode);
        int tonicPc = 9;   // A
        for (auto& kv : kNotePc) if (tonicName == kv.first) { tonicPc = kv.second; break; }
        for (auto& s : kScales)
            if (modeName == s.name)
                for (int off : s.offs) scaleMask[(tonicPc + off) % 12] = true;
    }
    // Nearest in-scale pitch; a pitch exactly between two scale tones resolves
    // DOWNWARD (ui/src/musicalKey.ts snapToScale — same algorithm, same ties rule).
    auto pcOf = [] (int p) { return ((p % 12) + 12) % 12; };
    auto snapToMask = [&] (int pitch) {
        pitch = juce::jlimit (0, 127, pitch);
        if (scaleMask[pcOf (pitch)]) return pitch;
        for (int d = 1; d <= 6; ++d)
        {
            if (pitch - d >= 0 && scaleMask[pcOf (pitch - d)]) return pitch - d;   // ties DOWN
            if (pitch + d <= 127 && scaleMask[pcOf (pitch + d)]) return pitch + d;
        }
        return pitch;   // unreachable with any real scale — behave chromatically
    };

    // The span the deterministic modes work inside: the targets' own [min start, max
    // end] — a selection transforms within the SELECTION's span (Live's panel rule).
    double spanStart = std::numeric_limits<double>::max(), spanEnd = 0.0;
    int topPitch = 0;
    for (auto& t : targets)
    {
        spanStart = juce::jmin (spanStart, t.start);
        spanEnd   = juce::jmax (spanEnd, t.start + t.len);
        topPitch  = juce::jmax (topPitch, t.pitch);
    }

    // Deterministic seed for humanize: FNV-1a over mode/clip/amount + each target's
    // identity and current state — the transform_velocities contract (identical
    // command + identical pre-state ⇒ identical result; the JSONL log stays a program).
    uint64_t h = 1469598103934665603ULL;
    auto mix = [&h] (uint64_t v) { h ^= v; h *= 1099511628211ULL; };
    const auto seedText = mode + "|" + args.getProperty ("clipId", var()).toString();
    for (int si = 0; si < seedText.length(); ++si) mix ((uint64_t) (uint8_t) seedText[si]);
    mix ((uint64_t) amount);
    for (auto& t : targets)
    {
        mix ((uint64_t) t.pitch);
        mix ((uint64_t) t.vel);
        mix ((uint64_t) std::llround (t.start * 1.0e6));
    }
    std::mt19937_64 rng (h);

    // Legato's next-onset map: each distinct start extends to the NEXT distinct start;
    // the last group extends to the span end. Same-start notes (chords) share the
    // onset, so no note collapses to zero length. Explicit selections arrive in
    // gesture order, so derive this map independently of noteIndexes order.
    std::vector<double> onsets;
    if (mode == "legato")
    {
        for (auto& t : targets)
            onsets.push_back (t.start);
        std::sort (onsets.begin(), onsets.end());
        onsets.erase (std::unique (onsets.begin(), onsets.end(), [] (double a, double b) {
            return std::abs (a - b) <= 1.0e-9;
        }), onsets.end());
    }
    auto legatoEnd = [&] (double start) {
        for (double o : onsets)
            if (o > start + 1.0e-9) return o;
        return spanEnd;
    };

    // Humanize deviation: timing ±(amount% of a 16th) and velocity ±amount — small by
    // construction at Live's 10% default (±0.025 beats, ±10 velocity).
    const double maxTimeDev = (amount / 100.0) * 0.25;
    std::uniform_real_distribution<double> timeDev (-maxTimeDev, maxTimeDev);
    std::uniform_int_distribution<int> velDev (-amount, amount);

    beginTxn ("transform_notes");
    int changed = 0, added = 0;
    // addInterval's dupe set: every (start, pitch) already sounding in the clip
    // (the whole sequence, not just the targets) plus the tones this pass adds —
    // a chord tone that would stack on an existing note is SKIPPED, never doubled.
    std::set<std::pair<double, int>> sounding;
    if (mode == "addInterval")
        for (int i = 0; i < seq.getNumNotes(); ++i)
            if (auto* n = seq.getNote (i))
                sounding.insert ({ n->getStartBeat().inBeats(), n->getNoteNumber() });
    for (auto& t : targets)
    {
        if (mode == "addInterval")
        {
            // ADDS a chord tone at +N semitones; the source note is never mutated.
            const int cand = juce::jlimit (0, 127, t.pitch + semitones);
            if (cand != t.pitch && sounding.insert ({ t.start, cand }).second)
            {
                seq.addNote (cand, tracktion::BeatPosition::fromBeats (t.start),
                             tracktion::BeatDuration::fromBeats (t.len), t.vel, 0, &undoManager());
                ++added;
            }
            continue;
        }
        double newStart = t.start, newLen = t.len;
        int newPitch = t.pitch, newVel = t.vel;
        if (mode == "reverse")
            newStart = spanStart + (spanEnd - (t.start + t.len));   // mirror inside the span
        else if (mode == "invert")
            newPitch = juce::jlimit (0, 127, 2 * topPitch - t.pitch);   // Live inverts around the top
        else if (mode == "legato")
            newLen = juce::jmax (1.0e-4, legatoEnd (t.start) - t.start);
        else if (mode == "x2") { newStart = spanStart + 2.0 * (t.start - spanStart); newLen = 2.0 * t.len; }
        else if (mode == "d2") { newStart = spanStart + 0.5 * (t.start - spanStart); newLen = 0.5 * t.len; }
        else if (mode == "setLength")
            newLen = lengthBeats;   // validated > 1e-4 above; starts unchanged
        else if (mode == "fitToScale")
            newPitch = snapToMask (t.pitch);
        else   // humanize
        {
            newStart = juce::jmax (0.0, t.start + timeDev (rng));
            newVel   = juce::jlimit (1, 127, t.vel + velDev (rng));
        }
        if (std::abs (newStart - t.start) > 1.0e-9 || std::abs (newLen - t.len) > 1.0e-9)
        {
            t.n->setStartAndLength (tracktion::BeatPosition::fromBeats (newStart),
                                    tracktion::BeatDuration::fromBeats (newLen), &undoManager());
            ++changed;
        }
        if (newPitch != t.pitch) { t.n->setNoteNumber (newPitch, &undoManager()); ++changed; }
        if (newVel != t.vel)     { t.n->setVelocity (newVel, &undoManager()); ++changed; }
    }

    logLine ("transform_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3
    auto* data = new DynamicObject();
    data->setProperty ("mode", mode);
    data->setProperty ("changed", changed);
    data->setProperty ("added", added);
    return okResult ("transform_notes", var (data));
}

te::AudioTrack* MoshOps::createAudioTrack (const juce::String& name)
{
    auto& edit = eng.edit();
    auto track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr, false);
    if (track == nullptr)
        return nullptr;

    // MP-001 — stamp the stable cross-peer logical id at creation (identity, not
    // user state, so written without the undo manager; see LogicalId.h).
    logicalid::ensureTrack (track->state);

    if (name.isNotEmpty())
        track->setName (name);

    // Deliberately NO message-loop pump here: EditItemID assignment is synchronous
    // (edit.createNewItemID() runs inline), and a mid-command pump re-enters queued
    // async engine work — the AUD-001 use-after-free class (see patches/0005).

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

juce::var MoshOps::pluginToVar (te::Plugin& p, int index, te::AudioTrack* owner)
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
   #if MOSH_HAVE_ANIRA
    if (auto* r = asRave (&p))
        o->setProperty ("rave", r->describe());
   #endif
    if (auto* mfx = dynamic_cast<MoshFxDescribable*> (&p))
    {
        auto readout = mfx->describeMoshFx();
        if (owner != nullptr && p.getPluginType() == MoshXFeedbackPlugin::xmlTypeName)
        {
            const auto activeCuts = readout.getProperty ("activeCuts", var());
            if (activeCuts.size() == 0)
                readout = xFeedbackPreviewReadout (*owner, p);
        }
        o->setProperty ("moshFx", readout);
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
        // CAP-AUT-006 — a stepped parameter (the mute gate is the first) is applied
        // through snapToState, so the editor must snap its points to the same states
        // instead of drawing a value the engine will never use. Only emitted when true,
        // so every existing continuous parameter's payload is byte-identical.
        if (param->isDiscrete())
        {
            po->setProperty ("discrete", true);
            po->setProperty ("states", juce::jmax (2, param->getNumberOfStates()));
        }
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
    // Route C.2 — true only in the anira build; gates the UI "+ RAVE" affordance so the
    // real-time RAVE insert is only offered where it can actually be hosted.
   #if MOSH_HAVE_ANIRA
    session->setProperty ("raveAvailable", true);
   #else
    session->setProperty ("raveAvailable", false);
   #endif
    // FMS Phase-3 sing: the locked-to-self enrollment state (ONE voice per install,
    // ~/Library/Mosh/voice). The fake beep backend renders without it; the UI copy
    // tells the producer whether the REAL own-voice backend has a reference yet.
    {
        const auto voiceDir = juce::File (juce::SystemStats::getEnvironmentVariable (
            "MOSH_VOICE_DIR", juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                                  .getChildFile ("Library/Mosh/voice").getFullPathName()));
        session->setProperty ("singVoiceEnrolled",
                              voiceDir.getChildFile ("reference.wav").existsAsFile()
                                  || voiceDir.getChildFile ("reference-30s.wav").existsAsFile()
                                  || voiceDir.getChildFile ("reference-10s.wav").existsAsFile());
    }
    session->setProperty ("sampleRate", eng.engine().getDeviceManager().getSampleRate());
    session->setProperty ("tempo", edit.tempoSequence.getBpmAt (tracktion::TimePosition()));
    if (auto* ts = edit.tempoSequence.getTimeSig (0))
    {
        session->setProperty ("timeSigNumerator", ts->numerator.get());
        session->setProperty ("timeSigDenominator", ts->denominator.get());
    }

    // SES-001 — the full tempo MAP (additive: tempo/timeSig* above stay point 0 for
    // every existing consumer). Engine-ordered; times in seconds via the engine's
    // own beats->seconds conversion, so the UI's piecewise mapping starts exact.
    {
        Array<var> tempoMap;
        bool anyRamp = false;
        for (int i = 0; i < edit.tempoSequence.getNumTempos(); ++i)
            if (auto* t = edit.tempoSequence.getTempo (i))
            {
                auto* o = new DynamicObject();
                o->setProperty ("time", t->getStartTime().inSeconds());
                o->setProperty ("bpm", t->getBpm());
                o->setProperty ("curve", (double) t->getCurve());
                if (std::abs (t->getCurve()) < 0.9999f && i + 1 < edit.tempoSequence.getNumTempos())
                    anyRamp = true;
                tempoMap.add (var (o));
            }
        session->setProperty ("tempoMap", tempoMap);

        // Tempo RAMPS (curve in (-1,1)): serialize the engine-faithful fine sections
        // so the UI mapping stays exact. We reproduce the engine's own subdivision
        // boundaries (tracktion_core Tempo.h: numSubdivisions = clamp(4 * beatSpan,
        // 1, 100) per ramp span) and read time/bpm back through the engine's toTime /
        // getBpmAt — the very piecewise approximation playback uses. Emitted ONLY
        // when a ramp exists; step-only maps keep the lean tempoMap (the UI falls
        // back to its exact piecewise-constant path).
        if (anyRamp)
        {
            Array<var> sections;
            auto& seq = edit.tempoSequence;
            for (int i = 0; i < seq.getNumTempos(); ++i)
            {
                auto* t = seq.getTempo (i);
                if (t == nullptr) continue;
                auto* o0 = new DynamicObject();
                o0->setProperty ("time", t->getStartTime().inSeconds());
                o0->setProperty ("bpm", seq.getBpmAt (t->getStartTime()));
                sections.add (var (o0));

                if (i + 1 >= seq.getNumTempos() || std::abs (t->getCurve()) >= 0.9999f)
                    continue;   // step span (or the open tail): one section suffices
                const auto b0 = t->getStartBeat();
                const auto b1 = seq.getTempo (i + 1)->getStartBeat();
                const double span = (b1 - b0).inBeats();
                const int subs = (int) std::clamp (4.0 * span, 1.0, 100.0);
                for (int k = 1; k < subs; ++k)
                {
                    const auto bk = tracktion::BeatPosition::fromBeats (b0.inBeats() + span * (double) k / (double) subs);
                    const auto tk = seq.toTime (bk);
                    auto* o = new DynamicObject();
                    o->setProperty ("time", tk.inSeconds());
                    o->setProperty ("bpm", seq.getBpmAt (tk));
                    sections.add (var (o));
                }
            }
            session->setProperty ("tempoSections", sections);
        }

        Array<var> sigMap;
        for (int i = 0; i < edit.tempoSequence.getNumTimeSigs(); ++i)
            if (auto* s = edit.tempoSequence.getTimeSig (i))
            {
                auto* o = new DynamicObject();
                o->setProperty ("time", edit.tempoSequence.toTime (s->getStartBeat()).inSeconds());
                o->setProperty ("numerator", s->numerator.get());
                o->setProperty ("denominator", s->denominator.get());
                sigMap.add (var (o));
            }
        session->setProperty ("timeSigMap", sigMap);
    }
    session->setProperty ("metronome", edit.clickTrackEnabled.get());
    // CAP-TRN-005 — the click's sound/level/routing, next to the on-off flag rather than
    // inside session.project: unlike countInBars/recordOptions these are not Mosh-owned
    // MOSH_PROJECT intent, they are tracktion's own CLICKTRACK state plus two app-global
    // PropertyStorage settings. `metronome` above stays as the flag every existing
    // consumer reads. The output-device CANDIDATE list is deliberately NOT here — device
    // enumeration stays behind on-demand list_audio_devices (see the note below).
    session->setProperty ("click", clickSettingsToVar());
    session->setProperty ("length", edit.getLength().inSeconds());
    session->setProperty ("editFile", eng.editFile().getFullPathName());
    session->setProperty ("dirty", eng.isDirty());   // unsaved-changes flag (gap 1)
    // PRJ-FMT — cold-start refusal: the launch session file was made by a newer Mosh, so a
    // safe empty fallback is live. The UI shows this as a blocking "please update Mosh" banner.
    if (eng.hasProjectLoadError())
        session->setProperty ("loadError", eng.projectLoadError());
    // A2/A3 — the prior GUI session ended uncleanly (crashed). recoveryAvailable drives a
    // one-time notice; recoverableCount is how many unsaved arrangement commands the A3 journal
    // can replay (recover_session) to tighten the ≤30s autosave loss toward ~0.
    if (eng.wasUncleanShutdown())
    {
        session->setProperty ("recoveryAvailable", true);
        session->setProperty ("recoverableCount", pendingRecovery_.size());
    }
    // FS-T2 — the crash happened WHILE loading these third-party plugins, so the normal
    // recovery offer is not enough: reopening the project re-crashes on the same plugin.
    // Advertising the suspects lets the UI offer "open without third-party plugins".
    // Independent of recoveryAvailable on purpose: a load crash can leave nothing to replay
    // (no unsaved commands) and still need safe mode.
    // FS-T2 — the live Edit was loaded with third-party plugins scrubbed. READ-ONLY (save()
    // refuses), so the UI must say so plainly rather than let the producer believe their work
    // is being auto-saved.
    if (eng.inSafeMode())
        session->setProperty ("safeModeActive", true);
    if (eng.wasPluginCrashSuspected())
    {
        // Bind to a NAMED local first. pluginCrashSuspects() returns a StringArray BY VALUE,
        // so calling it twice for .begin() and .end() takes iterators into two DIFFERENT
        // temporaries, both already destroyed — the same temporary-lifetime trap as
        // `if (auto* p = someVarReturningFn().getArray())`. It segfaults in snapshot().
        const auto suspects = eng.pluginCrashSuspects();
        juce::Array<juce::var> suspectVars;
        for (const auto& s : suspects)
            suspectVars.add (s);
        session->setProperty ("pluginCrashSuspects", suspectVars);
        // Non-empty ⇒ taking safe mode will ALSO quarantine this one via block_plugin.
        // Empty ⇒ several candidates, so we skip them all but blocklist none (a guess
        // would permanently quarantine plugins the user paid for).
        session->setProperty ("pluginQuarantineTarget",
                              mosh::safemode::quarantineTarget (
                                  std::vector<juce::String> (suspects.begin(), suspects.end())));
    }
    session->setProperty ("recentProjects", eng.recentProjects());   // Recent list (gap 2)
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

    // #632/#633 — the SYSTEM default output, so the transport chip can say "you are on
    // X, but your Mac's default is Y" instead of leaving the producer to guess. Mosh
    // deliberately RESTORES the device you last chose rather than following the system
    // (every DAW does, so an interface dropping out mid-mix cannot silently move your
    // monitoring to laptop speakers) — the failure on 2026-08-05 was not that policy, it
    // was that nothing ever said which device was in use or that a different one was
    // default.
    //
    // NO scanForDevices() here. getDeviceNames() returns the list from the last scan and
    // is cheap; scanForDevices() enumerates the HAL and is not, and snapshot() runs on
    // the message thread on every invalidation. An enumeration on that path is exactly
    // the synchronous-bridge stall this codebase has been bitten by before. If nothing
    // has scanned yet the list is empty and this reports "" — an honest unknown, which
    // the UI renders as no hint rather than a wrong one.
    juce::String systemDefaultOut;
    if (auto* type = dm.deviceManager.getCurrentDeviceTypeObject())
    {
        const auto outNames = type->getDeviceNames (false);
        const int  defIdx   = type->getDefaultDeviceIndex (false);
        if (defIdx >= 0 && defIdx < outNames.size())
            systemDefaultOut = outNames[defIdx];
    }
    session->setProperty ("audioDeviceSystemDefault", systemDefaultOut);

    // PRJ-008 — per-project format / time-base INTENT (the export/format default +
    // timeline display base). Read from the MOSH_PROJECT child of the Edit tree,
    // falling back to the live device readout where unset (device = live truth,
    // project = remembered intent). This is generic media-format state — no
    // Tracktion concepts cross to the UI.
    auto projectVar = projectSettingsToVar();
    session->setProperty ("project", projectVar);
    // KEY-001 — also mirror the musical key to the TOP level of session (exactly like
    // sampleRate/bitDepth/tempo/metronome above), so the UI reads session.key directly.
    // Single source: the MOSH_PROJECT node via projectSettingsToVar; a convenience mirror,
    // not a second store.
    if (auto* po = projectVar.getDynamicObject())
    {
        session->setProperty ("key", po->getProperty ("key"));
        // G2b — same mirror for the count-in / pre-roll bars, so the UI can read
        // session.countInBars directly (like session.metronome) without reaching
        // into session.project.
        session->setProperty ("countInBars", po->getProperty ("countInBars"));
    }

    Array<var> tracks;
    int index = 0;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr && ! (bool) t->state.getProperty (ids::moshHidden, false))   // Phase 2 — hidden beneath-render track
            tracks.add (trackToVar (*t, index++));

    // MIX-008 — group (submix) tracks, appended AFTER the audio tracks so every
    // existing flat consumer (lanes, mixer strips, selftest firstTrack) is
    // unbroken. A group entry carries isGroup + its real fader (the submix
    // VolumeAndPan the engine added) and an empty clips array.
    for (auto* t : te::getAllTracks (edit))
        if (auto* ft = dynamic_cast<te::FolderTrack*> (t))
        {
            auto* g = new DynamicObject();
            g->setProperty ("id", ft->itemID.toString());
            g->setProperty ("logicalId", logicalid::ensureTrack (ft->state));   // MP-001
            g->setProperty ("index", index++);
            g->setProperty ("name", ft->getName());
            g->setProperty ("type", "group");
            g->setProperty ("isGroup", true);
            g->setProperty ("clips", Array<var>());
            if (auto* vp = ft->getVolumePlugin())
            {
                g->setProperty ("volumeDb", vp->getVolumeDb());
                g->setProperty ("pan", vp->getPan());
            }
            if (auto* parent = ft->getParentFolderTrack())   // nested groups
                g->setProperty ("parentId", parent->itemID.toString());
            tracks.add (var (g));
        }

    auto* root = new DynamicObject();
    root->setProperty ("schemaVersion", mosh::kSnapshotSchemaVersion);  // C++→UI wire contract (≠ file format)
    root->setProperty ("session", var (session));
    root->setProperty ("tracks", tracks);
    root->setProperty ("transport", transportToVar());
    root->setProperty ("controller", controllerToVar());

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

    // SEC-001 — named song sections (Intro/Verse/Hook/…) from the MOSH_SECTIONS tree.
    root->setProperty ("sections", sectionsToVar());
    root->setProperty ("annotations", annotationsToVar());
    root->setProperty ("clipGroups", clipGroupsToVar());
    if (const auto groups = edit.state.getChildWithName (ids::MOSH_CLIP_GROUPS); groups.isValid())
        if (const auto groupId = groups[ids::lastUngroupedClipGroupId].toString(); groupId.isNotEmpty())
            root->setProperty ("lastUngroupedClipGroupId", groupId);

    // Master bus (Wave 5) — the edit's master VolumeAndPan, always present.
    if (auto mvp = edit.getMasterVolumePlugin())
    {
        auto* master = new DynamicObject();
        master->setProperty ("volumeDb", mvp->getVolumeDb());
        master->setProperty ("pan", mvp->getPan());
        // Master-bus plugins (limiter, bus EQ, …) — mirrors tracks[].plugins, but hosted
        // via getMasterPluginList() with no owning track (pluginToVar's owner arg is only
        // used for a track-scoped MoshXFeedback preview readout, so nullptr here is fine).
        // Internal utility plugins (the spectral tap) are filtered out — never user-visible.
        Array<var> masterPlugins;
        int mvi = 0;
        for (auto* p : edit.getMasterPluginList().getPlugins())
        {
            if (p == nullptr || isInternalMasterPlugin (p)) continue;
            masterPlugins.add (pluginToVar (*p, mvi, nullptr));
            ++mvi;
        }
        master->setProperty ("plugins", masterPlugins);
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
    // MP-001 — stable cross-peer logical id (backfilled here for legacy/loaded
    // edits whose tracks predate the stamp; ensure() is a no-op once present).
    o->setProperty ("logicalId", logicalid::ensureTrack (t.state));
    o->setProperty ("index", index);
    o->setProperty ("name", t.getName());
    // DRM-001 — track type ("audio" | "drum"); absent on legacy edits ⇒ "audio".
    o->setProperty ("type", t.state.getProperty (ids::trackType, "audio"));
    o->setProperty ("clips", clips);
    // FL drum-lane mute/solo — the GM pitches whose pad is muted / soloed (empty when
    // none). Lets the drum sequencer render per-lane M·S without a second model.
    {
        auto toArr = [] (const juce::String& s) {
            Array<var> a;
            for (auto& tok : juce::StringArray::fromTokens (s, ",", ""))
                if (tok.trim().isNotEmpty()) a.add (tok.trim().getIntValue());
            return a;
        };
        o->setProperty ("drumMutedPitches", toArr (t.state.getProperty (ids::drumMute, "").toString()));
        o->setProperty ("drumSoloPitches",  toArr (t.state.getProperty (ids::drumSolo, "").toString()));
    }
    // The sampler's loaded PADS — what a drum track actually holds, rather than the
    // eight GM lanes the step grid assumes. Emitted only when the track HAS a sampler,
    // so every other track pays nothing. `gainDb` is the RAW engine gain (what you
    // would hear), not the pad's parked user gain: mute is applied as a real gain
    // write, so reading it back is the only honest way to tell a restored pad from a
    // still-silenced one. minNote/maxNote are carried because assign_sample's melodic
    // mode maps one sound across the whole keyboard, which is not a pad at all.
    if (auto* sampler = findSampler (t))
    {
        Array<var> pads;
        for (int i = 0; i < sampler->getNumSounds(); ++i)
        {
            auto* p = new DynamicObject();
            p->setProperty ("index",     i);
            p->setProperty ("pitch",     sampler->getKeyNote (i));
            p->setProperty ("minNote",   sampler->getMinKey (i));
            p->setProperty ("maxNote",   sampler->getMaxKey (i));
            p->setProperty ("name",      sampler->getSoundName (i));
            p->setProperty ("file",      sampler->getSoundMedia (i));
            p->setProperty ("gainDb",    sampler->getSoundGainDb (i));
            p->setProperty ("pan",       sampler->getSoundPan (i));
            p->setProperty ("openEnded", sampler->isSoundOpenEnded (i));
            // Choke group is a Mosh-side property on the SOUND tree (see Ids.h) — the
            // engine has no such concept, so it can only be read back from where we put it.
            {
                int n = 0, group = 0;
                for (auto v : sampler->state)
                    if (v.hasType (te::IDs::SOUND))
                        if (n++ == i) { group = (int) v.getProperty (ids::moshChokeGroup, 0); break; }
                if (group > 0) p->setProperty ("chokeGroup", group);
            }
            pads.add (var (p));
        }
        o->setProperty ("drumPads", pads);
        const auto kit = t.state.getProperty (ids::drumKitId, "").toString();
        if (kit.isNotEmpty()) o->setProperty ("drumKit", kit);
    }
    // MIX-008 — a track nested under a group (submix folder) carries its parent's
    // id so the UI can indent it / show membership. Additive: flat consumers see
    // the same array, ungrouped tracks have no parentId.
    if (auto* parent = t.getParentFolderTrack())
        o->setProperty ("parentId", parent->itemID.toString());

    // RTG-001 — the explicitly-chosen input (stored preference; the live name is
    // resolved when the device is present, else the persisted id stands alone).
    {
        const auto chosenID = t.state.getProperty (ids::moshInputDevice, var()).toString();
        if (chosenID.isNotEmpty())
        {
            auto* in = new DynamicObject();
            in->setProperty ("deviceID", chosenID);
            auto& dm = eng.engine().getDeviceManager();
            for (int i = 0; i < dm.getNumWaveInDevices(); ++i)
                if (auto* wi = dm.getWaveInDevice (i))
                    if (wi->getDeviceID() == chosenID)
                    { in->setProperty ("name", wi->getName()); in->setProperty ("kind", "wave"); break; }
            // …and the MIDI families too. Without this pass a chosen controller rendered
            // as a bare deviceID with no name, because only wave devices were scanned —
            // and there was no way to tell which family the stored choice belonged to.
            if (! in->hasProperty ("name"))
                if (auto mi = dm.findMidiInputDeviceForID (chosenID))
                { in->setProperty ("name", mi->getName()); in->setProperty ("kind", "midi"); }
            o->setProperty ("input", var (in));
        }
    }

    // RTG-002 — the track's output destination (te::TrackOutput). Absent = the
    // default output. A route-to-track destination is an implicit submix.
    {
        auto& out = t.getOutput();
        if (auto* dest = out.getDestinationTrack())
        {
            auto* ov = new DynamicObject();
            ov->setProperty ("isTrack", true);
            ov->setProperty ("destId", dest->itemID.toString());
            ov->setProperty ("name", dest->getName());
            o->setProperty ("output", var (ov));
        }
        else if (! out.usesDefaultAudioOut())
        {
            // A non-default device destination (or a persisted-but-missing device):
            // surface the stored name/id so the UI can show it (incl. "missing").
            auto* ov = new DynamicObject();
            ov->setProperty ("isTrack", false);
            ov->setProperty ("name", out.getOutputName());
            ov->setProperty ("deviceID", out.getOutputDeviceID());
            o->setProperty ("output", var (ov));
        }
    }

    // Plugin chain (Stage 3). Indexed within pluginList (built-ins included). The
    // metering tap (Wave 9) is hidden from the rack but keeps its real index so
    // plugin-addressed commands still resolve. The VolumeAndPan plugin is hidden the
    // same way: the fader is already surfaced as the track's volumeDb/pan fields, and
    // ensureVolumePlugin materializes the plugin lazily on the first fader touch — the
    // P6 undo matrix caught it leaking into the rack as a bogus "Volume & Pan Plugin"
    // row on any fresh track. (It is not a load_builtin type, so nothing a user loads
    // can be hidden by this.)
    // The CAP-AUT-006 mute gate is hidden from the rack for the same reason as the other
    // two: it is a mixer element, not something a user loaded, and a "Mute" row in every
    // track's chain would be noise. Real index preserved, same as the others.
    juce::Array<var> plugins;
    juce::Array<var> mixerPlugins;
    auto pl = t.pluginList.getPlugins();
    for (int i = 0; i < pl.size(); ++i)
    {
        if (pl[i] == nullptr) continue;
        const bool isFader = dynamic_cast<te::VolumeAndPanPlugin*> (pl[i].get()) != nullptr;
        const bool isGate  = dynamic_cast<TrackMutePlugin*> (pl[i].get()) != nullptr;
        if (dynamic_cast<te::LevelMeterPlugin*> (pl[i].get()) != nullptr) continue;   // pure measure, nothing to automate
        if (isFader || isGate)
        {
            // CAP-AUT-006 — hidden from the rack but AUTOMATABLE, so they need a way to
            // reach the automation picker. Same (pluginIndex, paramIndex) addressing as
            // any other target: this introduces no second kind of automation target, it
            // just stops the mixer strip's parameters being unreachable by mouse. Before
            // this, the fader's own volume/pan curves were addressable by command but
            // unpickable in AutomationPanel, which only lists `plugins`.
            mixerPlugins.add (pluginToVar (*pl[i], i, &t));
            continue;
        }
        plugins.add (pluginToVar (*pl[i], i, &t));
    }
    o->setProperty ("plugins", plugins);
    o->setProperty ("mixerPlugins", mixerPlugins);
    // DRM-001/CTL-001 — does the track host an instrument (synth or builtin)? Lets the
    // header surface the auto-loaded default and label the track MIDI-armable.
    o->setProperty ("isInstrument", trackHasInstrument (t));
    o->setProperty ("meterEnabled", findTrackMeter (t) != nullptr);
    // Freeze Track (⌥⇧⌘F) — additive; absent on unfrozen tracks so pre-freeze
    // consumers and snapshots are untouched. The marker itself lives on the track's
    // state tree (ids::moshFrozen) so it persists save/reload and rides undo.
    if (t.state.hasProperty (ids::moshFrozen))
        o->setProperty ("frozen", true);

    // Mixer state (Stage 2 mixer stub).
    if (auto* vp = t.getVolumePlugin())
    {
        o->setProperty ("volumeDb", vp->getVolumeDb());
        o->setProperty ("pan", vp->getPan());    }
    else
    {
        o->setProperty ("volumeDb", 0.0);
        o->setProperty ("pan", 0.0);
    }
    o->setProperty ("mute", t.isMuted (false));
    o->setProperty ("solo", t.isSolo (false));
    // Pro Tools-style active/inactive is distinct from both mute and Track List
    // visibility. Tracktion persists this as IDs::process and removes an inactive
    // track (including its plug-ins) from the playback graph while retaining state.
    o->setProperty ("active", t.isProcessing (false));
    // G10 — automation record-arm mode ("read"|"touch"|"latch"|"write"); defaults to
    // "read" for a track that never called set_track_automation_mode.
    {
        AutomationRecordMode recMode = AutomationRecordMode::read;
        switch (t.automationMode.get())
        {
            case te::AutomationMode::read:  recMode = AutomationRecordMode::read;  break;
            case te::AutomationMode::touch: recMode = AutomationRecordMode::touch; break;
            case te::AutomationMode::latch: recMode = AutomationRecordMode::latch; break;
            case te::AutomationMode::write: recMode = AutomationRecordMode::write; break;
        }
        o->setProperty ("automationMode", automationRecordModeToString (recMode));
    }

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
        if (const auto col = t.state.getProperty (ids::trackColour, var()).toString(); col.isNotEmpty())
            o->setProperty ("color", col);       // "#rrggbb" — absent means the type default
        // CAP-TRK-002 (#613) — the chosen icon NAME; absent means the type's default glyph.
        if (const auto ico = t.state.getProperty (ids::trackIcon, var()).toString(); ico.isNotEmpty())
            o->setProperty ("icon", ico);
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
    // LYR-001 — the per-track lyric sheet (absent ⇒ no property; the v2 Lyrics tab
    // shows its empty state). Additive + optional: flat consumers ignore it.
    if (auto sheet = lyricSheetToVar (t); ! sheet.isVoid())
        o->setProperty ("lyricSheet", sheet);
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
    // Phase 2 — a HIDDEN beneath-render audio clip: the UI filters it out of the lanes (it's the
    // audio the producer hears, not a clip to manage). Only present when set, to keep snapshots lean.
    if ((bool) c.state.getProperty (ids::moshHidden, false))
        o->setProperty ("hidden", true);
    if (auto* w = dynamic_cast<te::WaveAudioClip*> (&c))
    {
        o->setProperty ("type", "wave");
        // A REVERSED clip's CURRENT source is a per-session temp proxy
        // (~/Library/Mosh/Temporary/edit_0_xx — a different name every reload); the UI
        // must see the USER's file, and sourceMissing must cue relink on the original,
        // not on a not-yet-generated proxy. Found by the P6 persist matrix (the proxy
        // path was the one snapshot field that changed across save/reload).
        const bool revClip = w->getIsReversed();
        if (revClip)
            w->getCurrentSourceFile();   // side effect kept deliberately: this kicks the
            // reversed-proxy resolution the same eager way every pre-change snapshot did.
            // Dropping the call (reporting only the original) let the proxy job spawn
            // later, mid graph-rebuild, racing edit teardown — an upstream ThreadPoolJob
            // deleted-while-in-pool assert + SIGSEGV, reproduced 2/2 in --selftest.
        const auto srcFile = revClip ? w->getOriginalFile()
                                     : w->getCurrentSourceFile();
        o->setProperty ("sourceFile", srcFile.getFullPathName());
        o->setProperty ("sourceMissing", ! srcFile.existsAsFile());   // gap 3 — relink cue
        o->setProperty ("sourceLength", w->getSourceLength().inSeconds());
        o->setProperty ("gainDb", w->getGainDB());
        if (auto points = clipGainEnvelopeToVar (*w); ! points.isVoid())
            o->setProperty ("clipGainPoints", points);
        // G4b — clip fades: additive, unconditional (mirrors gainDb) so the snapshot always
        // reflects the current fade even when it's the 0/0 default. getFadeIn()/getFadeOut()
        // would auto-crossfade-adjust when autoCrossfade is on AND a neighbor overlaps; Mosh
        // leaves autoCrossfade off, so this reads the raw stored fade in the common case.
        o->setProperty ("fadeInSec",   w->getFadeIn().inSeconds());
        o->setProperty ("fadeOutSec",  w->getFadeOut().inSeconds());
        o->setProperty ("fadeInType",  (int) w->getFadeInType());   // 1..4 — UI only needs durations for v1
        o->setProperty ("fadeOutType", (int) w->getFadeOutType());
        // clip-ops wave — reverse / auto-crossfade: additive, unconditional (mirrors
        // gainDb/autoTempo) so the snapshot always reflects current state, default off.
        o->setProperty ("reversed",      w->getIsReversed());
        o->setProperty ("autoCrossfade", w->getAutoCrossfade());
        // CLP-LOOP — clip loop region: additive, unconditional (mirrors reversed/gainDb).
        // loopEnabled reads te::AudioClipBase::isLooping() — the SINGLE notion of "this
        // clip loops" that set_clip_loop writes and clipAudibleSourceSpan (normalize_clip)
        // already consumes, rather than a second Mosh-side flag that could drift from it.
        o->setProperty ("loopEnabled", w->isLooping());
        o->setProperty ("loopStart",   w->getLoopStart().inSeconds());
        o->setProperty ("loopLength",  w->getLoopLength().inSeconds());
        // Audio warp (auto-tempo): the clip follows the tempo map when on.
        o->setProperty ("autoTempo", w->getAutoTempo());
        if (w->getAutoTempo())
        {
            o->setProperty ("stretchMode", te::TimeStretcher::getNameOfMode (w->getTimeStretchMode()));
            auto info = w->getAudioFile().getInfo();
            o->setProperty ("sourceBpm", w->getLoopInfo().getBpm (info));
        }
        // Take lanes: recording over a region stacks takes in Tracktion's native take
        // tree; the UI renders them as separate lanes (set_current_take / keep_take act
        // on this). Only present when the clip actually has takes.
        if (w->hasAnyTakes())
        {
            const int currentTake = effectiveCurrentTakeIndex (*w);
            o->setProperty ("numTakes", w->getNumTakes (false));
            o->setProperty ("currentTakeIndex", currentTake);
            auto descs = w->getTakeDescriptions();
            juce::Array<juce::var> takes;
            for (int i = 0; i < descs.size(); ++i)
            {
                auto* t = new juce::DynamicObject();
                t->setProperty ("index", i);
                t->setProperty ("description", descs[i]);
                t->setProperty ("isCurrent", i == currentTake);
                takes.add (juce::var (t));
            }
            o->setProperty ("takes", takes);
        }
    }
    else if (auto* mc = dynamic_cast<te::MidiClip*> (&c))
    {
        o->setProperty ("type", "midi");
        // MIDI clip looping (Live 12's brace): ADDITIVE — only present while
        // looping, so consumers written before the fields existed see no change.
        // Content-relative beats, engine truth straight off the clip's CachedValues.
        if (mc->isLooping())
        {
            o->setProperty ("midiLoopStartBeats",  mc->getLoopStartBeats().inBeats());
            o->setProperty ("midiLoopLengthBeats", mc->getLoopLengthBeats().inBeats());
        }
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
                // Deactivated (Ableton's `0`): still in the clip, still editable, silent.
                // Emitted only when true so an ordinary clip's payload is byte-identical
                // to before — notes[] is the largest part of the snapshot.
                if (n->isMute()) no->setProperty ("mute", true);
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
        r->setProperty ("error", rl[ids::renderError]);   // "" unless status=="error"
        r->setProperty ("appliedInPlace", (bool) rl[ids::appliedInPlace]);   // wave: the clip's source IS the render
        r->setProperty ("hasOriginal", rl[ids::originalSourceRef].toString().isNotEmpty());   // wave: Reset is available
        // Phase 2 — MIDI/drum beneath-model is live: the source is muted and a hidden audio clip plays.
        // Drives the "re-imagine active" marker + the Reset button on a MIDI clip. Guarded on the hidden
        // clip still existing so a removed/undone clip clears the marker.
        r->setProperty ("reimagineActive", (bool) rl[kSourceMutedByLayer]
            && rl[kLandedClipId].toString().isNotEmpty()
            && findClip (rl[kLandedClipId].toString()) != nullptr);
        r->setProperty ("coverage", rl[ids::coverage].toString().isNotEmpty() ? rl[ids::coverage] : var ("auto"));   // whole-clip strategy
        r->setProperty ("liveArmed", (bool) rl[ids::liveArmed]);   // Lane A — "Live" render-ahead is armed on this layer
        // The freeze state, and the ONLY honest source for it. `status` carries "frozen" as a
        // label, but a later param edit overwrites it with "dirty" while the layer is still
        // frozen — so a UI reading status alone would silently lose the badge. `reactive` is
        // what reactiveTouch actually gates on; absent ⇒ true (layers predating the freeze fix).
        r->setProperty ("reactive", (bool) rl.getProperty (ids::reactive, true));
        r->setProperty ("adapter", rl[ids::modelAdapter]);
        r->setProperty ("mode", rl[ids::mode]);
        r->setProperty ("seed", (int) rl[ids::seed]);
        r->setProperty ("userKept", rl[ids::userKept]);
        r->setProperty ("hasArtifact", mosh::resolveCacheArtifact (rl, eng.editFile().getParentDirectory()).existsAsFile());
        // The render's time scope (seconds). For a section-scoped render this is the
        // section's sub-range; for a whole-clip render it equals the clip span.
        r->setProperty ("regionStart", (double) rl[ids::timeRangeStart]);
        r->setProperty ("regionEnd",   (double) rl[ids::timeRangeEnd]);
        if (auto params = rl.getChildWithName (ids::PARAMS); params.isValid())
        {
            r->setProperty ("prompt", params[ids::prompt]);
            r->setProperty ("nl", (double) params[ids::nl]);
            r->setProperty ("lab", (bool) params.getProperty (juce::Identifier ("lab"), false));
            r->setProperty ("target", params[ids::target]);        // Route B transform target
            r->setProperty ("strength", (double) params[ids::strength]); // Route B transform strength
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
            Array<var> loras;
            if (auto ls = params.getChildWithName (ids::LORAS); ls.isValid())
                for (int i = 0; i < ls.getNumChildren(); ++i)
                {
                    auto* lo = new DynamicObject();
                    lo->setProperty ("name", ls.getChild (i)[ids::name]);
                    lo->setProperty ("value", (double) ls.getChild (i)[ids::value]);
                    loras.add (var (lo));
                }
            r->setProperty ("loras", loras);
        }
        // The last compile_render verdict (transient) — lets the UI show what it chose +
        // surface an "unsupported" honest message. Parsed back from the JSON blob.
        if (rl.hasProperty (ids::compiledEnvelope))
            r->setProperty ("compiled", juce::JSON::parse (rl[ids::compiledEnvelope].toString()));
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

juce::var MoshOps::controllerToVar()
{
    auto& transport = eng.edit().getTransport();

    te::WaveAudioClip* latestWave = nullptr;
    juce::String latestTrackId;
    double latestEnd = -1.0;

    for (auto* track : te::getAudioTracks (eng.edit()))
        if (track != nullptr)
            for (auto* clip : track->getClips())
                if (auto* wave = dynamic_cast<te::WaveAudioClip*> (clip))
                {
                    if ((bool) wave->state.getProperty (ids::moshHidden, false)) continue;   // Phase 2 — not a take
                    const auto pos = wave->getPosition();
                    const double end = pos.getEnd().inSeconds();
                    if (latestWave == nullptr || end >= latestEnd)
                    {
                        latestWave = wave;
                        latestTrackId = track->itemID.toString();
                        latestEnd = end;
                    }
                }

    auto* take = new DynamicObject();
    take->setProperty ("exists", latestWave != nullptr);
    if (latestWave != nullptr)
    {
        const auto pos = latestWave->getPosition();
        const bool hasLanes = latestWave->hasAnyTakes();
        take->setProperty ("clipId", latestWave->itemID.toString());
        take->setProperty ("trackId", latestTrackId);
        take->setProperty ("name", latestWave->getName());
        take->setProperty ("start", pos.getStart().inSeconds());
        take->setProperty ("length", pos.getLength().inSeconds());
        take->setProperty ("hasLanes", hasLanes);
        take->setProperty ("canKeep", hasLanes);
        take->setProperty ("kept", ! hasLanes);
        if (hasLanes)
        {
            take->setProperty ("numTakes", latestWave->getNumTakes (false));
            take->setProperty ("currentTakeIndex", effectiveCurrentTakeIndex (*latestWave));
        }
    }

    auto* controller = new DynamicObject();
    controller->setProperty ("mode", transport.isRecording() ? "capture" : "judgment");
    controller->setProperty ("record", transport.isRecording() ? "recording" : "idle");
    controller->setProperty ("agent", "idle");
    controller->setProperty ("take", var (take));
    return var (controller);
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
    if (replayingRecovery_) return;   // A3 — suppress per-command events; one final invalidate after replay
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

void MoshOps::emitProjectReplaced (const juce::String& reason)
{
    auto* payload = new DynamicObject();
    payload->setProperty ("projectReplaced", true);
    payload->setProperty ("reason", reason);
    payload->setProperty ("epochManagedByUi", projectEpochManagedByUi_);
    emit ("snapshot_invalidated", var (payload));
}

void MoshOps::emitTrackPatch (te::AudioTrack& track)
{
    if (eventSink == nullptr) { return; }   // (no sink ⇒ nothing to scope)
    const int idx = te::getAudioTracks (eng.edit()).indexOf (&track);
    auto* p = new DynamicObject();
    p->setProperty ("scope", "track");                  // the UI patches one track, not the world
    p->setProperty ("trackId", track.itemID.toString());
    p->setProperty ("track", trackToVar (track, idx));
    emit ("snapshot_invalidated", var (p));
}

// ── CAP-PRJ-005 — the undo-transaction mirror ────────────────────────────────
// Full rationale on the members in MoshOps.h. In one line: JUCE owns the SHAPE of the
// undo timeline, this owns the IDENTITY of each entry in it, and the two are reconciled
// after every command so identity can never drift out from under the shape.
void MoshOps::syncUndoMirror()
{
    auto& um = undoManager();
    const int u = um.getUndoDescriptions().size();   // == JUCE's nextIndex (the cursor)
    const int r = um.getRedoDescriptions().size();
    const int total = u + r;

    // How many transactions landed at the tip since the last sync?
    //
    // Normally the depth says it: anything above the cursor is new. Deliberately NOT
    // reached on redo — cmdRedo advances txnCursor_ before it logs, so u == txnCursor_
    // by then and the mirror treats a redone transaction as the SAME one, not a new one.
    int added = juce::jmax (0, u - txnCursor_);

    // …except at SATURATION, where the depth lies. `Edit` keeps 30 undo levels, and once
    // the budget is spent JUCE's dropOldTransactionsIfTooLarge() evicts the oldest
    // transaction inside the very perform() that added the new one — depth unchanged,
    // total unchanged, a brand-new transaction at the tip. Counting alone cannot see it,
    // and a mirror that missed it would hand the NEW transaction the OLD one's id: a
    // stamp that restores somewhere the producer never clicked, which is the entire
    // failure mode this design exists to remove. So ask the UndoManager directly: a
    // transaction was opened (txnOpenedSinceSync_) and it now holds actions ⇒ it
    // materialised. (Residual, stated plainly: an undoable mutation that reaches the Edit
    // WITHOUT going through a MoshOps command would not set the flag. That is already a
    // violation of the one-mutation-path directive, and it only misleads at exactly the
    // saturation point.)
    const int actionsInHead = um.getNumActionsInCurrentTransaction();
    if (txnOpenedSinceSync_ && actionsInHead > 0)
    {
        if (added == 0) added = 1;
        txnOpenedSinceSync_ = false;
    }

    // A new transaction discards the redo tail (JUCE does this inside perform()), so the
    // mirror discards it too — those points are gone for good, and their ids are never
    // reused. That is what turns a click on a stale row into a legible refusal instead of
    // a wrong restore.
    if (added > 0)
    {
        txnIds_.resize ((size_t) juce::jmax (0, txnCursor_));
        for (int k = 0; k < added; ++k)
            txnIds_.push_back (nextTxnId_++);
        txnCursor_ = (int) txnIds_.size();
    }

    // Reconcile against ground truth. Two things can shrink the timeline without going
    // through a command: UndoManager::dropOldTransactionsIfTooLarge() drops the OLDEST
    // transactions off the bottom once the Edit's undo-level budget is spent, and
    // MoshEngine calls clearUndoHistory() on load/new-project. Both are front-drops, so
    // erasing from the front is not a guess — it is the only shape a shrink can have.
    if ((int) txnIds_.size() > total)
    {
        const int drop = (int) txnIds_.size() - total;
        txnIds_.erase (txnIds_.begin(), txnIds_.begin() + drop);
    }
    // Growth we did not mint (nothing observed produces it; heal rather than diverge —
    // a fresh id is unreachable-by-any-stamp, which fails closed).
    while ((int) txnIds_.size() < total)
        txnIds_.push_back (nextTxnId_++);

    txnCursor_ = juce::jlimit (0, (int) txnIds_.size(), u);   // JUCE is the authority
}

juce::String MoshOps::currentHistoryTxn() const
{
    const juce::int64 id = (txnCursor_ > 0 && txnCursor_ <= (int) txnIds_.size())
                             ? txnIds_[(size_t) txnCursor_ - 1]
                             : 0;   // 0 == "before any transaction in this session"
    return historyToken_ + ":" + juce::String (id);
}

juce::var MoshOps::restorableHistoryTxns() const
{
    Array<var> out;
    out.add (var (historyToken_ + ":0"));            // the session's own starting point
    for (auto id : txnIds_)
        out.add (var (historyToken_ + ":" + juce::String (id)));
    return var (out);
}

void MoshOps::logLine (const juce::String& command, const juce::var& args,
                       bool ok, const juce::String& error, bool undoable)
{
    // Stamp BEFORE writing: the log line records the history point the session is at
    // once this command has run. Note this is derived from the UndoManager, not from
    // the `undoable` argument — a command that CLAIMS undoable:true but opened an empty
    // transaction (the G14 class) moves no cursor and so shares the previous point,
    // which is the truth. That is the whole reason the stamp is trustworthy.
    syncUndoMirror();

    auto* o = new DynamicObject();
    o->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    o->setProperty ("seq", ++seq);
    o->setProperty ("command", command);
    o->setProperty ("args", args);
    o->setProperty ("ok", ok);
    if (error.isNotEmpty()) o->setProperty ("error", error);
    o->setProperty ("undoable", undoable);
    o->setProperty ("txn", currentHistoryTxn());
    const auto record = var (o);
    const auto line = JSON::toString (record, true);
    const auto filePath = logFile.getFullPathName();
    const auto fileBytesBefore = logFile.existsAsFile() ? logFile.getSize() : 0;
    logFile.appendText (line + "\n");
    const auto fileBytesAfter = logFile.existsAsFile() ? logFile.getSize() : 0;

    const juce::ScopedLock sl (commandLogCacheLock_);
    if (commandLogCachePrimed_ && commandLogPath_ == filePath && commandLogBytes_ == fileBytesBefore)
    {
        ++commandLogTotal_;

        auto entry = makeCommandLogInspectorEntry (record);
        if (entry.isObject())
        {
            commandLogRecentEntries_.add (entry);
            if (commandLogRecentEntries_.size() > kCommandLogInspectorMaxEntries)
                commandLogRecentEntries_.remove (0);
        }

        commandLogBytes_ = fileBytesAfter;
        return;
    }

    commandLogRecentEntries_.clearQuick();
    commandLogTotal_ = 0;
    commandLogBytes_ = -1;
    commandLogPath_.clear();
    commandLogCachePrimed_ = false;
}

// ── A3 — crash-recovery journal ───────────────────────────────────────────────
void MoshOps::initRecoveryJournal()
{
    recoveryJournalFile = eng.sessionDir().getChildFile ("recovery-journal.jsonl");
    if (eng.wasUncleanShutdown() && recoveryJournalFile.existsAsFile())
    {
        // Read the crashed session's unsaved tail into memory BEFORE the first save can
        // truncate the file — so save-truncation can never race recovery.
        for (auto& l : juce::StringArray::fromLines (recoveryJournalFile.loadFileAsString()))
            if (l.trim().isNotEmpty()) pendingRecovery_.add (l.trim());
    }
    recoveryJournalFile.deleteFile();   // start THIS session's journal fresh
}

// Only deterministic, replayable arrangement mutations are journaled — NOT plugin ops (the
// in-process-crash culprits; replaying one would re-crash) nor renders/admin/transport/IO.
// An ALLOWLIST (conservative): an unknown command is simply not recovered, never misapplied.
//
// CAP-PRJ-005 — jump_to_history is deliberately ABSENT, for exactly the reason undo and
// redo are absent: recovery replays the surviving forward edits onto a freshly loaded
// Edit whose UndoManager is empty, so a recorded history move has nothing to move along.
// Replaying one would either no-op or (worse, if it ever stopped being a no-op) undo a
// replayed edit the producer never asked to lose. Not-in-the-allowlist means not
// recovered, which is the correct outcome and needs no code.
bool MoshOps::isReplayableCommand (const juce::String& name) const
{
    static const juce::StringArray replayable {
        "create_track", "rename_track", "remove_track", "set_track_type", "set_track_color", "set_track_icon", "move_track",
        "import_clip", "add_test_tone_clip", "add_midi_clip",
        "move_clip", "trim_clip", "split_clip", "consolidate_clips", "crop_clip", "bounce_track", "freeze_track", "unfreeze_track", "remove_clip", "rename_clip",
        "promote_take_region",
        "set_clip_mute", "set_clip_gain", "write_clip_gain_curve", "set_clip_fade", "relink_clip", "set_clip_warp",
        "duplicate_clip", "delete_time_range", "insert_time", "paste_clip",
        "set_track_volume", "set_track_pan", "set_track_mute", "set_track_solo", "set_track_active",
        "create_section", "rename_section", "move_section", "remove_section",
        "create_clip_group", "ungroup_clip_group", "regroup_clip_group", "rename_clip_group",
        "create_annotation", "edit_annotation", "move_annotation", "remove_annotation",
        "set_tempo", "set_time_signature", "set_metronome", "set_key", "set_project_settings" };
    return replayable.contains (name);
}

void MoshOps::appendRecoveryJournal (const juce::String& name, const juce::var& args, const juce::var& result)
{
    if (! (bool) result.getProperty ("ok", false)) return;     // only successful commands
    if (! isReplayableCommand (name)) return;
    auto* o = new DynamicObject();
    o->setProperty ("c", name);
    o->setProperty ("a", args);
    o->setProperty ("r", result.getProperty ("data", var()));  // assigned ids → id-rebinding on replay
    recoveryJournalFile.appendText (JSON::toString (var (o), true) + "\n");
}

// Replace any string arg whose VALUE is a journaled id with its freshly-assigned id.
// Recursive substitution is required for multi-target commands whose ids live in arrays
// (create_clip_group, consolidate_clips, crop_clip) or nested object payloads.
juce::var MoshOps::substituteRecoveryIds (const juce::var& args, const juce::HashMap<juce::String, juce::String>& idMap)
{
    return recovery::substituteIds (args, idMap);
}

juce::var MoshOps::cmdRecoverSession (const juce::var& args)
{
    juce::HashMap<juce::String, juce::String> idMap;
    static const juce::StringArray idFields {
        "trackId", "clipId", "newClipId", "layerId", "busId", "groupTrackId", "sectionId", "annotationId" };

    int recovered = 0; bool halted = false;
    replayingRecovery_ = true;       // guards re-journaling AND per-command event emits
    for (int i = 0; i < pendingRecovery_.size(); ++i)
    {
        auto entry = JSON::parse (pendingRecovery_[i]);
        if (! entry.isObject()) continue;
        const auto name      = entry.getProperty ("c", var()).toString();
        const auto oldResult = entry.getProperty ("r", var());

        auto* co = new DynamicObject();
        co->setProperty ("command", name);
        co->setProperty ("args", substituteRecoveryIds (entry.getProperty ("a", var()), idMap));
        const auto result = executeImpl (var (co));
        if (! (bool) result.getProperty ("ok", false)) { halted = true; break; }   // halt; keep prior
        ++recovered;

        // Map this command's old→new assigned ids so later references rebind.
        const auto newData = result.getProperty ("data", var());
        for (auto& f : idFields)
        {
            const auto oldV = oldResult.getProperty (f, var()).toString();
            const auto newV = newData.getProperty (f, var()).toString();
            if (oldV.isNotEmpty() && newV.isNotEmpty() && oldV != newV) idMap.set (oldV, newV);
        }
    }
    replayingRecovery_ = false;

    pendingRecovery_.clear();
    if (recovered > 0) { eng.markDirty(); eng.save(); }   // persist recovered work (also truncates)
    // FS-B2a — the journal tail was replayed, so the POST-transaction state stands: a
    // crash-orphaned agent transaction is no longer ambiguous and skills are unblocked.
    resolveUnresolvedTxns (/*provedPostState=*/true);
    emitProjectReplaced ("recover_session");
    logLine ("recover_session", args, true, {}, false);

    auto* d = new DynamicObject();
    d->setProperty ("recovered", recovered);
    d->setProperty ("halted", halted);
    return okResult ("recover_session", var (d));
}

// FS-T2 — plugin-crash SAFE MODE. Reopen the current project with every third-party plugin
// left un-instantiated, and quarantine the suspect when there is exactly one.
//
// This is the escape hatch for the one crash autosave cannot help with: a plugin that dies
// while the project is LOADING re-crashes on every relaunch, so the user never reaches a
// window from which to save, undo, or remove it. (SPEC §2 puts out-of-process hosting out of
// the window; this is the in-window mitigation it names.)
//
// Sole-mutation-seam: this is a MoshOps command like any other — it does not add a second
// load path, it calls the engine's one bracketed loader, and quarantine goes through the
// existing block_plugin command rather than reaching into PluginHost directly.
juce::var MoshOps::cmdOpenWithoutPlugins (const juce::var& args)
{
    // Read the suspects BEFORE the reload clears them.
    const auto suspects = eng.pluginCrashSuspects();
    const auto target   = mosh::safemode::quarantineTarget (
                              std::vector<juce::String> (suspects.begin(), suspects.end()));

    unregisterAllMeterClients();        // old measurers are still valid here; the Edit is about to swap
    int skipped = 0;
    if (auto refusal = eng.reloadInSafeMode (&skipped); refusal.isNotEmpty())
    {
        logLine ("open_without_plugins", args, false, refusal, false);
        emitSnapshotInvalidated();
        return errResult ("open_without_plugins", refusal);
    }

    // Quarantine the suspect so it is not re-instantiated on the NEXT normal launch either.
    // Only ever a lone suspect (quarantineTarget); with several candidates we skipped them
    // all but blocklist none, because a guess would permanently quarantine plugins the user
    // paid for. A failure here (id not in the catalog) must NOT fail the open — the project
    // is already safely loaded, which is the point of the command.
    bool quarantined = false;
    if (target.isNotEmpty())
    {
        auto* a = new DynamicObject();
        a->setProperty ("pluginId", target);
        quarantined = (bool) cmdBlockPlugin (var (a)).getProperty ("ok", false);
    }

    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    logLine ("open_without_plugins", args, true, {}, false);   // machine op, not undoable
    emitProjectReplaced ("open_without_plugins");

    auto* d = new DynamicObject();
    d->setProperty ("pluginsSkipped", skipped);
    d->setProperty ("quarantined", quarantined ? target : juce::String());
    return okResult ("open_without_plugins", var (d));
}

juce::var MoshOps::cmdDiscardRecovery (const juce::var& args)
{
    pendingRecovery_.clear();
    recoveryJournalFile.deleteFile();
    // FS-B2a — the tail was dropped, so the last SAVED (pre-transaction) state stands.
    resolveUnresolvedTxns (/*provedPostState=*/false);
    // FS-T2 — this is the "dismiss the notice" action, and the notice carries the safe-mode
    // offer too, so drop the stale crash breadcrumb with it. (Reaching this command at all
    // proves the current launch loaded fine.)
    eng.clearPluginCrashSuspects();
    logLine ("discard_recovery", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("discard_recovery");
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
