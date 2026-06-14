#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <functional>
#include <map>
#include <memory>
#include <array>
#include "engine/MoshEngine.h"
#include "plugins/hosting/PluginHost.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#include "generative/GenerativeJobManager.h"
#include "training/TrainerRegistry.h"
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

    /** The single entry point — bound to the WebView's execute_command. */
    juce::var execute (const juce::var& command);

    /** Full session snapshot — bound to the WebView's get_snapshot. */
    juce::var snapshot();

private:
    // ── command handlers ──
    juce::var cmdCreateTrack    (const juce::var& args);
    juce::var cmdRenameTrack    (const juce::var& args);
    juce::var cmdRemoveTrack    (const juce::var& args);
    juce::var cmdImportClip     (const juce::var& args);
    juce::var cmdImportClipData (const juce::var& args);
    juce::var cmdAddTestTone    (const juce::var& args);
    juce::var cmdSetTransport   (const juce::var& args);
    juce::var cmdSetTempo       (const juce::var& args);
    juce::var cmdSetTimeSignature (const juce::var& args);
    juce::var cmdSetMetronome   (const juce::var& args);
    juce::var cmdUndo           (const juce::var& args);
    juce::var cmdRedo           (const juce::var& args);
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
    // Stage 3 — VST3 hosting + MIDI
    juce::var cmdListPlugins    (const juce::var& args);
    juce::var cmdListBuiltins   (const juce::var& args);
    juce::var cmdLoadPlugin     (const juce::var& args);
    juce::var cmdLoadBuiltin    (const juce::var& args);
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
    // Stage 7 — type-beat LoRA training + rights registry
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
    juce::var cmdNewProject       (const juce::var& args);   // replaces the Edit (undoable:false)
    juce::var cmdOpenProject      (const juce::var& args);   // replaces the Edit (undoable:false)
    juce::var cmdSaveAs           (const juce::var& args);   // persists + re-points (undoable:false)
    // PRJ-008 — per-project format / time-base intent (undoable:false preference,
    // stored on a MOSH_PROJECT child of the Edit tree; saves/reloads with the edit).
    juce::var cmdSetProjectSettings (const juce::var& args);
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

    // The MOSH_PROJECT child of eng.edit().state, created (empty) on first read so
    // callers always get a valid tree. Pure storage accessor — no logging/transaction.
    juce::ValueTree projectSettingsTree();
    // The resolved { sampleRate, bitDepth, timeBase } block: the stored project
    // INTENT where set, falling back to the live device readout when a field is
    // unset (timeBase falls back to "seconds"). Used by the snapshot + cmd result.
    juce::var projectSettingsToVar();

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

    // ── master spectral feed (Moshi reactivity, Part B) ──
    MasterSpectralTapPlugin* ensureMasterSpectralTap();   // find on the master list or append
    MasterSpectralTapPlugin* findMasterSpectralTap();
    void emitSpectrum (bool playing);                     // drain tap → Goertzel bands → emit
    std::array<float, 1024> spectralRing {};              // rolling mono history (message thread)
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

    /** The JUCE device manager under Tracktion's wrapper — the object the device
        picker drives (the same one MoshEngine::applyRequestedAudioOutputDevice
        uses). */
    juce::AudioDeviceManager& adm() { return eng.engine().getDeviceManager().deviceManager; }
    juce::var currentAudioSelection();   // small {type,outputDevice,...} summary block
    // Applies a device-setup patch; returns the error string (empty == success). No
    // logging — callers log once under their own command name (one JSONL line / action).
    juce::String applyAudioDeviceSetup (const juce::var& args);

    MoshEngine& eng;
    PluginHost  pluginHost;
    GenerativeJobManager jobManager;
    TrainerRegistry      trainerRegistry;
    TrainingJobManager   trainingJobManager;
    EventSink   eventSink;
    juce::int64 seq = 0;
    juce::File  logFile;
    bool        wasPlaying = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshOps)
};

} // namespace mosh
