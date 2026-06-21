#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <array>
#include <functional>
#include <map>
#include <memory>
#include "engine/MoshEngine.h"
#include "plugins/hosting/PluginHost.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#include "generative/GenerativeJobManager.h"
#include "training/TrainerRegistry.h"
#include "multiplayer/LockManager.h"
#include "multiplayer/MultiplayerSession.h"
#include "training/TrainingJobManager.h"

namespace mosh
{
/** MoshOps / DslExecutor — the single mutation surface (00 §6, reconstructs the
    missing spec 02). Every user-visible change is a typed command that:
      validate → begin a Tracktion undo transaction → mutate via engine APIs →
      emit typed events → append a JSONL line → return a structured result.

    The UI/tests/(future agent) all drive state ONLY through execute(). Pure view
    state (zoom/scroll/selection/drawers) is UI-local and never a command.

    Contract (see docs/02_MOSHOPS_CONTRACT.md):
      command  = { "command": string, "args"?: object }
      result   = { "ok": bool, "command": string, "data"?: any, "error"?: string }
      snapshot = { schemaVersion, session, tracks[], transport }
      event    = { "type": string, ... }   (pushed on the "mosh_event" channel) */
class MoshOps : private juce::Timer
{
public:
    explicit MoshOps (MoshEngine& engineToUse);
    ~MoshOps() override;

    /** A typed event sink (the app wires this to WebBridge::emitEvent). */
    using EventSink = std::function<void (const juce::var& event)>;
    void setEventSink (EventSink s) { eventSink = std::move (s); }

    /** MP-001 — the multiplayer lock guard's state (mirrors the relay lock table).
        The live poll path keeps this in sync; the guard in execute() reads it. */
    LockManager& lockManager() { return lockManager_; }

    /** The single entry point — bound to the WebView's execute_command. */
    juce::var execute (const juce::var& command);

    /** Full session snapshot — bound to the WebView's get_snapshot. */
    juce::var snapshot();

