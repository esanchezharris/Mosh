import { create } from "zustand";
import {
  executeCommand, getSnapshot, onEvent, isNative, notifyUiReady,
  getRemoteStatus, startRemotePairing, stopRemoteCompanion,
} from "./bridge";
import type {
  Snapshot, Transport, MoshEvent, CommandResult, AvailablePlugin,
  BuiltinPlugin, AvailableColor, AvailableTransformTarget, AvailableLora, AvailableRaveModel, RenderQA, Level, AudioDevices, Clip,
  WaveInput, MidiInput, TrackOutputs,
  PluginCounts, ServiceCapabilities,
} from "./types";
import { versionBannerError } from "./types";
import { isTrackPatch, applyTrackPatch } from "./snapshotPatch";
import type { RemoteStatus } from "./bridge";
import { type SnapDiv, snapTimeMap, tempoMapFrom } from "./time";
import type { ChangeSet } from "./agent/executor";
// Collaborator video (redesign). The store routes inbound WebRTC signaling + presence
// changes into the video room; the room couples back to the seam only via mp_send_signal.
import { useVideo } from "./webrtc/useVideo";
import type { SignalMessage } from "./webrtc/signal";
// Schema-driven settings (UI-local, localStorage-backed). The store mirrors a few
// of its values (theme/uiScale/voiceOn/voiceVol) so existing consumers stay reactive
// while the SettingsPanel and these mutators both write through the single source.
import { useSettings } from "./settings/store";
// Which shell is active — the v2 shell also surfaces collaborator video, so the
// webrtc_signal gate must honor it (not just the legacy redesignShell flag).
import { isV2Active } from "./v2/shellFlag";
// AGT-MEM (M3) — drops the cached agent-memory pools on a project switch.
import { invalidateMemoryHydration } from "./agent/memory/hydrate";
// AGT-MEM (M3, item 5) — mirrors every exec() call into the in-session ring buffer
// sessionSummary.ts digests into a project note on the next project switch.
import { recordSessionCommand } from "./agent/memory/sessionLog";
// MP-001 — multiplayer presence + the commit-on-move trigger (pure helpers).
import {
  deriveActiveTrackId, computeSyncActions, pruneOfflineLocks,
  type MpSession, type PeerInfo, type PeerSelection, type PeerPresence,
} from "./multiplayer/sync";

export type Tool = "move" | "split" | "range";
export type View = "arrange" | "mixer";
export type Peaks = [number, number][];
// Live spectral feed (Moshi reactivity), fed by the 30Hz "spectrum" event.
export type Spectrum = { bands: number[]; level: number; flux: number };
// ARR-010 — a UI-local edit time-range [start,end] in seconds. Never a command;
// only delete_time_range sends {start,end} across the bridge when invoked.
export type TimeRange = { start: number; end: number };

