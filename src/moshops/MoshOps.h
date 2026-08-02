#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <array>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <vector>
#include "engine/MoshEngine.h"
#include "moshops/AgentTxn.h"
#include "moshops/TransactionSafe.h"
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

    /** The single entry point — bound to the WebView's execute_command. Thin wrapper around
        executeImpl that also feeds the A3 crash-recovery journal. */
    juce::var execute (const juce::var& command);

    /** Browser-only read path. list_directory is pure filesystem I/O and may block on
        a large, cloud-backed, or disconnected directory, so WebBridge invokes this
        method on a worker instead of the audio/message thread. */
    static juce::var executeFileBrowserReadOnly (const juce::File& sessionDir,
                                                  const juce::var& command);

    /** Full session snapshot — bound to the WebView's get_snapshot. */
    juce::var snapshot();

    void applyMultiplayerCommitForSelfTest (const juce::var& msg);

    /** Direct plugin-host access for the headless deep-scan CLI (--scan-plugins-deep),
        which runs a synchronous OOP + hang-watchdog rescan off the message thread.
        NOT used by the normal command surface (that goes through cmdRescanPlugins). */
    PluginHost& pluginHostForScan() { return pluginHost; }

    /** WP-11 best-of-n relays (NOT commands — brain traffic is UI-domain, no engine
        mutation, no undo, no JSONL command log; same layering as brain_chat). The
        WebBridge relay calls these on a background thread. */
    juce::var escalateCandidates (const juce::var& payload) { return jobManager.escalateCandidates (payload); }
    bool archiveDpoPair (const juce::var& row)              { return jobManager.archivePair (row); }