    /** Direct plugin-host access for the headless deep-scan CLI (--scan-plugins-deep),
        which runs a synchronous OOP + hang-watchdog rescan off the message thread.
        NOT used by the normal command surface (that goes through cmdRescanPlugins). */
    PluginHost& pluginHostForScan() { return pluginHost; }

private:
    // ── command handlers ──
    juce::var cmdCreateTrack    (const juce::var& args);
    juce::var cmdRenameTrack    (const juce::var& args);
    juce::var cmdRemoveTrack    (const juce::var& args);
    // MP-001 — 2-player multiplayer commit/apply (backend-only; not in the agent
    // catalog). mp_serialize_track captures a track's portable blob; apply_remote_
    // track rebuilds a peer's committed track (nullptr UndoManager, no relay echo);
    // mp_sync_locks mirrors the relay lock table into the guard.
    juce::var cmdMpSerializeTrack (const juce::var& args);
    juce::var cmdApplyRemoteTrack (const juce::var& args);
    juce::var cmdMpSyncLocks      (const juce::var& args);
    // The live session control plane (drives MultiplayerSession + its poll loop).
    juce::var cmdMpCreateSession  (const juce::var& args);
    juce::var cmdMpJoinSession    (const juce::var& args);
    juce::var cmdMpLeaveSession   (const juce::var& args);
    juce::var cmdMpClaimTrack     (const juce::var& args);
    juce::var cmdMpCommitTrack    (const juce::var& args);
    juce::var cmdMpBroadcastSelection (const juce::var& args);
    // P6 bootstrap — serialize the WHOLE project (all tracks) for a late-joiner,
    // and adopt a received bundle (clear local tracks, rebuild from the bundle).
    juce::var cmdMpSerializeProject (const juce::var& args);
    juce::var cmdMpApplyBootstrap   (const juce::var& args);
    // Structural channel — scalar session-global ops (tempo/timesig/master/key)
    // broadcast to the peer; mp_apply_structural re-executes a peer's op locally,
    // guard-bypassed + without re-broadcasting (echo-free). Buses/groups deferred.
    juce::var broadcastStructuralIfActive (const juce::String& name, const juce::var& args, juce::var result);
    juce::var cmdMpApplyStructural  (const juce::var& args);
    // Resolve the lock key (the affected track's logicalId, or the session key) for
    // a guarded command, given its scope + args. Engine-coupled (findTrack/findClip).
    juce::String lockKeyFor (LockManager::Scope scope, const juce::var& args);
    juce::var cmdImportClip     (const juce::var& args);
    juce::var cmdImportClipData (const juce::var& args);
    juce::var cmdAddTestTone    (const juce::var& args);
    juce::var cmdSetTransport   (const juce::var& args);
    juce::var cmdSetTempo       (const juce::var& args);
    juce::var cmdSetTimeSignature (const juce::var& args);
    juce::var cmdSetMetronome   (const juce::var& args);
    juce::var cmdUndo           (const juce::var& args);
    juce::var cmdRedo           (const juce::var& args);
    juce::var cmdBatchBegin     (const juce::var& args);   // group N agent edits into ONE undo step
    juce::var cmdBatchEnd       (const juce::var& args);
    juce::var cmdSave           (const juce::var& args);
    juce::var cmdReload         (const juce::var& args);
    juce::var cmdAddRenderLayer (const juce::var& args);
    // Stage 2 — arrangement editing + mixer stub
    juce::var cmdMoveClip       (const juce::var& args);
    juce::var cmdTrimClip       (const juce::var& args);
    juce::var cmdSplitClip      (const juce::var& args);
    juce::var cmdRemoveClip     (const juce::var& args);
    juce::var cmdRenameClip     (const juce::var& args);
    juce::var cmdSetClipMute    (const juce::var& args);
    juce::var cmdSetClipGain    (const juce::var& args);
    juce::var cmdRelinkClip     (const juce::var& args);   // gap 3 — re-point a missing wave source
    // Audio warp — auto-tempo: the clip re-anchors in BEATS and time-stretches to
    // follow the tempo map (SoundTouch; warp MARKERS are a deferred subsystem).
    juce::var cmdSetClipWarp    (const juce::var& args);
    juce::var cmdDuplicateClip  (const juce::var& args);
    juce::var cmdPasteClip      (const juce::var& args);
    // Wave C — ARR-010: time-range as a true delete target. One undoable
    // transaction: per targeted track, split overlapping clips at the range
    // bounds and remove the fully-inside segment(s).
    juce::var cmdDeleteTimeRange (const juce::var& args);
    juce::var cmdSetTrackVolume (const juce::var& args);
    juce::var cmdSetTrackPan    (const juce::var& args);
    juce::var cmdSetTrackMute   (const juce::var& args);
    juce::var cmdSetTrackSolo   (const juce::var& args);
    // Wave: recording — arm tracks + input monitoring
    juce::var cmdArmTrack       (const juce::var& args);
    juce::var cmdSetInputMonitor (const juce::var& args);
    // Wave B — record-to-take (TRA-002 / MID-001 / ARE-003): stop the transport
    // KEEPING takes, drain the async clip-add, return the landed clip ids.
    juce::var cmdStopRecording  (const juce::var& args);
    // Take lanes (audio): expose Tracktion's native take tree — list/select/keep.
    juce::var cmdListTakes      (const juce::var& args);
    juce::var cmdSetCurrentTake (const juce::var& args);
    juce::var cmdKeepTake       (const juce::var& args);
    juce::var cmdSetMasterVolume (const juce::var& args);
    juce::var cmdSetMasterPan    (const juce::var& args);
    // Wave 9 — channel metering
    juce::var cmdEnableTrackMeter  (const juce::var& args);
    juce::var cmdDisableTrackMeter (const juce::var& args);
    juce::var cmdEnableAllMeters   (const juce::var& args);
    // Wave 8 — sends / returns / aux buses
    juce::var cmdCreateBus      (const juce::var& args);
    juce::var cmdAddSend        (const juce::var& args);
    juce::var cmdSetSendLevel   (const juce::var& args);
    juce::var cmdRemoveSend     (const juce::var& args);
    juce::var cmdRemoveBus      (const juce::var& args);
    juce::var cmdRenameBus      (const juce::var& args);
    juce::var cmdGetClipPeaks   (const juce::var& args);
    juce::var cmdFilePeaks      (const juce::var& args);   // peaks for an un-imported file (read-only)
    // Stage 3 — VST3 hosting + MIDI
    juce::var cmdListPlugins    (const juce::var& args);
    juce::var cmdListBuiltins   (const juce::var& args);
    juce::var cmdLoadPlugin     (const juce::var& args);
    juce::var cmdLoadBuiltin    (const juce::var& args);
    // DRM-001 — drum instruments: a working sampler+kit, per-pad sample assignment,
    // and the track-type flag a drum track binds to (see Ids.h trackType).
    juce::var cmdSetTrackType   (const juce::var& args);
    juce::var cmdLoadDrumKit    (const juce::var& args);
    juce::var cmdAssignSample   (const juce::var& args);
    juce::var cmdSetDrumLane    (const juce::var& args);
    juce::var cmdRemovePlugin   (const juce::var& args);
    juce::var cmdReorderPlugin  (const juce::var& args);
    juce::var cmdSetPluginParam (const juce::var& args);
    juce::var cmdBypassPlugin   (const juce::var& args);
    // INS-005 — plugin scan / blocklist / management (NON-undoable: catalog ops,
    // not Edit mutations). rescan persists the catalog; the rest are read-only or
    // catalog-only, so none take a Tracktion transaction.
    juce::var cmdRescanPlugins      (const juce::var& args);   // async catalog re-enumeration (persists)
    juce::var cmdGetPluginBlocklist (const juce::var& args);   // read-only (no log/transaction)
    juce::var cmdClearPluginBlocklist (const juce::var& args); // catalog-only (undoable:false)
    juce::var cmdBlockPlugin        (const juce::var& args);   // catalog-only (undoable:false)
    // Wave 7 — parameter automation
    juce::var cmdAddAutomationPoint    (const juce::var& args);
    juce::var cmdRemoveAutomationPoint (const juce::var& args);
    juce::var cmdSetAutomationPoint     (const juce::var& args);
    juce::var cmdClearAutomation        (const juce::var& args);
    juce::var cmdOpenPluginEditor (const juce::var& args);
    juce::var cmdAddMidiClip    (const juce::var& args);
    juce::var cmdTranscribeClip (const juce::var& args);  // audio->MIDI (Basic Pitch)
    juce::var cmdSketchBeatbox  (const juce::var& args);  // Sketch P0: beatbox->drum MoshOps
    juce::var cmdAddNote        (const juce::var& args);
    juce::var cmdRemoveNote     (const juce::var& args);
    juce::var cmdSetNote        (const juce::var& args);
    juce::var cmdQuantizeNotes  (const juce::var& args);
    // Stage 4 — Tier-A real-time neural insert
    juce::var cmdAddNeuralInsert (const juce::var& args);
    juce::var cmdSetNeuralParam  (const juce::var& args);
    juce::var cmdSetNeuralLabMode(const juce::var& args);
    juce::var cmdSetNeuralLatency(const juce::var& args);
    juce::var cmdResetNeural     (const juce::var& args);
    // GAP 1 — load a real Tier-A model file (RTNeural JSON) into a neural insert. When
    // MOSH_HAVE_RTNEURAL is NOT built this returns ok with { applied:false,
    // reason:"RTNeural not built" } — a graceful no-op so the default build stays green.
    juce::var cmdLoadNeuralModel (const juce::var& args);
    // Stage 5 — Tier-B generative layer (RenderLayer flow)
    juce::var cmdCreateRenderLayer (const juce::var& args);
    juce::var cmdSetRenderParam   (const juce::var& args);
    juce::var cmdRenderLayer      (const juce::var& args);
    juce::var cmdCancelRender     (const juce::var& args);
    juce::var cmdAcceptRender     (const juce::var& args);
    juce::var cmdRejectRender     (const juce::var& args);
    juce::var cmdBypassLayer      (const juce::var& args);
    juce::var cmdFreezeLayer      (const juce::var& args);
    juce::var cmdBounceLayerToClip(const juce::var& args);
    juce::var cmdRemoveRenderLayer(const juce::var& args);
    juce::var cmdListColors       (const juce::var& args);
    // Stage 6 — consolidation
    juce::var cmdExportAudio      (const juce::var& args);
    // Wave: settings — audio device picker + project lifecycle (both NON-undoable)
    juce::var cmdListAudioDevices (const juce::var& args);   // read-only (no log/transaction)
    juce::var cmdListMidiInputs   (const juce::var& args);   // read-only MIDI-input enumeration (CTL-001)
    juce::var cmdGetCommandLog    (const juce::var& args);   // read-only (reads mosh-log.jsonl; NOT logged)
    juce::var cmdSetAudioDevice   (const juce::var& args);   // machine preference (undoable:false)
    juce::var cmdSetBufferSize    (const juce::var& args);   // thin wrapper over set_audio_device
    juce::var cmdSetAudioThreads  (const juce::var& args);   // PRF-001 multicore pref (undoable:false)
    juce::var cmdListDirectory    (const juce::var& args);   // BRW-001 read-only file browse (no log/transaction)
    juce::var cmdAuditionFile     (const juce::var& args);   // standalone file preview (transient, no undo/log)
    juce::var cmdStopAudition     (const juce::var& args);
    juce::var cmdNewProject       (const juce::var& args);   // replaces the Edit (undoable:false)
    juce::var cmdOpenProject      (const juce::var& args);   // replaces the Edit (undoable:false)
    juce::var cmdSaveAs           (const juce::var& args);   // persists + re-points (undoable:false)
    // PRJ-008 — per-project format / time-base intent (undoable:false preference,
    // stored on a MOSH_PROJECT child of the Edit tree; saves/reloads with the edit).
    juce::var cmdSetProjectSettings (const juce::var& args);
    // KEY-001 — the project's musical key (tonic + mode), same MOSH_PROJECT node as
    // the format intent. NON-undoable preference (cmdSetProjectSettings template);
    // validated against the voice.js NOTE_PC/SCALES domains; feeds the snapshot
    // (session.project.key) + the RenderLayer fingerprint (a key change = cache MISS).
    juce::var cmdSetKey (const juce::var& args);
    // MIX-008 — group (submix) tracks: a te::FolderTrack created asSubmix=true sums
    // its children through a SummingNode + its own plugin chain (engine-proven).
    juce::var cmdCreateGroupTrack (const juce::var& args);   // undoable (one transaction)
    juce::var cmdUngroupTrack     (const juce::var& args);   // undoable (hoists children, deletes group)
    // RTG-001/002 — per-track input choice + output routing over the engine's own
    // machinery (WaveInputDevice-per-pair + te::TrackOutput).
    juce::var cmdListWaveInputs   (const juce::var& args);   // read-only (no log/transaction)
    juce::var cmdSetTrackInput    (const juce::var& args);   // monitoring preference (undoable:false)
    juce::var cmdListTrackOutputs (const juce::var& args);   // read-only (no log/transaction)
    juce::var cmdSetTrackOutput   (const juce::var& args);   // undoable (TrackOutput is Edit-UM-bound)
    // SES-001 — the tempo MAP: tempo / time-sig changes over time (step changes,
    // curve=1.0; the engine's TempoSequence does the math + playback natively).
    juce::var cmdInsertTempoChange   (const juce::var& args); // undoable (optional curve)
    juce::var cmdSetTempoCurve       (const juce::var& args); // undoable (ramp shape N -> N+1)
    juce::var cmdRemoveTempoChange   (const juce::var& args); // undoable (index>0)
    juce::var cmdInsertTimeSigChange (const juce::var& args); // undoable
    juce::var cmdRemoveTimeSigChange (const juce::var& args); // undoable (index>0)
    // Stage 7 — rights-cleared type-beat LoRA training + rights registry. Catalog/
    // job ops (NON-undoable: they touch the rights registry + the training service,
    // not the Edit), so none take a Tracktion transaction.
    juce::var cmdImportTrainingSource   (const juce::var& args);
    juce::var cmdListTrainingSources    (const juce::var& args);
    juce::var cmdApproveTrainingSource  (const juce::var& args);
    juce::var cmdBuildTrainingCorpus    (const juce::var& args);
    juce::var cmdSubmitTrainingJob      (const juce::var& args);
    juce::var cmdTrainingJobStatus      (const juce::var& args);
    juce::var cmdCancelTrainingJob      (const juce::var& args);
    juce::var cmdImportLoraAdapter      (const juce::var& args);
    juce::var cmdActivateLoraAdapter    (const juce::var& args);
    juce::var cmdListLoraAdapters       (const juce::var& args);