type State = {
  snapshot: Snapshot | null;
  connected: boolean;
  lastError: string | null;
  // A2 — UI-local: the crash-recovery notice is dismissed for this session (view state, not
  // a command — the prime directive keeps pure view state off the bridge).
  recoveryDismissed: boolean;
  dismissRecovery: () => void;

  // UI-local view state (NOT commands — the swappable-seam rule: zoom, tool,
  // snap, selection never cross the bridge).
  pxPerSec: number;
  // Piano-roll horizontal zoom, in px per BEAT. Deliberately NOT pxPerSec: the
  // arrangement drives that from a ResizeObserver on every window resize and
  // section-zoom change, so sharing it would yank the MIDI editor's zoom whenever
  // the window moved. Not persisted — a modal editor resetting per session is right.
  pianoRollBeatPx: number;
  setPianoRollBeatPx: (v: number) => void;
  tool: Tool;
  snap: boolean;
  snapDivision: SnapDiv; // musical grid resolution (bar, 1/4, 1/8, …)
  selection: Set<string>;
  peaks: Record<string, Peaks>;
  // The audio source each cached peaks array was fetched for (clipId → sourceFile).
  // Peaks are keyed on it so an in-place repoint (applyRenderInPlace / relink_clip keep
  // the clip id but swap sourceFile) invalidates the stale waveform instead of showing it.
  peaksSourceKey: Record<string, string>;

  // ARR-010 — the active edit time-range (UI-local; set by the Range tool, sent
  // to the backend only via delete_time_range). null when no range is drawn.
  timeRange: TimeRange | null;

  // Stage 3: plugin browser
  selectedTrackId: string | null;
  expandedTracks: Set<string>;            // UI-local: tracks whose inline FX drawer is open
  availablePlugins: AvailablePlugin[];
  availableBuiltins: BuiltinPlugin[];
  pluginCounts: PluginCounts | null;          // per-format catalog counts (INS-005)
  // FIT-003: count/elapsedMs are optional so the older {format,done} shape (still sent
  // by the sync VST3 rescan path and the mock) stays valid — a live async sweep adds a
  // periodic running count + elapsed time, sampled from the backend's real plugin catalog.
  scanProgress: { format: string; done: boolean; count?: number; elapsedMs?: number } | null; // transient rescan state
  browserOpen: boolean;
  renderProgress: Record<string, number>; // clipId → 0..1 (Tier-B render)
  transcribing: Record<string, boolean>;  // source clipId → audio→MIDI in flight (Basic Pitch)
  buildingLyrics: Record<string, boolean>; // source clipId → mumble-take lyric build in flight
  buildingSkeleton: Record<string, boolean>; // source clipId → "Build flow from this take" in flight
  // Sketch Phase 0 — keyed by the SOURCE FILE PATH, not a clipId: sketch_beatbox lands a
  // brand-new drum track+clip, so there is no existing clip to key the in-flight state
  // against (unlike transcribing/buildingLyrics/buildingSkeleton above).
  sketchingBeatbox: Record<string, boolean>;
  availableColors: AvailableColor[];       // SA3 colour rack (from list_colors)
  // Whether THIS Mac's generative service is actually running the real Stable Audio 3
  // model, straight from /colors' `sa3` field (server.py's SA3_ENABLED). undefined means
  // the service didn't report it — an older service, or /colors errored internally — and
  // callers fall back to the colour-rack-nonempty proxy (see ui/src/ui/engineBadge.ts)
  // rather than silently claiming SA3.
  sa3Available: boolean | undefined;
  availableTransformTargets: AvailableTransformTarget[]; // Route B targets (from list_transform_targets)
  availableLoras: AvailableLora[];         // LoRA rack library (from list_loras)
  availableRaveModels: AvailableRaveModel[]; // Lane B — RAVE model library (from list_rave_models)
  transformFreeText: boolean;              // Route B: does the transform tier allow free-text targets
  // Guest-degradation capability summary (from list_transform_targets' piggybacked
  // `capabilities` field — see loadCapabilities below). null until the lazy fetch
  // (first clip-menu/Gen-drawer open — NEVER init(), which must stay service-free)
  // resolves; callers treat null as "assume available" (see capabilities.ts).
  capabilities: ServiceCapabilities | null;
  labMode: boolean;                        // ASTD unlock for generative colours
  qaByClip: Record<string, RenderQA>;      // last render's quality readout
  remoteStatus: RemoteStatus | null;       // iPhone companion server state
  audioDevices: AudioDevices | null;       // full device enumeration (on-demand, lazy)
  waveInputs: WaveInput[] | null;          // RTG-001 input choices (on-demand, lazy)
  midiInputs: MidiInput[] | null;          // CTL-001 MIDI-input choices (on-demand, lazy)
  trackOutputs: TrackOutputs | null;       // RTG-002 output destinations (on-demand, lazy)
  // Live level meters (Wave 9) — fed by the 30Hz "levels" event, NOT the snapshot.
  levels: { tracks: Record<string, Level>; master: Level };

  // Live spectral feed (Moshi reactivity) — fed by the 30Hz "spectrum" event (master
  // Goertzel). bands = per-band energy 0..1 (low→high); level/flux 0..1. Pure telemetry
  // like `levels`; never a command, no audio concepts leak across the seam (just numbers).
  spectrum: Spectrum;

  // Live transport — fed by the 30Hz "transport" event (NOT folded into the
  // snapshot, so a moving playhead never re-creates the snapshot object and the
  // whole tree no longer re-renders 30×/s). Seeded from the snapshot on refresh
  // for the structural fields (recording / loop region).
  transport: Transport;

  // Clip clipboard — pure UI-local view state. The captured clip descriptor only
  // crosses the bridge on paste (paste_clip); copy/cut never touch the backend
  // (swappable-seam rule). v1 holds a single clip; multi-clip copy is optional.
  clipboard: { clip: Clip; sourceTrackId: string } | null;

  // MP-001 — multiplayer presence, fed by the peer_* / mp_state events (off the
  // snapshot, like transport/levels). All UI-local reactions; mutations still flow
  // through commands. Inactive in single-player, so these stay empty/no-op.
  mp: MpSession;
  peers: Record<string, PeerInfo>;                 // peerId -> name/color/online
  peerSelection: Record<string, PeerSelection>;    // peerId -> their current selection
  peerPresence: Record<string, PeerPresence>;
  locksByLogicalId: Record<string, string>;        // logicalId -> ownerPeerId
  activeTrackId: string | null;                    // derived; the commit-on-move trigger
  // PR-2 adversarial-review BLOCKER: mp_commit_done previously had no frontend
  // consumer at all — a failed stem upload (commit-on-move, PR-2's async transfer)
  // was invisible; the track just silently stayed sourceMissing for the peer.
  // Keyed by logicalId (what mp_commit_done carries), not trackId (transient/UI).
  pendingCommits: Record<string, true>;            // logicalId -> mid-upload ("uploading")
  failedCommits: Record<string, string>;           // logicalId -> last error (persists until a retry succeeds)
  retryFailedCommit: (logicalId: string) => Promise<void>;
  mpCreateSession: (name?: string, color?: string) => Promise<void>;
  // Returns the raw result so the join UI can render INLINE failure feedback (#42);
  // the global lastError is still set for surfaces that only watch the error bar.
  mpJoinSession: (code: string, name?: string, color?: string) => Promise<CommandResult>;
  mpLeaveSession: () => Promise<void>;
  syncActiveTrack: () => Promise<void>;            // recompute activeTrack; commit+claim on change

  refresh: () => Promise<void>;
  // FS-B2a — the optional third argument is the agent-transaction envelope. It rides
  // BESIDE command/args (never inside args) all the way to MoshOps::executeImpl, which
  // reads it off the command object; WebBridge passes args[0] whole, so the sibling field
  // survives untouched. Omitted by every existing caller ⇒ behaviour unchanged.
  exec: (
    command: string,
    args?: Record<string, unknown>,
    transaction?: { transactionId: string; requestId: string; index: number },
  ) => Promise<CommandResult>;
  // AGT-MEM (M3) — satisfies menuActions.ts's ActionStore.invalidateMemory: drops
  // the cached agent-memory pools so a project switch never leaks a stale project's
  // notes into the newly-opened one's prompts.
  invalidateMemory: () => void;
  init: () => void;
  refreshRemote: () => Promise<void>;
  startRemotePairing: () => Promise<void>;
  stopRemote: () => Promise<void>;

  setPxPerSec: (v: number) => void;
  setTool: (t: Tool) => void;
  setSnap: (b: boolean) => void;
  setSnapDivision: (d: SnapDiv) => void;
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  snapTime: (t: number) => number;
  ensurePeaks: (clipId: string) => void;

  // ARR-010 — time-range view-state actions (never cross the bridge).
  setTimeRange: (r: TimeRange | null) => void;

  // Clipboard actions (UI-local until paste). copy/cut capture a snapshot clip;
  // paste reconstructs it on the backend via the paste_clip command.
  copySelection: () => void;
  cutSelection: () => Promise<void>;
  pasteClipboard: () => Promise<void>;

  setSelectedTrack: (id: string | null) => void;
  toggleTrackExpanded: (id: string) => void;
  editingClipId: string | null;            // MIDI clip open in the piano-roll
  openPianoRoll: (clipId: string) => void;
  closePianoRoll: () => void;
  automationTrackId: string | null;        // track open in the automation editor
  openAutomation: (trackId: string) => void;
  closeAutomation: () => void;
  feltWrongOpen: boolean;                  // taste loop: the ⌘⇧F capture dialog
  setFeltWrongOpen: (open: boolean) => void;
  openBrowser: () => void;
  closeBrowser: () => void;
  ensurePluginCatalog: () => void;          // lazy-load the plugin list + built-ins (shared by the modal + the v2 drawer)
  // INS-005 — plugin scan / blocklist management (all via exec; UI-local view state otherwise).
  rescanPlugins: (format?: "vst3" | "au" | "all", allowAU?: boolean) => Promise<void>;
  refreshPluginList: () => Promise<void>;
  loadColors: () => void;
  loadTransformTargets: () => void;        // Route B: fetch transform targets (lazy)
  loadLoras: () => void;                   // LoRA rack: fetch the adapter library (lazy)
  loadRaveModels: () => void;              // Lane B: fetch the RAVE model library (lazy)
  loadCapabilities: () => void;            // guest-degradation: fetch lazily on first clip-menu/Gen-drawer open (see capabilities field)
  loadAudioDevices: () => Promise<void>;   // lazy + on-demand (force re-fetch after a device change)
  loadRouting: () => Promise<void>;        // RTG-001/002 — wave inputs + track outputs
  loadMidiInputs: () => Promise<void>;     // CTL-001 — MIDI inputs for the instrument picker
  setLab: (b: boolean) => void;

  view: View;
  setView: (v: View) => void;

  theme: "dark" | "light";
  toggleTheme: () => void;

  // Moshi creature — UI-local signals the character watches (never cross the bridge).
  // celebrateTick is bumped when a render is accepted (his reward moment); the voice
  // settings are UI-local + persisted, exactly like theme/uiScale.
  celebrateTick: number;
  bumpCelebrate: () => void;
  voiceOn: boolean;
  voiceVol: number;
  toggleVoice: () => void;
  // Hands-free always-on listening (UI-local + persisted, exactly like voiceOn). When
  // true, AgentComposer's useHandsFree hook engages the continuous recognizer and
  // command phrases act without holding the mic; the mic is hot only while this is on.
  handsFreeOn: boolean;
  setHandsFree: (b: boolean) => void;
  // Fallback (default off): when true, hands-free listening pauses while a take records
  // (for inputs that can't be shared); off keeps barge-in. UI-local + persisted.
  handsFreePauseOnRecord: boolean;

  // Agent (Moshi running the session) — UI-local. agentChangeSet drives Monster
  // changes; agentUtter signals the creature to react (voice + pose) to a reply.
  agentBusy: boolean;
  agentChangeSet: ChangeSet | null;
  agentUtter: { intent: string; say?: string; tick: number } | null;
  agentListening: boolean;            // hold-to-talk active — Moshi perks toward you
  setAgentBusy: (b: boolean) => void;
  setAgentChangeSet: (cs: ChangeSet | null) => void;
  pushAgentUtter: (intent: string, say?: string) => void;
  setAgentListening: (b: boolean) => void;

  // AGT-MEM (M3) — the "remember that…" fastPath rule's confirm toast. A memory
  // write is non-undoable BY DESIGN (M1) — this toast's Undo therefore calls
  // agent_memory_delete on the just-written item's `ts`, never the real undo
  // command. UI-local (mirrors agentChangeSet's ChangeToast posture, one level down).
  memoryToast: { text: string; scope: "global" | "project"; kind: string; ts: number } | null;
  setMemoryToast: (t: State["memoryToast"]) => void;

  // Performer mode (hands-free voice take recording). `recording` is derived from the
  // live snapshot; `takeDecisionPending` marks "a just-recorded take awaits keep/redo".
  takeDecisionPending: boolean;
  lastTakeClipId: string | null;
  currentMode: () => "idle" | "recording" | "reviewing";
  enterRecord: (bar?: number) => Promise<void>;
  stopRecord: () => Promise<void>;
  keepTake: () => Promise<void>;
  navTake: (delta: number) => Promise<void>;

  // UI scale (ACC-005) — pure UI-local view state (like theme): never a command,
  // never crosses the bridge. Applied via document zoom so the whole WebView reflows.
  uiScale: number;
};