private:
    // ── command handlers ──
    void applyMultiplayerCommitMessage (const juce::var& msg);
    juce::var cmdCreateTrack    (const juce::var& args);
    juce::var cmdRenameTrack    (const juce::var& args);
    juce::var cmdRemoveTrack    (const juce::var& args);
    // SEC-001 — named song sections (MOSH_SECTIONS tree on the Edit; undoable).
    juce::var cmdCreateSection  (const juce::var& args);
    juce::var cmdRenameSection  (const juce::var& args);
    juce::var cmdMoveSection    (const juce::var& args);
    juce::var cmdRemoveSection  (const juce::var& args);
    // LYR-001 — Finish-My-Song lyric sheet (MOSH_LYRICSHEET on a track; undoable).
    juce::var cmdCreateLyricSheet  (const juce::var& args);
    juce::var cmdRemoveLyricSheet  (const juce::var& args);
    juce::var cmdSetLyricConstraint (const juce::var& args);
    juce::var cmdSetLyricLine       (const juce::var& args);
    juce::var cmdRemoveLyricLine    (const juce::var& args);
    juce::var cmdGetRhymes          (const juce::var& args);  // phonology read (service); not undoable
    // LYR-L2 — generation loop (propose→validate→retry→rank; service, not undoable),
    // proposals land on the line as a transient JSON blob → snapshot.
    juce::var cmdCompleteLyrics     (const juce::var& args);
    juce::var cmdFillLyricGap       (const juce::var& args);
    juce::var cmdSuggestNextLine    (const juce::var& args);
    juce::var cmdRegenerateLyric    (const juce::var& args);
    juce::var cmdCancelLyricJob     (const juce::var& args);
    juce::var cmdAcceptLyricProposal (const juce::var& args);  // undoable (commits chosen text) + taste label
    juce::var cmdAssertLyricLine     (const juce::var& args);
    juce::var cmdRejectLyricProposal (const juce::var& args);  // clears proposals + taste label
    // LYR-L1 — precise per-line phonology (service; not undoable), analysis lands on the
    // line as a transient JSON blob → snapshot → the flow visualizer.
    juce::var cmdAnalyzeLyrics       (const juce::var& args);
    // §7 — read-only corpus size for the "it's learning my voice" cue (non-undoable,
    // non-agent, NON-SPAWNING; counts only — the backend-only safety wall).
    juce::var cmdGetLyricCorpusStats (const juce::var& args);
    // LYR Phase 3 — audio "mumble take": right-click a vocal take → Basic Pitch (rhythm) +
    // Whisper (confidence-gated words) → a lyric sheet on the clip's track. Clip-scoped,
    // service-spawning, async on the snapshot rail (mirrors cmdTranscribeClip). UI-only.
    juce::var cmdBuildLyricsFromClip (const juce::var& args);
    // LYR Phase 2 — audio "mumble take" (gibberish): right-click a hummed take → Basic Pitch
    // (+ optional FCPE F0) → an editable WORDLESS skeleton (syllable grid + stress; lines land
    // `proposed`). Clip-scoped, service-spawning, async (mirrors cmdBuildLyricsFromClip). UI-only.
    juce::var cmdBuildSkeletonFromClip (const juce::var& args);
    // LYR Phase 2 — confirm the proposed flow grid → flips each line `proposed`→`seed` so it's
    // eligible for generation (the human-in-the-loop gate). Undoable; Track-scoped; agent-callable.
    juce::var cmdConfirmSkeleton     (const juce::var& args);
    // AGT-MEM (Phase-B memory lane, M1) — the native agent-memory store. Pure file I/O
    // (src/moshops/AgentMemoryStore.h) — no ValueTree/Edit mutation, no snapshot
    // change, no undo transaction. Writes are logged (JSONL); reads are NOT (mirrors
    // cmdGetLyricCorpusStats/cmdGetRhymes — read-only commands simply skip logLine).
    juce::var cmdAgentMemoryWrite (const juce::var& args);
    juce::var cmdAgentMemoryRead  (const juce::var& args);
    // AGT-MEM (M3) — the memory drawer's per-item delete + per-tier clear. Mutations
    // (logged, undoable:false — same posture as the write above).
    juce::var cmdAgentMemoryDelete (const juce::var& args);
    juce::var cmdAgentMemoryClear  (const juce::var& args);
    // ANN-001 — authored timeline annotations (MOSH_ANNOTATIONS tree; undoable +
    // multiplayer-broadcast). create self-broadcasts its resolved cross-peer id.
    juce::var cmdCreateAnnotation (const juce::var& args);
    juce::var cmdEditAnnotation   (const juce::var& args);
    juce::var cmdMoveAnnotation   (const juce::var& args);
    juce::var cmdRemoveAnnotation (const juce::var& args);
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
    juce::var cmdMpSendSignal   (const juce::var& args);   // WebRTC video signaling passthrough
    // P6 bootstrap — serialize the WHOLE project (all tracks) for a late-joiner,
    // and adopt a received bundle (clear local tracks, rebuild from the bundle).
    juce::var cmdMpSerializeProject (const juce::var& args);
    juce::var cmdMpApplyBootstrap   (const juce::var& args);
    // PR-2 — shared content-addressing/serialize body (no upload) for the whole
    // project; cmdMpSerializeProject uploads synchronously right after (kept
    // behavior-compatible with direct-call tests), serializeProjectForBootstrapAnswer
    // does not (the live-session bootstrap-answer path's transfer worker uploads
    // instead — see MultiplayerSession::pollLoop's "bootstrap_request" handling).
    juce::var contentAddressWholeProjectNoUpload();
    juce::var serializeProjectForBootstrapAnswer();
    // Snapshot the directory stem transfers resolve `audio/by-hash/` under into
    // mpSession_ (PR-2) — call whenever eng.editFile() can change (construction,
    // new_project/open_project/save_as) or a session starts/joins.
    void refreshMpStemDir();
    // P4 self-heal (PR-1) — every uploadBlob/downloadBlob result above is ignored at
    // its call site, so a single transient HTTP failure otherwise strands a clip's
    // audio `sourceMissing` forever (the only prior recovery was the host re-committing
    // that track). This re-derives the missing hash/ext from a wave clip's own by-hash
    // source ref and retries the download for every clip currently missing its audio.
    // Backend-only (Unguarded), non-undoable (writes bytes to disk only, no ValueTree
    // mutation). `wait:true` runs synchronously (harness/agents/the bootstrap auto-
    // trigger's callers don't need this); otherwise async (mirrors cmdTranscribeClip).
    juce::var cmdMpFetchMissingStems (const juce::var& args);
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
    // FS-B2a — the agent batch-TRANSACTION contract (docs/first-stranger-program/lanes/
    // fs-b2.md). batch_status is the authoritative read after any ambiguous outcome;
    // batch_rollback is the ONLY automatic skill rollback (never a generic undo).
    juce::var cmdBatchStatus    (const juce::var& args);
    juce::var cmdBatchRollback  (const juce::var& args);
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
    // G4b — clip fades (fade-in/fade-out + curve type). Audio-clip-only, mirrors
    // cmdSetClipGain; fades render NATIVELY through AudioClipBase (no src/state change).
    juce::var cmdSetClipFade    (const juce::var& args);
    // clip-ops wave — reverse / auto-crossfade (audio-clip-only, mirror cmdSetClipGain's
    // shape) + a non-destructive gain-to-peak normalize (wave-only, reuses the
    // get_clip_peaks reader path).
    juce::var cmdSetClipReverse   (const juce::var& args);
    juce::var cmdSetClipCrossfade (const juce::var& args);
    juce::var cmdNormalizeClip    (const juce::var& args);
    // CLP-LOOP — clip loop region (reality-pack invariant 28). Audio-clip-only, mirrors
    // cmdSetClipGain's shape; drives te::AudioClipBase::setLoopRange (the same loop state
    // isLooping()/getLoopStart()/getLoopLength() — and clipAudibleSourceSpan — already read).
    juce::var cmdSetClipLoop      (const juce::var& args);
    juce::var cmdRelinkClip     (const juce::var& args);   // gap 3 — re-point a missing wave source
    // Audio warp — auto-tempo: the clip re-anchors in BEATS and time-stretches to
    // follow the tempo map (SoundTouch; warp MARKERS are a deferred subsystem).
    juce::var cmdSetClipWarp    (const juce::var& args);
    // Warp helpers that make auto-tempo feel like Ableton: stretch a wave clip to a
    // target warped length (or N bars) by deriving sourceBpm; and detect the source
    // loop BPM offline (read-only) so enabling warp can lock a loop to the grid.
    juce::var cmdStretchClip    (const juce::var& args);
    juce::var cmdDetectClipBpm  (const juce::var& args);
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
    juce::var cmdMarkTake       (const juce::var& args);
    juce::var cmdSetMasterVolume (const juce::var& args);
    juce::var cmdSetMasterPan    (const juce::var& args);
    // Master-bus plugins — hosts plugins (limiter, bus EQ, …) on the master output via
    // getMasterPluginList(), mirroring the per-track plugin commands below one level up
    // (no trackId — the master bus is the session's one mix bus, same posture as
    // set_master_volume/set_master_pan above).
    juce::var cmdLoadMasterPlugin      (const juce::var& args);
    juce::var cmdLoadMasterBuiltin     (const juce::var& args);
    juce::var cmdRemoveMasterPlugin    (const juce::var& args);
    juce::var cmdReorderMasterPlugin   (const juce::var& args);
    juce::var cmdSetMasterPluginParam  (const juce::var& args);
    juce::var cmdBypassMasterPlugin    (const juce::var& args);
    juce::var cmdOpenMasterPluginEditor (const juce::var& args);
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
    // G10 — automation RECORDING (v0). set_track_automation_mode arms/disarms a track's
    // record mode (all 4 values stored; only "write" is behavioral, see the design doc);
    // write_automation_curve is a composite bulk-authoring command (DRM-002-style: validate
    // the WHOLE point array before mutating, one undoable transaction).
    juce::var cmdSetTrackAutomationMode (const juce::var& args);
    juce::var cmdWriteAutomationCurve   (const juce::var& args);
    juce::var cmdOpenPluginEditor (const juce::var& args);
    juce::var cmdAddMidiClip    (const juce::var& args);
    juce::var cmdAddDrumPattern (const juce::var& args);  // DRM-002: whole grid, one command
    juce::var cmdTranscribeClip (const juce::var& args);  // audio->MIDI (Basic Pitch)
    juce::var cmdSketchBeatbox  (const juce::var& args);  // Sketch P0: beatbox->drum MoshOps
    juce::var cmdGenerateBeatRecipe (const juce::var& args);
    juce::var cmdAddNote        (const juce::var& args);
    juce::var cmdRemoveNote     (const juce::var& args);
    juce::var cmdSetNote        (const juce::var& args);
    juce::var cmdQuantizeNotes  (const juce::var& args);
    // Stage 5 — Tier-B generative layer (RenderLayer flow)
    juce::var cmdCreateRenderLayer (const juce::var& args);
    juce::var cmdSetRenderParam   (const juce::var& args);
    juce::var cmdRenderLayer      (const juce::var& args);
    juce::var cmdCompileRender     (const juce::var& args);  // loose instruction → validated render envelope (generative-only v1)
    // Render a single clip's instrument output (its track, over [startSec,endSec]) to a
    // WAV — the auto-bounce that lets generative render layers run on MIDI/drum clips
    // (the model is audio→audio). Offline, synchronous, mirrors cmdExportAudio's render.
    bool bounceClipToWav (te::Clip& clip, double startSec, double endSec, const juce::File& destWav);
    juce::var cmdCancelRender     (const juce::var& args);
    juce::var cmdAcceptRender     (const juce::var& args);
    juce::var cmdRejectRender     (const juce::var& args);
    juce::var cmdResetRenderLayer (const juce::var& args);   // wave clips: restore the pre-render source (undo the in-place apply)
    juce::var cmdBypassLayer      (const juce::var& args);
    juce::var cmdFreezeLayer      (const juce::var& args);
    juce::var cmdUnfreezeLayer    (const juce::var& args);
    juce::var cmdBounceLayerToClip(const juce::var& args);
    juce::var cmdRemoveRenderLayer(const juce::var& args);
    juce::var cmdListColors       (const juce::var& args);
    juce::var cmdListLoras        (const juce::var& args);
    juce::var cmdListTransformTargets (const juce::var& args);   // Route B discovery
    juce::var cmdListRaveModels   (const juce::var& args);       // Lane B — RAVE model browser (non-gated fs scan)
   #if MOSH_HAVE_ANIRA
    // Route C.2 — real-time RAVE insert (built only with anira+LibTorch).
    juce::var cmdAddRaveInsert    (const juce::var& args);
    juce::var cmdSetRaveParam     (const juce::var& args);
    juce::var cmdLoadRaveModel    (const juce::var& args);
    juce::var cmdResetRave        (const juce::var& args);
   #endif
    // Stage 6 — consolidation
    juce::var cmdExportAudio      (const juce::var& args);
    // G7 — per-track stem export, one file per visible/non-empty audio track, all
    // sharing the SAME {0, editLength} render window (the "common zero point": every
    // stem is the same length and re-imports aligned). Mirrors cmdExportAudio's
    // resolution/render machinery but loops tracks like bounceClipToWav. NON-undoable
    // read/render (no ValueTree mutation besides the harmless logicalid backfill
    // already used all over the snapshot path).
    juce::var cmdExportStems      (const juce::var& args);
    // cmdExportStems helper: a genuinely clip-less track (includeEmpty:true) can't be
    // expressed via Renderer::Parameters::allowedClips (an EMPTY array means "no filter",
    // i.e. ALL clips — there is no way to ask the renderer for "zero clips"). So a stem for
    // such a track is written directly as digital silence at the common-zero-point length,
    // bypassing te::Renderer entirely. See the comment in cmdExportStems for the full story.
    bool writeSilentStemFile (const juce::File& dest, juce::AudioFormat* format, int bitDepth,
                              double sampleRate, double lengthSeconds);
    // Wave: settings — audio device picker + project lifecycle (both NON-undoable)
    juce::var cmdListAudioDevices (const juce::var& args);   // read-only (no log/transaction)
    juce::var cmdListMidiInputs   (const juce::var& args);   // read-only MIDI-input enumeration (CTL-001)
    juce::var cmdGetCommandLog    (const juce::var& args);   // read-only (reads mosh-log.jsonl; NOT logged)
    void invalidateCommandLogCache();
    void refreshCommandLogCacheIfNeeded (const juce::File& file);
    juce::var cmdSetAudioDevice   (const juce::var& args);   // machine preference (undoable:false)
    juce::var cmdRetryAudioDevice (const juce::var& args);   // AUD-017 recovery (undoable:false)
    juce::var cmdSetBufferSize    (const juce::var& args);   // thin wrapper over set_audio_device
    juce::var cmdSetAudioThreads  (const juce::var& args);   // PRF-001 multicore pref (undoable:false)
    juce::var cmdListDirectory    (const juce::var& args);   // BRW-001 read-only file browse (no log/transaction)
    juce::var cmdAuditionFile     (const juce::var& args);   // standalone file preview (transient, no undo/log)
    juce::var cmdStopAudition     (const juce::var& args);
    juce::var cmdNewProject       (const juce::var& args);   // replaces the Edit (undoable:false)
    juce::var cmdOpenProject      (const juce::var& args);   // replaces the Edit (undoable:false)
    juce::var cmdOpenRecent       (const juce::var& args);   // open by recent-list index (undoable:false)
    // Shared Edit-swap body for open_project / open_recent (one mutation path). Caller
    // pre-validates the file exists; commandName tags the log + result envelope.
    juce::var openProjectFile     (const juce::File& file, const juce::var& args, const char* commandName);
    juce::var cmdSaveAs           (const juce::var& args);   // persists + re-points (undoable:false)
    // PRJ-008 — per-project format / time-base intent (undoable:false preference,
    // stored on a MOSH_PROJECT child of the Edit tree; saves/reloads with the edit).
    juce::var cmdSetProjectSettings (const juce::var& args);
    // KEY-001 — the project's musical key (tonic + mode), same MOSH_PROJECT node as
    // the format intent. NON-undoable preference (cmdSetProjectSettings template);
    // validated against the voice.js NOTE_PC/SCALES domains; feeds the snapshot
    // (session.project.key) + the RenderLayer fingerprint (a key change = cache MISS).
    juce::var cmdSetKey (const juce::var& args);
    // G2b — count-in / pre-roll bars before recording, same MOSH_PROJECT node +
    // NON-undoable-preference template as cmdSetKey. Domain {0,1,2} validated by
    // mosh::countin::isValidBars (state/CountIn.h); applyCountInToEdit() syncs the
    // live Edit's real tracktion_engine pre-roll (te::Edit::setCountInMode) so the
    // setting is ENGINE-WIRED, not just stored.
    juce::var cmdSetCountIn (const juce::var& args);
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
    // G2b — re-applies the stored countInBars preference to the LIVE Edit's real
    // tracktion_engine pre-roll (te::Edit::setCountInMode). Called from
    // cmdSetCountIn (immediate effect) and from cmdSetTransport's "record" branch
    // (so recording always honors the CURRENT project setting even across a
    // save/reload that swapped in a different Edit instance). Cheap + headless-safe
    // (writes engine property storage, no audio device required).
    void applyCountInToEdit();

    // SEC-001 — the MOSH_SECTIONS container as a snapshot array (read-only; never
    // creates the tree). Each entry: { id, name, startBeat, endBeat, color? }.
    juce::var sectionsToVar();
    juce::var annotationsToVar();

    // LYR-001 — a track's MOSH_LYRICSHEET as a snapshot object (read-only; never
    // creates the tree). { id, grid, language, topic, mood, explicit, rhymeStrictness,
    // specVersion, lines:[{ index, role, seedText, text, syllableTarget, syllableTol,
    // stress, rhymeGroup, rhymeStrictness, locked, sectionId, status }] }, or a null
    // var when the track has no sheet.
    juce::var lyricSheetToVar (te::AudioTrack& t);
    // LYR-L2 — the constraint spec (§5) the generation service consumes, built from a
    // track's sheet (sheet-level + per-line fields + a {index:regen} object).
    juce::var lyricSpecForTrack (te::AudioTrack& t);
    juce::var lyricRegenForTrack (te::AudioTrack& t);
    // Shared body for complete/fill/next/regenerate — builds the spec, runs the service
    // (inline for wait:true, else off-thread + callAsync), lands proposals as a JSON blob
    // on each line node, emits snapshot_invalidated. `epoch` guards a cancelled async land.
    juce::var runLyricGeneration (const juce::String& cmdName, const juce::String& mode,
                                  const juce::String& trackId, int lineIndex, int afterIndex,
                                  const juce::var& args);
    int lyricGenEpoch_ = 0;  // bumped by cancel_lyric_job; a stale async land is skipped
    int compileEpoch_  = 0;  // compile_render: a superseding compile skips an earlier stale async land

    // KEY-001 — the default musical key surfaced in the snapshot before any set_key
    // (A/minor — matches the voice's neutral A4 tonic + SCALES.minor in voice.js).
    static const char* const kDefaultKeyTonic;
    static const char* const kDefaultKeyMode;

    juce::ValueTree findRenderLayer (const juce::String& clipId);
    // upstreamOverride: when non-empty, use it as the upstream hash instead of MD5(inputWav).
    // Wave clips hash their staged audio; MIDI/drum clips pass a stable source signature
    // (notes + instrument/FX state) since their bounced audio isn't bit-deterministic.
    juce::String    computeFingerprint (const juce::ValueTree& node, const juce::File& inputWav,
                                        const juce::String& upstreamOverride = {},
                                        const juce::String& lorasKey = {});
    // LoRA rack → fingerprint key ("name=value@sha12:trigger;"), resolved at render
    // time via /loras for the sa3 adapter (name=value only otherwise). false + err on
    // an unknown LoRA name.
    bool            resolveLorasKey (const juce::ValueTree& node, juce::String& lorasKey,
                                     juce::String& err);
    void            finalizeRender (const juce::String& clipId, const juce::File& outputWav,
                                    const juce::File& manifestFile, const juce::String& cacheKey,
                                    const juce::String& serviceError = {}, int expectedEpoch = -1);
    // P5 — boundary-quantized swap: a render finishing while the playhead is INSIDE the
    // target clip defers its swap to the next musical boundary (loop wrap when looping,
    // else next bar) so the change lands "when the loop comes around", never mid-phrase.
    // Headless / stopped transport / sing land instantly (hermetic in selftest).
    struct PendingSwap
    {
        juce::File outputWav, manifestFile;
        juce::String cacheKey;
        int expectedEpoch = -1;
        double boundarySec = 0.0;   // land when the playhead reaches/wraps past this
        double armedPosSec = 0.0;   // last observed position (wrap detection)
    };
    struct SwapTimer : juce::Timer
    {
        explicit SwapTimer (MoshOps& o) : ops (o) {}
        void timerCallback() override { ops.pollPendingSwaps(); }
        MoshOps& ops;
    };
    std::map<juce::String, PendingSwap> pendingSwaps;   // clipId → latest finished render
    std::unique_ptr<SwapTimer> swapTimer;
    void            applyFinalizedRender (const juce::String& clipId, const juce::File& outputWav,
                                          const juce::File& manifestFile, const juce::String& cacheKey);
    bool            shouldDeferSwap (const juce::String& clipId, double& boundarySec, double& posSec);
    void            pollPendingSwaps();

    // Phase 3 — reactive auto-re-render. reactiveTouch(clipId) bumps the layer's reactiveEpoch and
    // (debounced) fires a background re-render when an applied render is live (wave in-place or MIDI
    // beneath) and reactive is enabled; reactiveTouchTrack re-touches every applied clip on a track
    // (an instrument/FX edit changes a MIDI bounce). Message-thread only.
    void            reactiveTouch (const juce::String& clipId);
    void            reactiveTouchTrack (const juce::String& trackId);
    void            reactiveFire (const juce::String& clipId);
    // Per-clip debounce timers (juce::Timer holds a LambdaTimer defined in the .cpp).
    std::map<juce::String, std::unique_ptr<juce::Timer>> reactiveTimers;
    // Auto-apply a completed render to a WAVE clip in place (the clip's own audio/waveform
    // becomes the render artifact — instant preview). Stores the original source once so
    // reset_render_layer can restore it. Returns false for non-wave clips / missing artifact
    // (caller falls back to the legacy lane-landing path). Message-thread only; undoable txn.
    bool            applyRenderInPlace (const juce::String& clipId, juce::ValueTree node,
                                        const juce::File& artifact, const juce::String& cacheKey);
    // Phase 2 — auto-apply a completed render BENEATH a MIDI/drum clip: land a hidden, full-span
    // looping audio clip on the SAME track and MUTE the source MIDI, so the producer hears the
    // re-imagined audio in place while the editable MIDI stays beneath. A re-render HOT-SWAPS the
    // hidden clip's source (no structural churn). Returns false for wave clips / sub-region renders
    // / missing artifact (caller falls back to applyRenderInPlace or the legacy lane). Message-thread
    // only; the first apply is one undoable txn (undo == reset_render_layer).
    bool            applyRenderBeneathMidi (const juce::String& clipId, juce::ValueTree node,
                                            const juce::File& artifact, const juce::String& cacheKey);

    // ── Lane A — render-ahead ("Live") ───────────────────────────────────────────
    // Transport-driven progressive re-imagine. While a Live-armed WAVE clip plays, render the clip
    // in windows FROM the playhead forward, incrementally stitch the completed windows (service
    // /stitch_windows, 1ms crossfade — owner-tuned), and repoint the clip's source to the growing
    // file: the re-imagined "train track" fills in ahead of the playhead. The stitched file's prefix
    // is byte-stable (appending a window never perturbs earlier seams), so the region the playhead is
    // reading never changes across a repoint — no glitch. A knob change bumps `epoch`, discarding
    // in-flight/stale windows and re-laying from the current playhead forward with the new params.
    // Message-thread only; each window render polls on a background thread and marshals completion
    // back via callAsync. Wave-clip only in v1 (MIDI/drum keep the existing whole-clip beneath path).
    struct RenderAhead
    {
        bool         active = false;         // a clip is armed + the scheduler is live
        juce::String clipId, layerId;
        int          epoch = 0;              // bumped on arm / param-change; a completed window with a stale epoch is dropped
        double       winLen = 8.0;           // per-window seconds (the SA3 single-render window)
        double       clipStart = 0.0, clipEnd = 0.0, srcOffset = 0.0;  // clip position on the timeline + source read offset
        double       lastPlayheadSec = 0.0;  // most recent tick position (drives the current-window + re-lay origin)
        juce::File   sourceFile;             // the PRISTINE original this clip re-imagines from
        juce::File   jobDir;                 // renders/<layerId>/live/
        juce::String adapter;                // "stable_audio3" | "fake" (frozen from the node at arm)
        juce::var    jobParams;              // the render params (prompt/seed/nl/colors/loras/...) rebuilt on each param-change
        int          numWindows = 0;
        int          nextWindow = 0;         // next window index to render
        int          growSeq = 0;            // render_ahead_<n>.wav sequence (a fresh name forces Tracktion to re-open the source)
        bool         rendering = false;      // a window render is in flight (MLX is serial — one at a time)
        bool         originalCaptured = false;
        int          lookahead = 2;          // render up to (current window + lookahead) — bounds wasted work before a likely knob change
        std::vector<juce::File> windows;     // completed window output files, indexed by window number (empty File = not done)
    } renderAhead_;

    juce::var       cmdRenderAheadArm  (const juce::var& args);   // arm/disarm the Live scheduler on a clip (UI "Live" toggle)
    juce::var       cmdRenderAheadTick (const juce::var& args);   // explicit clock tick (a run-script drives a simulated playhead, wait:true renders inline)
    void            renderAheadTick    (double playheadSec);      // advance the scheduler for a playhead position (GUI: async)
    void            renderAheadStartWindow (int k);               // async: submit window k + poll on a bg thread → callAsync placement
    bool            renderAheadSubmitWindow (int k, int epoch, juce::String& jobId, juce::File& outFile, juce::File& manifest);  // stage + submit (shared)
    bool            renderAheadWindowDone  (int k, int epoch, const juce::File& outFile);  // record + re-stitch + repoint (message thread; returns placed?)
    void            renderAheadParamChanged (const juce::String& clipId);  // knob change → re-lay from the current playhead forward
    void            renderAheadDisarm  ();                        // stop the scheduler (the consolidated file stays as the clip's source)
    juce::var       buildRenderAheadParams (const juce::ValueTree& node) const;  // node → single-window render params (fake/SA3)

    // ── helpers ──
    te::AudioTrack* createAudioTrack (const juce::String& name);
    // Phase 2 — the single shared, instrument-free, snapshot-excluded track that holds the drum/MIDI
    // beneath-render audio (a synth on the source track would silence an audio clip there). Created once.
    te::AudioTrack* findOrCreateHiddenRenderTrack();
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
    // G10 — takes the 3 keys explicitly (not the whole `args` var) so every caller reads
    // them inline via args.getProperty(...), matching findPlugin's calling convention —
    // commands.contract.test.ts's handler-body scan only sees getProperty calls literally
    // inside each cmdXxx handler's own source span, not inside a shared helper it calls.
    te::AutomatableParameter* findParam (const juce::String& trackId, int pluginIndex, int paramIndex);
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

    // ── master-bus plugin hosting ── user-facing master-plugin indices address only the
    // VISIBLE prefix of getMasterPluginList(); internal utility plugins (the spectral tap
    // above) are invisible and — since ensureMasterSpectralTap() only ever appends once, at
    // whatever the list's end was when first created — always sit AFTER every visible
    // plugin. masterVisibleBoundary() is that boundary: the physical index of the first
    // internal plugin, or the list's true size if none is present yet. findMasterPlugin()
    // resolves a user-facing index; load/reorder commands clamp inserts inside
    // [0, masterVisibleBoundary()] so a tap created later still taps the FULLY-PROCESSED
    // master signal.
    int              masterVisibleBoundary();
    te::Plugin*      findMasterPlugin (int index);
    void  emitSpectrum (bool playing);                    // drain tap → Goertzel bands → emit
    std::array<float, 1024> spectralRing {};              // rolling mono history
    int   spectralRingPos = 0;
    std::array<float, 12> spectralPrevBands {};           // for spectral flux
    bool  spectrumActive = false;                         // emit one zero on the play→stop edge

    juce::var       pluginToVar (te::Plugin&, int index, te::AudioTrack* owner = nullptr);
    juce::var       trackToVar (te::AudioTrack&, int index);
    juce::var       clipToVar  (te::Clip&);
    juce::var       transportToVar();
    juce::var       controllerToVar();

    void  timerCallback() override;          // decimated playhead/meters (02 §4.2)

    void  emit (const juce::String& type, juce::var payload = {});
    void  emitSnapshotInvalidated();
    // Scoped invalidation: a provably track-local mutation (mixer volume/pan/mute, plugin
    // param) emits snapshot_invalidated carrying JUST that track's var, so the UI patches one
    // track instead of re-pulling the whole snapshot (measured 330 ms / 3.7 MiB at 100 tracks).
    void  emitTrackPatch (te::AudioTrack& track);
    void  logLine (const juce::String& command, const juce::var& args,
                   bool ok, const juce::String& error, bool undoable);
    // TASTE-002 — the in-place workflow's soft POSITIVE: at save/export time, every
    // still-applied (appliedInPlace, not bypassed) render layer logs ONE render_kept
    // JSONL taste label, deduped on layerId for the life of this process.
    void  logKeptRenderLabels();
    juce::StringArray renderKeptLogged_;

    static juce::var okResult  (const juce::String& command, juce::var data = {});
    static juce::var errResult (const juce::String& command, const juce::String& message);

    juce::UndoManager& undoManager() { return eng.edit().getUndoManager(); }

    // Agent "Monster changes": inside a batch (batch_begin..batch_end) every command
    // coalesces into the ONE transaction batch_begin opened, so the whole batch undoes
    // as a single step. Outside a batch this is identical to the old per-command call.
    //
    // FS-B2a: this is also the single chokepoint every mutating command already passes
    // through, so it is where editRevision_ is bumped. A monotonic per-process mutation
    // counter is what lets batch_status report revisionAtBegin/revision and lets commit
    // refuse a transaction whose edit moved in a way the ledger cannot account for.
    void beginTxn (const juce::String& name)
    {
        eng.markDirty();
        ++editRevision_;
        if (! inBatch) undoManager().beginNewTransaction (name);
    }

    /** The JUCE device manager under Tracktion's wrapper that the device picker drives. */
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
    // P4 self-heal (adversarial-review finding #3) in-flight-hash registry: moved to
    // mpSession_->claimStem()/releaseStem() (SHOULD-FIX, PR-2 review) — a MoshOps-
    // local, message-thread-only std::set couldn't see the transfer worker's OWN
    // concurrent prefetch (MultiplayerSession::prefetchAudioRefs, a different OS
    // thread), so the registry now lives on MultiplayerSession itself (thread-safe,
    // mutex-guarded) where both callers can share it. See MultiplayerSession.h.
    juce::int64 seq = 0;
    juce::File  logFile;
    juce::CriticalSection commandLogCacheLock_;
    juce::Array<juce::var> commandLogRecentEntries_;
    juce::int64            commandLogTotal_ = 0;
    juce::int64            commandLogBytes_ = -1;
    juce::String           commandLogPath_;
    bool                   commandLogCachePrimed_ = false;
    // A3 — crash-recovery journal. A dedicated append-only file holding only the REPLAYABLE
    // arrangement commands since the last save (truncated by MoshEngine::save). On an unclean
    // startup MoshOps reads it into pendingRecovery_ (so save-truncation can't race recovery);
    // recover_session replays those with id-rebinding. replayingRecovery_ guards re-journaling.
    juce::File        recoveryJournalFile;
    juce::StringArray pendingRecovery_;
    bool              replayingRecovery_ = false;
    juce::var executeImpl (const juce::var& command);   // the dispatch; execute() wraps + journals
    void  initRecoveryJournal();
    bool  isReplayableCommand (const juce::String& name) const;
    void  appendRecoveryJournal (const juce::String& name, const juce::var& args, const juce::var& result);
    juce::var  substituteRecoveryIds (const juce::var& args, const juce::HashMap<juce::String, juce::String>& idMap);
    juce::var  cmdRecoverSession (const juce::var& args);
    juce::var  cmdDiscardRecovery (const juce::var& args);
    bool        wasPlaying = false;
    bool        inBatch    = false;   // true between batch_begin / batch_end (agent batch = one undo step)

    // ── FS-B2a — the agent batch-transaction contract ────────────────────────────
    // `inBatch` above keeps its EXACT prior meaning (undo coalescing) and is still set
    // and cleared by the internal composites' ownBatch pattern (cmdSketchBeatbox,
    // cmdGenerateBeatRecipe). An open agent transaction implies inBatch; the converse is
    // false — which is precisely why those composites keep working untouched.
    //
    // txn_ holds the MOST RECENT transaction whatever its status (not only an open one),
    // so a lost batch_end/batch_rollback response and a post-commit command retry can
    // both be answered BY ID rather than inferred from a rejected promise.
    std::unique_ptr<agenttxn::Record> txn_;
    // Ids whose last ledger record was non-terminal when this process started: a crash
    // left them unresolved, so every further skill is blocked until T2's recovery proves
    // the pre- or post-transaction state (recover_session / discard_recovery).
    juce::StringArray unresolvedTxnIds_;
    juce::File        txnLedgerFile;
    juce::int64       editRevision_ = 0;   // bumped by beginTxn / cmdUndo / cmdRedo
    int               execDepth_    = 0;   // the guard governs the OUTERMOST execute only
    // Set by txnPreDispatch when it admits a manifested command, consumed by
    // txnPostDispatch to record that command's outcome against its manifest entry.
    int               pendingTxnIndex_ = -1;
    juce::String      pendingTxnEnvelopeDigest_;
    // Fingerprint memo, keyed on editRevision_ — snapshot() is ~330 ms at 100 tracks and a
    // skill run asks for the fingerprint 6–8 times. See txnFingerprint() for why this is
    // sound (and the one invariant it rests on).
    juce::String      txnFingerprintCache_;
    juce::int64       txnFingerprintRevision_ = -1;

    void         initTxnLedger();
    void         appendTxnLedger (const agenttxn::Record&);
    juce::String txnFingerprint();
    juce::var    txnStatusVar (const agenttxn::Record&);
    /** The transaction guard. Returns true when it produced `early` and dispatch must be
        skipped entirely (a refusal, or a replayed result) — no mutation, no journal. */
    bool         txnPreDispatch (const juce::var& command, juce::var& early);
    void         txnPostDispatch (const juce::var& result);
    /** Called by recover_session / discard_recovery: T2's human-gated resolution of a
        crash-interrupted transaction. `provedPostState` = the journal tail was replayed. */
    void         resolveUnresolvedTxns (bool provedPostState);

    double      lastPresenceBroadcastMs = 0.0;

    // FIT-003 — live running-count progress for an in-flight async plugin rescan
    // (cmdRescanPlugins' AU/deep branch). Touched ONLY on the message thread (set
    // right before the detached scan thread is spawned / cleared in its callAsync
    // completion; sampled + emitted from timerCallback()), so no atomics needed —
    // the scan thread itself never reads or writes these. See ScanProgress.h.
    bool        scanSampling_    = false;
    juce::String scanFormat_;
    double      scanStartMs_    = 0.0;
    int         lastScanCount_  = -1;
    double      lastScanEmitMs_ = 0.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshOps)
};

} // namespace mosh