    // The MOSH_PROJECT child of eng.edit().state, created (empty) on first read so
    // callers always get a valid tree. Pure storage accessor — no logging/transaction.
    juce::ValueTree projectSettingsTree();
    // The resolved { sampleRate, bitDepth, timeBase, key } block: the stored project
    // INTENT where set, falling back to the live device readout when a field is
    // unset (timeBase falls back to "seconds"). Used by the snapshot + cmd result.
    juce::var projectSettingsToVar();

    // KEY-001 — the default musical key surfaced in the snapshot before any set_key
    // (A/minor — matches the voice's neutral A4 tonic + SCALES.minor in voice.js).
    static const char* const kDefaultKeyTonic;
    static const char* const kDefaultKeyMode;

    juce::ValueTree findRenderLayer (const juce::String& clipId);
    juce::String    computeFingerprint (const juce::ValueTree& node, const juce::File& inputWav);
    void            finalizeRender (const juce::String& clipId, const juce::File& outputWav,
                                    const juce::File& manifestFile, const juce::String& cacheKey);

    // ── helpers ──
    te::AudioTrack* createAudioTrack (const juce::String& name);
    // Shared wave-file insertion path used by import_clip and import_clip_data.
    juce::var       importWaveFileToTrack (const juce::String& command,
                                           const juce::File& file,
                                           const juce::String& clipName,
                                           const juce::String& trackId,
                                           double startSeconds,
                                           const juce::var& logArgs);
    te::VolumeAndPanPlugin* ensureVolumePlugin (te::AudioTrack&);
    te::AudioTrack* findTrack (const juce::String& id);
    te::FolderTrack* findGroupTrack (const juce::String& id);   // MIX-008 submix folder lookup
    te::Clip*       findClip  (const juce::String& id);
    // True when the track hosts an instrument plugin (external synth or a builtin
    // instrument) — the same test pluginToVar uses for the "isInstrument" flag.
    // arm_track routes live MIDI (not wave) to such tracks (CTL-001).
    bool            trackHasInstrument (te::AudioTrack&);
    // DRM-001 — drum-kit helpers.
    // drumKitDir(): the bundled default kit dir (env MOSH_DRUMKIT_DIR overrides;
    // else Mosh.app/Contents/Resources/drumkits/mosh-kit; else next to the exe).
    juce::File           drumKitDir() const;
    // True when at least one bundled pad is resolvable — guard mutations that load
    // the kit so a missing/broken kit is a clean no-op, not a partial insert/wipe.
    bool                 drumKitAvailable() const;
    // ensureSampler(): the track's existing te::SamplerPlugin, or a fresh one
    // inserted at the front of the chain (instrument-first).
    te::SamplerPlugin*   ensureSampler (te::AudioTrack&);
    // findSampler(): the track's te::SamplerPlugin if present (never creates one).
    te::SamplerPlugin*   findSampler (te::AudioTrack&) const;
    // applyDrumLaneGains(): silence (gain -100) the sampler pads whose GM pitch is
    // muted (or, when any lane is soloed, every pad EXCEPT the soloed ones); restore
    // formerly-muted pads to 0 dB. Only touches pads crossing the mute threshold, so
    // a non-muted pad's custom gain is left alone. Reads the drumMute/drumSolo props.
    void                 applyDrumLaneGains (te::AudioTrack&);
    // loadDrumKitInto(): clear + load the 8 bundled pads onto a sampler, each
    // mapped to its GM pitch (keyNote==minNote==maxNote) and open-ended. Pumps the
    // sampler's async file load headless. Returns the number of pads loaded.
    int                  loadDrumKitInto (te::SamplerPlugin&);
    // ensureDefaultInstrument(): if the track has no instrument, auto-load the sane
    // default — drum track → sampler+kit; melodic → 4OSC — so MIDI notes are
    // audible immediately. No-op when an instrument is already present.
    void                 ensureDefaultInstrument (te::AudioTrack&, bool drum);
    te::Plugin*     findPlugin (const juce::String& trackId, int index);
    te::AutomatableParameter* findParam (const juce::var& args);
    te::AuxReturnPlugin* firstAuxReturnOn (te::AudioTrack&);
    te::AudioTrack*      findReturnTrackForBus (int bus);
    int                  allocateBusNumber();

