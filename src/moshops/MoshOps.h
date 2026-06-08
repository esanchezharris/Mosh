#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <functional>
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

private:
    // ── command handlers ──
    juce::var cmdCreateTrack    (const juce::var& args);
    juce::var cmdRenameTrack    (const juce::var& args);
    juce::var cmdRemoveTrack    (const juce::var& args);
    juce::var cmdImportClip     (const juce::var& args);
    juce::var cmdAddTestTone    (const juce::var& args);
    juce::var cmdSetTransport   (const juce::var& args);
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
    // Stage 6 — consolidation
    juce::var cmdExportAudio      (const juce::var& args);

    juce::ValueTree findRenderLayer (const juce::String& clipId);
    juce::String    computeFingerprint (const juce::ValueTree& node, const juce::File& inputWav);
    void            finalizeRender (const juce::String& clipId, const juce::File& outputWav,
                                    const juce::File& manifestFile, const juce::String& cacheKey);

    // ── helpers ──
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

    static juce::var okResult  (const juce::String& command, juce::var data = {});
    static juce::var errResult (const juce::String& command, const juce::String& message);

    juce::UndoManager& undoManager() { return eng.edit().getUndoManager(); }

    MoshEngine& eng;
    PluginHost  pluginHost;
    GenerativeJobManager jobManager;
    EventSink   eventSink;
    juce::int64 seq = 0;
    juce::File  logFile;
    bool        wasPlaying = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshOps)
};

} // namespace mosh
