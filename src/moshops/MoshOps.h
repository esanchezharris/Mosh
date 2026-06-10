#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <functional>
#include <map>
#include <memory>
#include "engine/MoshEngine.h"
#include "plugins/hosting/PluginHost.h"
#include "generative/GenerativeJobManager.h"

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

    /** MoshIR entry (`execute_ir`). The IR layer sits ABOVE MoshOps (it lowers
        IR ops to commands and feeds them back through execute()), so MoshOps
        only holds a hook — Main/SelfTest wire it to a mosh::ir::Executor.
        Keeps the one-mutation-path rule: IR is just another caller. */
    using IRHook = std::function<juce::var (const juce::var& args)>;
    void setIRHook (IRHook h) { irHook = std::move (h); }

    /** Session-recorder observer (phase0 §5): fired once per top-level command
        (depth 0 — IR-lowered sub-commands are not double-observed). */
    using CommandObserver = std::function<void (const juce::String& name,
                                                const juce::var& args,
                                                const juce::var& result)>;
    void setCommandObserver (CommandObserver o) { commandObserver = std::move (o); }

    /** Collab-sync hook (Stage 10): collab_* commands route here (the engine
        lives in src/collab, above MoshOps — same layering as the IR hook). */
    using CollabHook = std::function<juce::var (const juce::String& name, const juce::var& args)>;
    void setCollabHook (CollabHook h) { collabHook = std::move (h); }

    /** Result envelopes (public: the IR layer composes them too). */
    static juce::var okResult  (const juce::String& command, juce::var data = {});
    static juce::var errResult (const juce::String& command, const juce::String& message);