    // ── metering (Wave 9): a level-meter tap + registered measurer client / track ──
    struct MeterTap { te::LevelMeterPlugin* plugin = nullptr; te::LevelMeasurer::Client client; };
    te::LevelMeterPlugin* ensureTrackMeter (te::AudioTrack&);
    te::LevelMeterPlugin* findTrackMeter (te::AudioTrack&);
    void reconcileMeterClients();           // sync client map to live taps (undo/redo-safe)
    void unregisterAllMeterClients();       // removeClient on still-valid measurers, then clear
    std::map<juce::String, std::unique_ptr<MeterTap>> meterClients;
    te::LevelMeasurer::Client masterClient;
    te::EditPlaybackContext*  lastSeenContext = nullptr;

    // ── master spectral feed (Moshi reactivity) ── drain a pure-measure tap on the
    // master plugin list at 30 Hz, window + Goertzel into 12 log-spaced bands, and
    // emit the `spectrum` event (mirrors `levels`). All on the message thread.
    MasterSpectralTapPlugin* ensureMasterSpectralTap();   // find on the master list or append
    MasterSpectralTapPlugin* findMasterSpectralTap();
    void  emitSpectrum (bool playing);                    // drain tap → Goertzel bands → emit
    std::array<float, 1024> spectralRing {};              // rolling mono history
    int   spectralRingPos = 0;
    std::array<float, 12> spectralPrevBands {};           // for spectral flux
    bool  spectrumActive = false;                         // emit one zero on the play→stop edge

