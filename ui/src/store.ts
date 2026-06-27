import { create } from "zustand";
import {
  executeCommand, getSnapshot, onEvent, isNative, notifyUiReady,
  getRemoteStatus, startRemotePairing, stopRemoteCompanion,
} from "./bridge";
import type {
  Snapshot, Transport, MoshEvent, CommandResult, AvailablePlugin,
  BuiltinPlugin, AvailableColor, AvailableTransformTarget, RenderQA, Level, AudioDevices, Clip,
  WaveInput, TrackOutputs,
  PluginCounts,
} from "./types";
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
import { markPulse } from "./v2/pulseBus";
// MP-001 — multiplayer presence + the commit-on-move trigger (pure helpers).
import {
  deriveActiveTrackId, computeSyncActions, pruneOfflineLocks,
  type MpSession, type PeerInfo, type PeerSelection,
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

  // UI-local view state (NOT commands — the swappable-seam rule: zoom, tool,
  // snap, selection never cross the bridge).
  pxPerSec: number;
  tool: Tool;
  snap: boolean;
  snapDivision: SnapDiv; // musical grid resolution (bar, 1/4, 1/8, …)
  selection: Set<string>;
  peaks: Record<string, Peaks>;

  // ARR-010 — the active edit time-range (UI-local; set by the Range tool, sent
  // to the backend only via delete_time_range). null when no range is drawn.
  timeRange: TimeRange | null;

  // Stage 3: plugin browser
  selectedTrackId: string | null;
  expandedTracks: Set<string>;            // UI-local: tracks whose inline FX drawer is open
  availablePlugins: AvailablePlugin[];
  availableBuiltins: BuiltinPlugin[];
  pluginCounts: PluginCounts | null;          // per-format catalog counts (INS-005)
  scanProgress: { format: string; done: boolean } | null; // transient rescan state
  browserOpen: boolean;
  renderProgress: Record<string, number>; // clipId → 0..1 (Tier-B render)
  transcribing: Record<string, boolean>;  // source clipId → audio→MIDI in flight (Basic Pitch)
  availableColors: AvailableColor[];       // SA3 colour rack (from list_colors)
  availableTransformTargets: AvailableTransformTarget[]; // Route B targets (from list_transform_targets)
  transformFreeText: boolean;              // Route B: does the transform tier allow free-text targets
  labMode: boolean;                        // ASTD unlock for generative colours
  qaByClip: Record<string, RenderQA>;      // last render's quality readout
  remoteStatus: RemoteStatus | null;       // iPhone companion server state
  audioDevices: AudioDevices | null;       // full device enumeration (on-demand, lazy)
  waveInputs: WaveInput[] | null;          // RTG-001 input choices (on-demand, lazy)
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
  locksByLogicalId: Record<string, string>;        // logicalId -> ownerPeerId
  activeTrackId: string | null;                    // derived; the commit-on-move trigger
  mpCreateSession: (name?: string, color?: string) => Promise<void>;
  mpJoinSession: (code: string, name?: string, color?: string) => Promise<void>;
  mpLeaveSession: () => Promise<void>;
  syncActiveTrack: () => Promise<void>;            // recompute activeTrack; commit+claim on change

  refresh: () => Promise<void>;
  exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
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
  openBrowser: () => void;
  closeBrowser: () => void;
  // INS-005 — plugin scan / blocklist management (all via exec; UI-local view state otherwise).
  rescanPlugins: (format?: "vst3" | "au" | "all") => Promise<void>;
  refreshPluginList: () => Promise<void>;
  loadColors: () => void;
  loadTransformTargets: () => void;        // Route B: fetch transform targets (lazy)
  loadAudioDevices: () => Promise<void>;   // lazy + on-demand (force re-fetch after a device change)
  loadRouting: () => Promise<void>;        // RTG-001/002 — wave inputs + track outputs
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

// Which track(s) a command's args refer to, for the v2 edit-pulse: a direct trackId,
// and/or the track that owns a referenced clipId. Tolerant of missing args / null
// snapshot; returns [] for app/transport-level commands that touch no track.
function pulseTargets(args: Record<string, unknown>, snapshot: Snapshot | null): string[] {
  const ids = new Set<string>();
  if (typeof args.trackId === "string") ids.add(args.trackId);
  if (typeof args.clipId === "string" && snapshot) {
    for (const t of snapshot.tracks)
      if (t.clips.some((c) => c.id === args.clipId)) { ids.add(t.id); break; }
  }
  return [...ids];
}

export const useStore = create<State>((set, get) => ({
  snapshot: null,
  connected: isNative(),
  lastError: null,

  pxPerSec: 80,
  tool: "move",
  snap: true,
  snapDivision: "1/4",
  selection: new Set<string>(),
  peaks: {},
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
  availableColors: [],
  availableTransformTargets: [],
  transformFreeText: true,
  labMode: false,
  qaByClip: {},
  remoteStatus: null,
  audioDevices: null,
  waveInputs: null,
  trackOutputs: null,
  levels: { tracks: {}, master: { l: -100, r: -100 } },
  spectrum: { bands: [], level: 0, flux: 0 },
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  clipboard: null,
  mp: { active: false, roomCode: null, selfPeer: null, connected: false },
  peers: {},
  peerSelection: {},
  locksByLogicalId: {},
  activeTrackId: null,

  refresh: async () => {
    if (!isNative()) return;
    try {
      const snap = await getSnapshot<Snapshot>();
      set({ snapshot: snap, connected: true, transport: snap.transport });
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
      for (const t of snap.tracks) for (const c of t.clips) get().ensurePeaks(c.id);
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  exec: async (command, args = {}) => {
    const res = await executeCommand<CommandResult>({ command, args });
    if (!res.ok) set({ lastError: res.error ?? `${command} failed` });
    // Edit-pulse (v2): flash the lane(s) a successful command touched, so the shell
    // reacts to structural edits the way Moshi reacts to sound. Imperative + cheap
    // (no React state); gated to v2 so the classic shell pays nothing.
    else if (isV2Active()) for (const id of pulseTargets(args, get().snapshot)) markPulse(id);
    return res;
  },

  init: () => {
    onEvent("mosh_event", (raw) => {
      const ev = raw as MoshEvent;
      if (ev.type === "snapshot_invalidated") {
        void get().refresh();
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
        const p = ev.payload as { format: string; done: boolean };
        if (p.done) {
          set({ scanProgress: null });
          void get().refreshPluginList();
        } else {
          set({ scanProgress: { format: p.format, done: false } });
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
      } else if (ev.type === "layer_render_progress") {
        const p = ev.payload as { clipId: string; progress: number };
        set((s) => ({ renderProgress: { ...s.renderProgress, [p.clipId]: p.progress } }));
      } else if (ev.type === "layer_status") {
        const p = ev.payload as { clipId?: string; qa?: RenderQA };
        if (p?.clipId && p.qa)
          set((s) => ({ qaByClip: { ...s.qaByClip, [p.clipId!]: p.qa as RenderQA } }));
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
        set({
          mp: { active: p.active, roomCode: p.roomCode ?? null, selfPeer: p.selfPeer ?? null, connected: p.active },
          peers,
          // Drop a lock whose owner has dropped/gone offline so no stale read-only
          // badge survives the owner (defense-in-depth with the relay's lease GC).
          locksByLogicalId: pruneOfflineLocks(p.locks ?? {}, peers, p.selfPeer ?? null),
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
    if (get().peaks[clipId]) return;
    void executeCommand<CommandResult<{ peaks: Peaks }>>({
      command: "get_clip_peaks",
      args: { clipId, buckets: 800 },
    }).then((res) => {
      if (res.ok && res.data)
        set((s) => ({ peaks: { ...s.peaks, [clipId]: res.data!.peaks } }));
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
  },
  mpLeaveSession: async () => {
    await get().exec("mp_leave_session");
    set({ mp: { active: false, roomCode: null, selfPeer: null, connected: false },
          peers: {}, peerSelection: {}, locksByLogicalId: {}, activeTrackId: null });
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
      if (release) await s.exec("mp_commit_track", { trackId: release });
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
  automationTrackId: null,
  openAutomation: (trackId) => set({ automationTrackId: trackId }),
  closeAutomation: () => set({ automationTrackId: null }),
  openBrowser: () => {
    set({ browserOpen: true });
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
  rescanPlugins: async (format = "all") => {
    set({ scanProgress: { format, done: false } });
    const res = await get().exec("rescan_plugins", { format });
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
    void executeCommand<CommandResult<{ colors: AvailableColor[] }>>({
      command: "list_colors",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.colors) set({ availableColors: res.data.colors });
    });
  },

  loadTransformTargets: () => {
    if (get().availableTransformTargets.length > 0) return;
    void executeCommand<CommandResult<{ targets: string[]; freeText: boolean }>>({
      command: "list_transform_targets",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.targets)
        set({
          availableTransformTargets: res.data.targets.map((name) => ({ name })),
          transformFreeText: res.data.freeText !== false,
        });
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
    if (!arm.ok) { s.pushAgentUtter("UHOH", "can't — no input"); return; }
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