private:
    juce::var dispatch (const juce::String& name, const juce::var& args);

    // ── command handlers ──
    juce::var cmdCreateTrack    (const juce::var& args);
    juce::var cmdRenameTrack    (const juce::var& args);
    juce::var cmdRemoveTrack    (const juce::var& args);
    juce::var cmdImportClip     (const juce::var& args);
    juce::var cmdAddTestTone    (const juce::var& args);
    juce::var cmdSetTransport   (const juce::var& args);
    juce::var cmdListAudioOutputs (const juce::var& args);   // Stage 14: device truth
    juce::var cmdSetAudioOutput   (const juce::var& args);   // machine-local, never synced
    // Stage 15 — real-DAW basics
    juce::var cmdSetMetronome     (const juce::var& args);   // playback aid, never synced/hashed
    juce::var cmdSetMasterVolume  (const juce::var& args);
    juce::var cmdDuplicateClip    (const juce::var& args);
    juce::var cmdMoveTrack        (const juce::var& args);
    juce::var cmdChooseFile       (const juce::var& args);   // native dialog; read-only
    juce::var cmdUndo           (const juce::var& args);
    juce::var cmdRedo           (const juce::var& args);
    juce::var cmdSave           (const juce::var& args);
    juce::var cmdReload         (const juce::var& args);
    juce::var cmdAddRenderLayer (const juce::var& args);
    // Stage 2 — arrangement editing + mixer stub
    juce::var cmdMoveClip       (const juce::var& args);
    juce::var cmdTrimClip       (const juce::var& args);
    juce::var cmdSplitClip      (const juce::var& args);
    juce::var cmdSetTrackVolume (const juce::var& args);
    juce::var cmdSetTrackPan    (const juce::var& args);
    juce::var cmdSetTrackMute   (const juce::var& args);
    juce::var cmdSetTrackSolo   (const juce::var& args);
    juce::var cmdGetClipPeaks   (const juce::var& args);
    // Stage 3 — VST3 hosting + MIDI
    juce::var cmdListPlugins    (const juce::var& args);
    juce::var cmdLoadPlugin     (const juce::var& args);
    juce::var cmdRemovePlugin   (const juce::var& args);
    juce::var cmdReorderPlugin  (const juce::var& args);
    juce::var cmdSetPluginParam (const juce::var& args);
    juce::var cmdBypassPlugin   (const juce::var& args);
    juce::var cmdOpenPluginEditor (const juce::var& args);
    juce::var cmdAddMidiClip    (const juce::var& args);
    // Stage 4 — Tier-A real-time neural insert
    juce::var cmdAddNeuralInsert (const juce::var& args);
    juce::var cmdSetNeuralParam  (const juce::var& args);
    juce::var cmdSetNeuralLabMode(const juce::var& args);
    juce::var cmdSetNeuralLatency(const juce::var& args);
    juce::var cmdResetNeural     (const juce::var& args);
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
    juce::var cmdListColors       (const juce::var& args);
    // Stage 6 — consolidation
    juce::var cmdExportAudio      (const juce::var& args);
    // Stage 7 — MoshIR engine gaps (phase0 §3.3: tempo/key/notes/sampler/
    // sends/sidechain/automation/sections). Implemented in MoshOpsStage7.cpp.
    juce::var cmdSetTempo        (const juce::var& args);
    juce::var cmdSetTimeSig      (const juce::var& args);
    juce::var cmdSetKey          (const juce::var& args);
    juce::var cmdAddNotes        (const juce::var& args);
    juce::var cmdRemoveNotes     (const juce::var& args);
    juce::var cmdTransposeNotes  (const juce::var& args);
    juce::var cmdQuantizeNotes   (const juce::var& args);
    juce::var cmdHumanizeNotes   (const juce::var& args);
    juce::var cmdLoadBuiltin     (const juce::var& args);
    juce::var cmdAddSamplerSound (const juce::var& args);
    juce::var cmdRemoveClip      (const juce::var& args);
    juce::var cmdRouteTrack      (const juce::var& args);
    juce::var cmdAddSend         (const juce::var& args);
    juce::var cmdAddReturn       (const juce::var& args);
    juce::var cmdSetSidechain    (const juce::var& args);
    juce::var cmdWriteAutomation (const juce::var& args);
    juce::var cmdSetClipPitch    (const juce::var& args);
    juce::var cmdSetClipStretch  (const juce::var& args);
    juce::var cmdSliceClip       (const juce::var& args);
    juce::var cmdCreateSection   (const juce::var& args);
    // Stage 8 — replay harness + determinism (phase0 §4). MoshOpsStage8.cpp.
    juce::var cmdGetStateHash    (const juce::var& args);
    juce::var cmdGenerateAsset   (const juce::var& args);
    // Stage 11 — Monster v0 (phase0 §10). MoshOpsStage11.cpp.
    juce::var cmdAgentPropose    (const juce::var& args);

    juce::ValueTree findRenderLayer (const juce::String& clipId);
    juce::String    computeFingerprint (const juce::ValueTree& node, const juce::File& inputWav);
    void            finalizeRender (const juce::String& clipId, const juce::File& outputWav,
                                    const juce::File& manifestFile, const juce::String& cacheKey);

    // ── helpers ──
    te::AudioTrack* createAudioTrack (const juce::String& name);
    te::VolumeAndPanPlugin* ensureVolumePlugin (te::AudioTrack&);
    te::AudioTrack* findTrack (const juce::String& id);
    te::Clip*       findClip  (const juce::String& id);
    te::Plugin*     findPlugin (const juce::String& trackId, int index);
    juce::var       pluginToVar (te::Plugin&, int index);
    juce::var       trackToVar (te::AudioTrack&, int index);
    juce::var       clipToVar  (te::Clip&);
    juce::var       transportToVar();

    void  timerCallback() override;          // decimated playhead/meters (02 §4.2)

    void  emit (const juce::String& type, juce::var payload = {});
    void  emitSnapshotInvalidated();
    void  logLine (const juce::String& command, const juce::var& args,
                   bool ok, const juce::String& error, bool undoable);

    juce::UndoManager& undoManager() { return eng.edit().getUndoManager(); }

    te::MidiClip* findMidiClip (const juce::String& id);
    te::AutomatableParameter::Ptr findParamByName (te::Plugin&, const juce::String& name);
    double beatsToSeconds (double beats);

    // ── engine-output meters (Stage 14) ──
    // A te::LevelMeterPlugin on the master chain + every audio track; the 30 Hz
    // timer polls them into the transport event. Meters are observability, NOT
    // musical state: the canonical hash and the snapshot's rack list skip type
    // "level", so they never perturb replay determinism or the device chain.
    void adoptEditMeters();                         // (re)attach after an edit swap
    te::LevelMeterPlugin* ensureMasterMeter();
    te::LevelMeterPlugin* ensureTrackMeter (te::AudioTrack&);
    juce::var meterLevels();                        // {master:[L,R], tracks:{id:[L,R]}} in dB

    // ALL plugin index args/results live in "visible" space — the pluginList
    // minus meter taps. Stored trajectories/oplogs/exemplars predate meters,
    // so visible space is the only index space that stays replayable. The tap
    // is pinned to the chain END (it must measure the track's OUTPUT).
    juce::Array<te::Plugin*> visiblePlugins (te::AudioTrack&);
    int  visiblePluginIndex (te::AudioTrack&, te::Plugin*);
    void ensureMeterLast (te::AudioTrack&);

    MoshEngine& eng;
    PluginHost  pluginHost;
    GenerativeJobManager jobManager;
    EventSink   eventSink;
    IRHook      irHook;
    CommandObserver commandObserver;
    CollabHook  collabHook;
    int         execDepth = 0;
    juce::int64 seq = 0;
    juce::File  logFile;
    bool        wasPlaying = false;

    // Meter poll clients, keyed by meter-plugin itemID. CRITICAL lifetime rule
    // (smoke-caught UAF): the playback graph's LevelMeasurerProcessingNode
    // holds a refcounted Plugin::Ptr, so a meter plugin OUTLIVES its edit —
    // a client must therefore be removeClient()ed via a held Plugin::Ptr
    // before it is destroyed, on every path (swap, prune, shutdown).
    struct MeterClient
    {
        te::Plugin::Ptr plugin;    // keeps the measurer alive for removeClient
        std::unique_ptr<te::LevelMeasurer::Client> client;
    };
    void releaseMeterClient (MeterClient&);
    void releaseAllMeterClients();
    te::Edit* meterEdit = nullptr;
    std::map<juce::String, MeterClient> meterClients;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshOps)
};

} // namespace mosh