    juce::var       pluginToVar (te::Plugin&, int index);
    juce::var       trackToVar (te::AudioTrack&, int index);
    juce::var       clipToVar  (te::Clip&);
    juce::var       transportToVar();

    void  timerCallback() override;          // decimated playhead/meters (02 §4.2)

    void  emit (const juce::String& type, juce::var payload = {});
    void  emitSnapshotInvalidated();
    void  logLine (const juce::String& command, const juce::var& args,
                   bool ok, const juce::String& error, bool undoable);

    static juce::var okResult  (const juce::String& command, juce::var data = {});
    static juce::var errResult (const juce::String& command, const juce::String& message);

    juce::UndoManager& undoManager() { return eng.edit().getUndoManager(); }

    // Agent "Monster changes": inside a batch (batch_begin..batch_end) every command
    // coalesces into the ONE transaction batch_begin opened, so the whole batch undoes
    // as a single step. Outside a batch this is identical to the old per-command call.
    void beginTxn (const juce::String& name) { eng.markDirty(); if (! inBatch) undoManager().beginNewTransaction (name); }

    /** The JUCE device manager under Tracktion's wrapper — the object the device
        picker drives (the same one MoshEngine::applyRequestedAudioOutputDevice
        uses). */
    juce::AudioDeviceManager& adm() { return eng.engine().getDeviceManager().deviceManager; }
    juce::var currentAudioSelection();   // small {type,outputDevice,...} summary block
    // Applies a device-setup patch; returns the error string (empty == success). No
    // logging — callers log once under their own command name (one JSONL line / action).
    juce::String applyAudioDeviceSetup (const juce::var& args);