// Serializes overlapping syncActiveTrack() runs (rapid selection changes) so their
// commit/claim/broadcast relay round-trips never interleave — a commit must never
// race ahead of (or behind) its own claim. Each run is chained after the previous;
// `run` is used as both fulfil and reject handler so a failed link can't wedge it.
let mpSyncChain: Promise<void> = Promise.resolve();

export const useStore = create<State>((set, get) => ({
  snapshot: null,
  connected: isNative(),
  lastError: null,
  recoveryDismissed: false,
  dismissRecovery: () => set({ recoveryDismissed: true }),

  pxPerSec: 80,
  // 42 is load-bearing, not aesthetic: PianoRoll.dragAxes.test.ts and
  // PianoRoll.scaleLock.test.ts both declare BEAT_PX = 42 and compute expected beat
  // deltas from it. Changing the default is a deliberate change to those fixtures.
  pianoRollBeatPx: 42,
  tool: "move",
  snap: true,
  snapDivision: "1/4",
  selection: new Set<string>(),
  peaks: {},
  peaksSourceKey: {},
  timeRange: null,
  selectedTrackId: null,
  expandedTracks: new Set(),
  availablePlugins: [],
  availableBuiltins: [],
  pluginCounts: null,
  scanProgress: null,
  browserOpen: false,
  renderProgress: {},
  transcribing: {},
  buildingLyrics: {},
  buildingSkeleton: {},
  sketchingBeatbox: {},
  availableColors: [],
  sa3Available: undefined,
  availableTransformTargets: [],
  availableLoras: [],
  availableRaveModels: [],
  transformFreeText: true,
  capabilities: null,
  labMode: false,
  qaByClip: {},
  remoteStatus: null,
  audioDevices: null,
  waveInputs: null,
  midiInputs: null,
  trackOutputs: null,
  levels: { tracks: {}, master: { l: -100, r: -100 } },
  spectrum: { bands: [], level: 0, flux: 0 },
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  clipboard: null,
  mp: { active: false, roomCode: null, selfPeer: null, connected: false },
  peers: {},
  peerSelection: {},
  peerPresence: {},
  locksByLogicalId: {},
  activeTrackId: null,
  pendingCommits: {},
  failedCommits: {},

  refresh: async () => {
    if (!isNative()) return;
    try {
      const snap = await getSnapshot<Snapshot>();
      set({ snapshot: snap, connected: true, transport: snap.transport });
      // PRJ-FMT — surface a version banner (file-format refusal or snapshot-schema mismatch).
      const banner = versionBannerError(snap);
      if (banner) set({ lastError: banner });
      // Prune selection / fetch peaks for current clips.
      const ids = new Set(snap.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      set((s) => ({ selection: new Set([...s.selection].filter((id) => ids.has(id))) }));
      // Prune the inline-FX expand set against current tracks (mirror the selection
      // prune) so a removed track's id can't make a later id-reused track open by itself.
      const trackIds = new Set(snap.tracks.map((t) => t.id));
      set((s) => ([...s.expandedTracks].every((id) => trackIds.has(id))
        ? {}
        : { expandedTracks: new Set([...s.expandedTracks].filter((id) => trackIds.has(id))) }));
      // Auto-select a track for the rack if none is selected.
      set((s) => {
        const exists = snap.tracks.some((t) => t.id === s.selectedTrackId);
        return exists ? {} : { selectedTrackId: snap.tracks[0]?.id ?? null };
      });
      // Prune stale render-quality readouts (judge scores). A clip keeps its qa only while its
      // render layer is still a LIVE render; once the layer is removed, reset, or rejected
      // (reverted to "dirty"/"error") the score is dead and must not linger.
      set((s) => {
        if (Object.keys(s.qaByClip).length === 0) return {};
        const live = new Set<string>();
        for (const t of snap.tracks) for (const c of t.clips) {
          const rl = c.renderLayer;
          if (rl && rl.status !== "dirty" && rl.status !== "error") live.add(c.id);
        }
        const stale = Object.keys(s.qaByClip).filter((id) => !live.has(id));
        if (stale.length === 0) return {};
        const qaByClip = { ...s.qaByClip };
        for (const id of stale) delete qaByClip[id];
        return { qaByClip };
      });
      for (const t of snap.tracks) for (const c of t.clips) get().ensurePeaks(c.id);
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  exec: async (command, args = {}, transaction) => {
    const res = await executeCommand<CommandResult>(
      transaction ? { command, args, transaction } : { command, args },
    );
    recordSessionCommand(command, args, res.ok);
    if (!res.ok) set({ lastError: res.error ?? `${command} failed` });
    else {
      // A success clears a stale transient error — but never the persistent version
      // banner (a newer-file refusal / schema mismatch), which refresh() re-derives and
      // which must survive until the underlying condition is gone.
      const snap = get().snapshot;
      const banner = snap ? versionBannerError(snap) : null;
      if (get().lastError !== banner) set({ lastError: banner });
    }
    return res;
  },

  invalidateMemory: () => invalidateMemoryHydration(),

  init: () => {
    onEvent("mosh_event", (raw) => {
      const ev = raw as MoshEvent;
      if (ev.type === "snapshot_invalidated") {
        // Scoped patch: splice one changed track in place, skipping the full O(project) re-pull.
        if (isTrackPatch(ev.payload)) {
          const snap = get().snapshot;
          const patched = snap ? applyTrackPatch(snap, ev.payload) : null;
          if (patched) { set({ snapshot: patched }); return; }
        }
        void get().refresh();   // full invalidation (or a scoped target not in the snapshot → resync)
      } else if (ev.type === "transport") {
        // Targeted set — does NOT touch the snapshot (so the tree doesn't churn).
        set({ transport: ev.payload as Transport });
      } else if (ev.type === "levels") {
        // Targeted set (no snapshot refetch) — same lightweight path as transport.
        const p = ev.payload as { tracks: { id: string; l: number; r: number }[]; master: Level };
        const tracks: Record<string, Level> = {};
        for (const t of p.tracks ?? []) tracks[t.id] = { l: t.l, r: t.r };
        set({ levels: { tracks, master: p.master ?? { l: -100, r: -100 } } });
      } else if (ev.type === "spectrum") {
        // Master Goertzel feed (Moshi reactivity) — targeted set, no snapshot refetch.
        const p = ev.payload as Partial<Spectrum>;
        set({ spectrum: { bands: p.bands ?? [], level: p.level ?? 0, flux: p.flux ?? 0 } });
      } else if (ev.type === "plugin_scan_progress") {
        // INS-005 — async (AU) rescan lifecycle. On done, refresh the catalog list.
        // FIT-003 — the backend now emits periodic samples with a live running `count`
        // + `elapsedMs` (decimated ~2/s) for the whole sweep, not just start/done; both
        // fields are optional so this stays compatible with any older {format,done}-only
        // sender (e.g. a stale mock).
        const p = ev.payload as { format: string; done: boolean; count?: number; elapsedMs?: number };
        if (p.done) {
          set({ scanProgress: null });
          void get().refreshPluginList();
        } else {
          set({ scanProgress: { format: p.format, done: false, count: p.count, elapsedMs: p.elapsedMs } });
        }
      } else if (ev.type === "transcribe_status") {
        // Audio→MIDI status for a SOURCE clip: working | done | error. On done the
        // backend's snapshot_invalidated (from add_midi_clip) reveals the new track.
        const p = ev.payload as { clipId: string; state: string; error?: string };
        set((s) => {
          const next = { ...s.transcribing };
          if (p.state === "working") next[p.clipId] = true;
          else delete next[p.clipId];
          return { transcribing: next };
        });
        if (p.state === "error") set({ lastError: p.error ?? "transcription failed" });
      } else if (ev.type === "build_lyrics_status") {
        // Mumble-take status for a SOURCE clip: working | done | error. On done the
        // backend's snapshot_invalidated reveals the new lyric sheet (Inspector → Lyrics).
        const p = ev.payload as { clipId: string; state: string; error?: string };
        set((s) => {
          const next = { ...s.buildingLyrics };
          if (p.state === "working") next[p.clipId] = true;
          else delete next[p.clipId];
          return { buildingLyrics: next };
        });
        if (p.state === "error") set({ lastError: p.error ?? "could not build lyrics from the take" });
      } else if (ev.type === "skeleton_status") {
        // Mumble→skeleton status for a SOURCE clip: working | done | error. Mirrors
        // build_lyrics_status above — was previously unhandled, so "Build flow from this
        // take" showed no spinner and swallowed its error silently (guest-degradation
        // pass: a venv-less guest Mac hits this constantly). On done the backend's
        // snapshot_invalidated reveals the new lyric sheet (Inspector → Lyrics).
        const p = ev.payload as { clipId: string; state: string; error?: string };
        set((s) => {
          const next = { ...s.buildingSkeleton };
          if (p.state === "working") next[p.clipId] = true;
          else delete next[p.clipId];
          return { buildingSkeleton: next };
        });
        if (p.state === "error") set({ lastError: p.error ?? "could not build a flow from the take" });
      } else if (ev.type === "sketch_status") {
        // Sketch Phase 0 (beatbox → drum) status for a SOURCE FILE PATH: working | done |
        // error. Keyed by file, not clipId — sketch_beatbox lands a brand-new track+clip,
        // so there is no existing clip to key against (mirrors transcribe_status/
        // skeleton_status otherwise). The command is install-gated and does NOT degrade
        // gracefully (service/server.py's /sketch returns a 503 "sketch_unavailable (run
        // service/sketch/setup-sketch.sh)" when the venv is absent) — surface that exact,
        // honest message rather than swallowing it or leaving the UI hung. On done the
        // backend's snapshot_invalidated (from add_midi_clip) reveals the new drum track.
        const p = ev.payload as { file: string; state: string; error?: string };
        set((s) => {
          const next = { ...s.sketchingBeatbox };
          if (p.state === "working") next[p.file] = true;
          else delete next[p.file];
          return { sketchingBeatbox: next };
        });
        if (p.state === "error") set({ lastError: p.error ?? "could not sketch a beat from that take" });
      } else if (ev.type === "layer_render_progress") {
        const p = ev.payload as { clipId: string; progress: number };
        set((s) => ({ renderProgress: { ...s.renderProgress, [p.clipId]: p.progress } }));
      } else if (ev.type === "layer_status") {
        const p = ev.payload as { clipId?: string; qa?: RenderQA; status?: string };
        if (p?.clipId) {
          // A render resolves here (ready / error / cache-hit — anything but the "rendering"
          // submit tick). Clear its progress entry (the leak: it was only ever spread-added)
          // and land the quality readout.
          const terminal = p.status !== "rendering";
          set((s) => {
            const patch: Partial<State> = {};
            if (p.qa) patch.qaByClip = { ...s.qaByClip, [p.clipId!]: p.qa as RenderQA };
            if (terminal && p.clipId! in s.renderProgress) {
              const renderProgress = { ...s.renderProgress };
              delete renderProgress[p.clipId!];
              patch.renderProgress = renderProgress;
            }
            return patch;
          });
        }
        void get().refresh();
      } else if (ev.type === "mp_state") {
        // MP-001 — session + roster + lock table (the native poll loop pushes the
        // relay's {peers, locks} here). Targeted set, no snapshot refetch.
        const p = ev.payload as {
          active: boolean; roomCode?: string | null; selfPeer?: string | null;
          peers?: Record<string, Partial<PeerInfo>>; locks?: Record<string, string>;
        };
        const peers: Record<string, PeerInfo> = {};
        for (const [id, v] of Object.entries(p.peers ?? {}))
          peers[id] = { name: v.name ?? id, color: v.color ?? "#888888", online: v.online ?? true };
        set((s) => {
          const peerPresence: Record<string, PeerPresence> = {};
          if (p.active) {
            for (const [peerId, presence] of Object.entries(s.peerPresence))
              if (peers[peerId]?.online) peerPresence[peerId] = presence;
          }
          return {
            mp: { active: p.active, roomCode: p.roomCode ?? null, selfPeer: p.selfPeer ?? null, connected: p.active },
            peers,
            peerPresence,
            // Drop a lock whose owner has dropped/gone offline so no stale read-only
            // badge survives the owner (defense-in-depth with the relay's lease GC).
            locksByLogicalId: pruneOfflineLocks(p.locks ?? {}, peers, p.selfPeer ?? null),
          };
        });
        // Keep the video room's peer set in lockstep with presence (open links to new
        // collaborators, drop departed ones); tear it down entirely when the session ends.
        if (p.active) useVideo.getState().syncPeers(Object.keys(peers));
        else useVideo.getState().teardown();
      } else if (ev.type === "webrtc_signal") {
        // Inbound SDP/ICE from a peer (relayed point-to-point) → the video room. Video is
        // surfaced by the redesign AND the v2 shells; a shell with no video UI must NOT
        // silently negotiate / hold a peer connection (prime directive: flag-off == unchanged).
        if (Boolean(useSettings.getState().get("redesignShell")) || isV2Active()) {
          const p = ev.payload as { from?: string; payload?: SignalMessage };
          if (p?.from && p.payload) useVideo.getState().onSignal(p.from, p.payload);
        }
      } else if (ev.type === "peer_selection") {
        // The other peer's current track/clip selection (the highlight we draw).
        const p = ev.payload as { peerId: string; trackId?: string | null; clipId?: string | null };
        set((s) => ({
          peerSelection: { ...s.peerSelection, [p.peerId]: { trackId: p.trackId ?? null, clipId: p.clipId ?? null } },
        }));
      } else if (ev.type === "peer_presence") {
        const p = ev.payload as { peerId?: string; position?: number; playing?: boolean; recording?: boolean };
        const peerId = p.peerId;
        if (!peerId) return;
        set((s) => {
          if (peerId === s.mp.selfPeer) return {};
          return {
            peerPresence: {
              ...s.peerPresence,
              [peerId]: {
                position: Number(p.position ?? 0),
                playing: Boolean(p.playing),
                recording: Boolean(p.recording),
                updatedAtMs: Date.now(),
              },
            },
          };
        });
      } else if (ev.type === "mp_commit_done") {
        // PR-2 adversarial-review BLOCKER: previously had NO frontend consumer at all
        // (dropped silently by the lack of an else-if branch here) — a failed stem
        // upload (commit-on-move via syncActiveTrack, or a manual commit) left a
        // track's audio sourceMissing for the peer with no visible signal to the
        // producer that anything went wrong. Surface it: clear the "uploading"
        // marker either way; on failure, keep a "failed — retry" entry (cleared by a
        // later successful commit of the same logicalId, in syncActiveTrack/
        // retryFailedCommit above) AND raise the shared lastError toast + a console
        // warning (belt-and-suspenders — the error bar can be dismissed/missed).
        const p = ev.payload as { logicalId?: string; ok?: boolean; error?: string };
        const lid = p.logicalId;
        if (!lid) return;
        if (p.ok) {
          set((s) => {
            const pendingCommits = { ...s.pendingCommits };
            const failedCommits = { ...s.failedCommits };
            delete pendingCommits[lid];
            delete failedCommits[lid];
            return { pendingCommits, failedCommits };
          });
        } else {
          const message = p.error || "stem upload failed — the peer may not receive this track's audio";
          console.warn("[mp] mp_commit_done: commit failed for", lid, "-", message);
          set((s) => {
            const pendingCommits = { ...s.pendingCommits };
            delete pendingCommits[lid];
            return {
              pendingCommits,
              failedCommits: { ...s.failedCommits, [lid]: message },
              lastError: message,
            };
          });
        }
      }
    });
    // Keep the mirrored settings fields in sync with the schema-driven settings
    // store: the SettingsPanel writes through useSettings, so without this a theme
    // or voice change made in the panel wouldn't reach Topbar/Moshi. Seed once
    // (settings were hydrated from localStorage before render) then subscribe.
    const mirrorSettings = () => {
      const g = useSettings.getState();
      set({
        theme: g.get("theme") as "dark" | "light",
        uiScale: g.get("uiScale") as number,
        voiceOn: g.get("voiceOn") as boolean,
        voiceVol: g.get("voiceVol") as number,
        handsFreeOn: g.get("handsFree") as boolean,
        handsFreePauseOnRecord: g.get("handsFreePauseOnRecord") as boolean,
      });
    };
    mirrorSettings();
    useSettings.subscribe(mirrorSettings);

    void notifyUiReady();
    void get().refresh();
    void get().refreshRemote();
    // Guest-degradation: deliberately NOT fetched here. list_transform_targets' native
    // handler (MoshOps::cmdListTransformTargets) calls jobManager.ensureServiceRunning(),
    // which SYNCHRONOUSLY spawns the Python service and blocks on its /health handshake
    // (WebBridge.cpp's execute_command native binding is not threaded, unlike brain_chat —
    // it resolves the completion inline on the message thread). Firing it from init()
    // would freeze the UI on EVERY launch (~1.3-2s on a healthy Mac, worse under
    // MOSH_ENABLE_SA3=1), invisible to the mock backend used by vitest/e2e since it
    // resolves instantly. loadCapabilities() is instead triggered lazily, at the same
    // first-user-interaction points loadColors/loadTransformTargets already use (see
    // ClipView.tsx's clip-menu mount and Dock.tsx's GenDrawer mount) — matching the
    // existing, accepted cost of opening the generative drawer for the first time.
    // Start the live level meters: insert a post-fader LevelMeterPlugin on every track
    // so the backend begins emitting the 30 Hz `levels` telemetry the meters draw. Once
    // at init only — the command runs a Tracktion transaction, so re-issuing it on every
    // structural change would clutter undo. (Mock returns ok; see bridge.mock.)
    void get().exec("enable_all_meters");
  },

  refreshRemote: async () => {
    if (!isNative()) return;
    const res = await getRemoteStatus();
    if (res.ok && res.data) set({ remoteStatus: res.data });
  },

  startRemotePairing: async () => {
    const res = await startRemotePairing();
    if (res.ok && res.data) set({ remoteStatus: res.data });
    else set({ lastError: res.error ?? "remote pairing failed" });
  },

  stopRemote: async () => {
    const res = await stopRemoteCompanion();
    if (!res.ok) set({ lastError: res.error ?? "remote stop failed" });
    await get().refreshRemote();
  },

  setPxPerSec: (v) => set({ pxPerSec: Math.max(20, Math.min(400, v)) }),
  // 12px/beat ≈ a whole 8-bar loop in view; 160 puts 1/32 notes ~5px apart.
  setPianoRollBeatPx: (v) => set({ pianoRollBeatPx: Math.max(12, Math.min(160, v)) }),
  setTool: (t) => set({ tool: t }),
  setSnap: (b) => set({ snap: b }),
  setSnapDivision: (d) => set({ snapDivision: d }),
  select: (ids, additive = false) => {
    set((s) => {
      const next = new Set(additive ? s.selection : []);
      for (const id of ids) next.add(id);
      return { selection: next };
    });
    void get().syncActiveTrack();
  },
  clearSelection: () => { set({ selection: new Set<string>() }); void get().syncActiveTrack(); },
  setTimeRange: (r) => set({ timeRange: r }),
  snapTime: (t) => {
    const { snap, snapDivision, snapshot } = get();
    if (!snap) return t;
    // SES-001 — snap over the piecewise tempo map (the grid restarts at every
    // tempo/meter change; constant-tempo sessions behave exactly as before).
    return snapTimeMap(tempoMapFrom(snapshot?.session), t, snapDivision);
  },

  ensurePeaks: (clipId) => {
    // Key the cache on the clip's CURRENT source: an in-place repoint (applyRenderInPlace /
    // relink_clip) keeps the id but swaps sourceFile, so a plain "have peaks for this id?"
    // short-circuit would keep drawing the pre-render waveform forever. Re-fetch on mismatch.
    const clip = get().snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const srcKey = clip?.sourceFile ?? "";
    if (get().peaks[clipId] && get().peaksSourceKey[clipId] === srcKey) return;
    void executeCommand<CommandResult<{ peaks: Peaks }>>({
      command: "get_clip_peaks",
      args: { clipId, buckets: 800 },
    }).then((res) => {
      if (res.ok && res.data)
        set((s) => ({
          peaks: { ...s.peaks, [clipId]: res.data!.peaks },
          peaksSourceKey: { ...s.peaksSourceKey, [clipId]: srcKey },
        }));
    });
  },

  // Find the first selected clip + its owning track in the current snapshot.
  copySelection: () => {
    const { snapshot, selection } = get();
    if (!snapshot) return;
    for (const t of snapshot.tracks)
      for (const c of t.clips)
        if (selection.has(c.id)) {
          set({ clipboard: { clip: c, sourceTrackId: t.id } });
          return;
        }
  },

  cutSelection: async () => {
    if (!get().snapshot) return;
    // Cut is a faithful inverse of paste: capture the primary (first-selected) clip,
    // then remove exactly that clip. Multi-clip removal stays on the Delete key — the
    // single-clip clipboard (v1) must not delete more than it can restore.
    get().copySelection();
    const cb = get().clipboard;
    if (!cb) return;
    await get().exec("remove_clip", { clipId: cb.clip.id });
    await get().refresh();
  },

  pasteClipboard: async () => {
    const { clipboard, selectedTrackId } = get();
    if (!clipboard) return;
    await get().exec("paste_clip", {
      trackId: selectedTrackId ?? clipboard.sourceTrackId,
      start: get().transport.position,
      clip: clipboard.clip,
    });
    await get().refresh();
  },

  setSelectedTrack: (id) => { set({ selectedTrackId: id }); void get().syncActiveTrack(); },
  toggleTrackExpanded: (id) => set((s) => {
    const next = new Set(s.expandedTracks);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { expandedTracks: next };
  }),

  // MP-001 — session entry. The native session manager creates/joins the relay
  // room and starts the poll loop (which emits mp_state / commits / peer_selection).
  mpCreateSession: async (name = "", color = "") => {
    const r = await get().exec("mp_create_session", { name, color });
    if (!r.ok) set({ lastError: r.error ?? "create session failed" });
  },
  mpJoinSession: async (code, name = "", color = "") => {
    const r = await get().exec("mp_join_session", { code, name, color });
    if (!r.ok) set({ lastError: r.error ?? "join session failed" });
    return r;
  },
  mpLeaveSession: async () => {
    await get().exec("mp_leave_session");
    set({ mp: { active: false, roomCode: null, selfPeer: null, connected: false },
          peers: {}, peerSelection: {}, peerPresence: {}, locksByLogicalId: {}, activeTrackId: null,
          pendingCommits: {}, failedCommits: {} });
  },

  // PR-2 adversarial-review BLOCKER: re-fire mp_commit_track for a track whose last
  // commit failed (mp_commit_done{ok:false}). Looks up the CURRENT trackId for this
  // logicalId in the live snapshot (the failure is recorded by logicalId, the only
  // thing mp_commit_done carries; trackId is transient/UI). If the track is gone
  // (removed/undone since the failure), just drop the stale entry.
  retryFailedCommit: async (logicalId) => {
    const s = get();
    const track = s.snapshot?.tracks.find((t) => t.logicalId === logicalId);
    if (!track) {
      set((st) => {
        const failedCommits = { ...st.failedCommits };
        delete failedCommits[logicalId];
        return { failedCommits };
      });
      return;
    }
    set((st) => ({ pendingCommits: { ...st.pendingCommits, [logicalId]: true } }));
    await s.exec("mp_commit_track", { trackId: track.id });
    // The eventual mp_commit_done event (ok:true/false) resolves pendingCommits/
    // failedCommits below — no need to duplicate that bookkeeping here.
  },

  // Commit-on-move: when the actively-edited track changes, commit+release the
  // previous track (serialize -> publish) and claim the next, then broadcast our
  // selection. No-op in single-player (mp inactive). Selection is only a hint; the
  // native idle checkpoint backstops a long edit that never moves off a track.
  syncActiveTrack: () => {
    const run = async () => {
      const s = get();
      if (!s.mp.active) return;
      const next = deriveActiveTrackId(s.selection, s.selectedTrackId, s.snapshot);
      const prev = s.activeTrackId;
      if (prev === next) return;
      set({ activeTrackId: next });
      const { release, claim } = computeSyncActions(prev, next);
      if (release) {
        const r = await s.exec("mp_commit_track", { trackId: release });
        // PR-2 adversarial-review BLOCKER: mp_commit_track's own immediate return only
        // reflects the SYNCHRONOUS engine work (content-address/serialize) — the actual
        // upload success/failure lands later via mp_commit_done (exec() above already
        // surfaces a synchronous-call failure via lastError; this only handles the
        // async upload outcome). Mark it "uploading" now so a stale failure from a
        // PRIOR commit of this same track is cleared the moment a new one starts,
        // rather than lingering after it actually succeeds.
        const lid = r.ok ? (r.data as { logicalId?: string } | undefined)?.logicalId : undefined;
        if (lid) {
          set((st) => {
            const failedCommits = { ...st.failedCommits };
            delete failedCommits[lid];
            return { pendingCommits: { ...st.pendingCommits, [lid]: true }, failedCommits };
          });
        }
      }
      if (claim) await s.exec("mp_claim_track", { trackId: claim });
      await s.exec("mp_broadcast_selection", { trackId: next, clipId: [...s.selection][0] ?? null });
    };
    // Chain after the previous run so two rapid selection changes can't interleave
    // their relay calls. Read state at RUN time (inside `run`), so a burst collapses
    // to the latest active track rather than replaying stale intermediates. `run` is
    // both the fulfil AND reject handler, so a failed link self-heals (the next run
    // still fires); the terminal .catch absorbs the LAST link's rejection (exec can
    // reject at the bridge level) so a trailing failure isn't an unhandledrejection.
    mpSyncChain = mpSyncChain.then(run, run);
    void mpSyncChain.catch(() => {});
    return mpSyncChain;
  },
  editingClipId: null,
  openPianoRoll: (clipId) => set({ editingClipId: clipId }),
  closePianoRoll: () => set({ editingClipId: null }),
  feltWrongOpen: false,
  setFeltWrongOpen: (open) => set({ feltWrongOpen: open }),
  automationTrackId: null,
  openAutomation: (trackId) => set({ automationTrackId: trackId }),
  closeAutomation: () => set({ automationTrackId: null }),
  ensurePluginCatalog: () => {
    if (get().availablePlugins.length === 0) void get().refreshPluginList();
    // Built-in palette (instruments + effects shipped inside the engine).
    if (get().availableBuiltins.length === 0)
      void executeCommand<CommandResult<{ plugins: BuiltinPlugin[] }>>({
        command: "list_builtins",
        args: {},
      }).then((res) => {
        if (res.ok && res.data) set({ availableBuiltins: res.data.plugins });
      });
  },
  openBrowser: () => { set({ browserOpen: true }); get().ensurePluginCatalog(); },
  closeBrowser: () => set({ browserOpen: false }),

  // Fetch the scanned catalog + per-format counts (INS-005). Always overwrites —
  // small list, and a rescan can grow/shrink it.
  refreshPluginList: async () => {
    const res = await executeCommand<
      CommandResult<{ plugins: AvailablePlugin[]; counts: PluginCounts }>
    >({ command: "list_plugins", args: {} });
    if (res.ok && res.data)
      set({ availablePlugins: res.data.plugins, pluginCounts: res.data.counts ?? null });
  },

  // INS-005 — re-enumerate the catalog. AU is the slow/risky path (the backend
  // runs it off the message thread); we refresh the list when the scan reports done.
  // AUD-SCAN — `allowAU` is the per-call opt-in the backend requires before it will
  // sweep AudioUnits. Without it the native handler quietly does a VST3-only pass, so
  // every AU on the machine stayed invisible with no error to explain why.
  rescanPlugins: async (format = "all", allowAU = false) => {
    set({ scanProgress: { format, done: false, count: 0, elapsedMs: 0 } });
    const res = await get().exec("rescan_plugins", { format, allowAU });
    // Inline/VST3 rescans return done immediately; AU rescans complete via the
    // 'plugin_scan_progress' event (see init()).
    const status = (res.data as { status?: string } | undefined)?.status;
    if (status !== "scanning") {
      set({ scanProgress: null });
      await get().refreshPluginList();
    }
  },

  loadColors: () => {
    if (get().availableColors.length > 0) return;
    void executeCommand<CommandResult<{ colors: AvailableColor[]; sa3?: boolean }>>({
      command: "list_colors",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.colors) set({ availableColors: res.data.colors, sa3Available: res.data.sa3 });
    });
  },

  loadLoras: () => {
    if (get().availableLoras.length > 0) return;
    void executeCommand<CommandResult<{ loras: AvailableLora[] }>>({
      command: "list_loras",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.loras) set({ availableLoras: res.data.loras });
    });
  },

  loadRaveModels: () => {
    if (get().availableRaveModels.length > 0) return;
    void executeCommand<CommandResult<{ models: AvailableRaveModel[] }>>({
      command: "list_rave_models",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.models) set({ availableRaveModels: res.data.models });
    });
  },

  loadTransformTargets: () => {
    if (get().availableTransformTargets.length > 0) return;
    void executeCommand<CommandResult<{ targets: string[]; freeText: boolean; capabilities?: ServiceCapabilities }>>({
      command: "list_transform_targets",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.targets)
        set({
          availableTransformTargets: res.data.targets.map((name) => ({ name })),
          transformFreeText: res.data.freeText !== false,
        });
      // Whichever caller (this or loadCapabilities) hits the service first lands the
      // capability summary — both read the same GET, so this is a harmless overwrite.
      if (res.ok && res.data?.capabilities) set({ capabilities: res.data.capabilities });
    });
  },

  // Guest-degradation: the frontend has no per-C++ session flag for "is transcribe /
  // skeleton / whisper / phonology / a real RAVE model / a real training backend
  // installed on this Mac" (unlike session.raveAvailable etc., which ARE native
  // session fields) — so it fetches the honest summary directly from the service via
  // the existing list_transform_targets/`capabilities` carrier (see that endpoint's
  // server.py comment).
  //
  // CALLED LAZILY ONLY — never from init(). list_transform_targets' native handler
  // calls jobManager.ensureServiceRunning(), which can synchronously spawn the Python
  // service and block the (unthreaded) execute_command message-thread binding for
  // 1-2+ seconds on a cold start. That's an accepted, pre-existing cost of opening the
  // generative drawer for the first time (loadColors/loadTransformTargets/loadLoras all
  // pay it already) — it must never become a guaranteed launch-time freeze. Trigger
  // points: ClipView.tsx's clip-menu mount (so the AI-menu gating can resolve before a
  // Gen-drawer visit) and Dock.tsx's GenDrawer mount (via loadTransformTargets, which
  // lands the same `capabilities` field). Guarded so a second call once resolved is a
  // no-op.
  loadCapabilities: () => {
    if (get().capabilities !== null) return;
    void executeCommand<CommandResult<{ capabilities?: ServiceCapabilities }>>({
      command: "list_transform_targets",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.capabilities) set({ capabilities: res.data.capabilities });
    });
  },

  // Full device enumeration — fetched on Settings open and re-fetched after a
  // device change (always overwrites; the list is small and selection-dependent).
  loadAudioDevices: async () => {
    if (!isNative()) return;
    const res = await executeCommand<CommandResult<AudioDevices>>({
      command: "list_audio_devices",
      args: {},
    });
    if (res.ok && res.data) set({ audioDevices: res.data });
  },

  loadRouting: async () => {
    if (!isNative()) return;
    const wi = await executeCommand<CommandResult<{ inputs: WaveInput[] }>>({
      command: "list_wave_inputs", args: {},
    });
    if (wi.ok && wi.data) set({ waveInputs: wi.data.inputs });
    const to = await executeCommand<CommandResult<TrackOutputs>>({
      command: "list_track_outputs", args: {},
    });
    if (to.ok && to.data) set({ trackOutputs: to.data });
  },

  // CTL-001 — enumerate live MIDI inputs on demand (the v2 inspector's per-instrument
  // MIDI-input picker fetches this when it mounts). Read-only, like loadRouting.
  loadMidiInputs: async () => {
    if (!isNative()) return;
    const res = await executeCommand<CommandResult<{ inputs: MidiInput[] }>>({
      command: "list_midi_inputs", args: {},
    });
    if (res.ok && res.data) set({ midiInputs: res.data.inputs });
  },
  setLab: (b) => set({ labMode: b }),

  view: "arrange",
  setView: (v) => set({ view: v }),

  // theme / uiScale / voiceOn / voiceVol are now schema-driven settings (see
  // settings/store). These fields MIRROR the settings store (synced in init via a
  // subscription) so the many existing consumers keep their useStore subscriptions;
  // the mutators write THROUGH useSettings, which persists + applies the DOM effect.
  theme: useSettings.getState().get("theme") as "dark" | "light",
  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    useSettings.getState().set("theme", next); // persists + applies data-theme
    set({ theme: next });
  },

  celebrateTick: 0,
  voiceOn: useSettings.getState().get("voiceOn") as boolean,
  voiceVol: useSettings.getState().get("voiceVol") as number,
  bumpCelebrate: () => set((s) => ({ celebrateTick: s.celebrateTick + 1 })),
  toggleVoice: () => {
    const next = !get().voiceOn;
    useSettings.getState().set("voiceOn", next); // persists through the settings store
    set({ voiceOn: next });
  },
  handsFreeOn: useSettings.getState().get("handsFree") as boolean,
  setHandsFree: (b) => {
    useSettings.getState().set("handsFree", b); // persists through the settings store
    set({ handsFreeOn: b });
  },
  handsFreePauseOnRecord: useSettings.getState().get("handsFreePauseOnRecord") as boolean,

  agentBusy: false,
  agentChangeSet: null,
  agentUtter: null,
  agentListening: false,
  setAgentBusy: (b) => set({ agentBusy: b }),
  setAgentChangeSet: (cs) => set({ agentChangeSet: cs }),
  pushAgentUtter: (intent, say) =>
    set((s) => ({ agentUtter: { intent, say, tick: (s.agentUtter?.tick ?? 0) + 1 } })),
  setAgentListening: (b) => set({ agentListening: b }),

  memoryToast: null,
  setMemoryToast: (t) => set({ memoryToast: t }),

  takeDecisionPending: false,
  lastTakeClipId: null,
  currentMode: () => {
    const s = get();
    if (s.transport.recording) return "recording";
    if (s.takeDecisionPending) return "reviewing";
    return "idle";
  },
  enterRecord: async (bar) => {
    const s = get();
    const snap = s.snapshot;
    const trackId = s.selectedTrackId ?? snap?.tracks.find((t) => t.type === "audio")?.id ?? snap?.tracks[0]?.id;
    if (!trackId) { s.pushAgentUtter("HUH", "no track to record into"); return; }
    const arm = await s.exec("arm_track", { trackId, armed: true });
    // No-input / mic-permission UX (G2a): arming fails in two distinct ways —
    // ok:false (a live device rejected the target) OR ok:true with applied:false
    // (the graceful headless/no-device no-op proven by the "no fake clip" conformance
    // invariant). Either way, surface a clear, persistent error and DON'T start a
    // doomed record (which would land nothing and leave the user with no feedback).
    const armApplied = (arm.data as { applied?: boolean } | undefined)?.applied;
    if (!arm.ok || armApplied === false) {
      s.pushAgentUtter("UHOH", "can't — no input");
      set({ lastError: "No audio input available — check your microphone connection and permissions." });
      return;
    }
    set({ lastError: null }); // armed cleanly — clear any stale no-input error
    if (bar && bar > 0 && snap) {
      const tempo = snap.session?.tempo ?? 120;
      const num = snap.session?.timeSigNumerator ?? 4;
      await s.exec("set_transport", { position: (bar - 1) * num * (60 / tempo) });
    }
    await s.exec("set_transport", { action: "record" });
    set({ takeDecisionPending: false });
    await s.refresh();
  },
  stopRecord: async () => {
    const s = get();
    const trackOf = () => get().snapshot?.tracks.find((t) => t.id === get().selectedTrackId);
    const before = new Set((trackOf()?.clips ?? []).map((c) => c.id));
    const res = await s.exec("stop_recording", {});
    await s.refresh();
    const landed = (res.data as { clips?: { id: string }[] } | undefined)?.clips?.[0]?.id;
    const after = trackOf()?.clips ?? [];
    const fresh = after.find((c) => !before.has(c.id))?.id;
    set({ takeDecisionPending: true, lastTakeClipId: landed ?? fresh ?? after[after.length - 1]?.id ?? null });
  },
  keepTake: async () => {
    const s = get();
    if (!s.lastTakeClipId) { s.pushAgentUtter("HUH", "nothing to keep"); return; }
    const res = await s.exec("keep_take", { clipId: s.lastTakeClipId });
    if (!res.ok) { s.pushAgentUtter("UHOH", "can't keep that yet"); return; }
    set({ takeDecisionPending: false, lastTakeClipId: null });
    await s.refresh();
  },
  navTake: async (delta) => {
    const s = get();
    const clipId = s.lastTakeClipId;
    if (!clipId) { s.pushAgentUtter("HUH", "no takes"); return; }
    const clip = s.snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) as
      (Clip & { currentTakeIndex?: number; numTakes?: number }) | undefined;
    const next = Math.max(0, Math.min((clip?.numTakes ?? 1) - 1, (clip?.currentTakeIndex ?? 0) + delta));
    const res = await s.exec("set_current_take", { clipId, takeIndex: next });
    if (!res.ok) { s.pushAgentUtter("UHOH", "no other takes yet"); return; }
    await s.exec("set_transport", { action: "to_start" });
    await s.refresh();
  },

  uiScale: useSettings.getState().get("uiScale") as number,
}));

// Dev-only: expose the store so Playwright e2e can drive state the in-memory mock can't
// reproduce — notably multiplayer presence (no relay in dev). Stripped from prod builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __moshStore?: typeof useStore }).__moshStore = useStore;
}