    // ── Standalone audition (file preview): plays an arbitrary audio file through the
    //    device, independent of the Edit (no undo, no log). Wired to the device manager
    //    lazily on first audition; torn down in stopAudition()/the destructor. ──
    juce::AudioFormatManager   previewFormats;
    juce::TimeSliceThread      previewThread { "mosh-audition" };
    juce::AudioTransportSource previewTransport;
    juce::AudioSourcePlayer    previewPlayer;
    std::unique_ptr<juce::AudioFormatReaderSource> previewReader;
    bool previewWired = false;
    void stopAudition();

    MoshEngine& eng;
    PluginHost  pluginHost;
    GenerativeJobManager jobManager;
    TrainerRegistry      trainerRegistry;
    TrainingJobManager   trainingJobManager;
    EventSink   eventSink;
    LockManager lockManager_;          // MP-001 — multiplayer lock guard state
    std::unique_ptr<MultiplayerSession> mpSession_;   // MP-001 — live session + poll loop
    bool applyingRemote_ = false;      // MP-001 — true while applying a peer's structural op
    juce::int64 seq = 0;
    juce::File  logFile;
    bool        wasPlaying = false;
    bool        inBatch    = false;   // true between batch_begin / batch_end (agent batch = one undo step)

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshOps)
};

} // namespace mosh
