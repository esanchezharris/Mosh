import { create } from "zustand";
import {
  executeCommand, getSnapshot, onEvent, isNative, notifyUiReady,
  getRemoteStatus, startRemotePairing, stopRemoteCompanion,
} from "./bridge";
import type {
  Snapshot, MoshEvent, CommandResult, Clip,
} from "./types";
import { versionBannerError } from "./types";
import type { RemoteStatus } from "./bridge";
import { type SnapDiv, snapTimeMap, tempoMapFrom } from "./time";
import type { ChangeSet } from "./agent/executor";
// Schema-driven settings (UI-local, localStorage-backed). The store mirrors a few
// of its values (theme/uiScale/voiceOn/voiceVol) so existing consumers stay reactive
// while the SettingsPanel and these mutators both write through the single source.
import { useSettings } from "./settings/store";
// AGT-MEM (M3) — drops the cached agent-memory pools on a project switch.
import { invalidateMemoryHydration } from "./agent/memory/hydrate";
// AGT-MEM (M3, item 5) — mirrors every exec() call into the in-session ring buffer
// sessionSummary.ts digests into a project note on the next project switch.
import { recordSessionCommand } from "./agent/memory/sessionLog";
// Per-rail "mosh_event" handler bodies (verbatim motion from init(); the dispatch
// order + conditions stay in init() below, which is load-bearing).
import {
  onSnapshotInvalidated, onTransport, onLevels, onSpectrum, onPluginScanProgress,
  onTranscribeStatus, onBuildLyricsStatus, onSkeletonStatus, onSketchStatus,
  onLayerRenderProgress, onLayerStatus, onMpState, onWebrtcSignal,
  onPeerSelection, onPeerPresence, onMpCommitDone,
} from "./store/events";
// RFC 004 step 2 — the store is composed from StateCreator slices along the
// existing rails (telemetry / mp / jobs / catalogs) inside the SINGLE create()
// call below. Slice files own their fields + actions; `State` stays the one seam
// type and `useStore` the one store — consumers keep importing from ui/src/store.
import { createTelemetrySlice, type TelemetrySlice } from "./store/telemetry";
import { createMpSlice, type MpSlice } from "./store/mp";
import { createJobsSlice, type JobsSlice } from "./store/jobs";
import { createCatalogsSlice, type CatalogsSlice } from "./store/catalogs";

export type Tool = "move" | "split" | "range";
export type View = "arrange" | "mixer";
export type Peaks = [number, number][];
// Live spectral feed (Moshi reactivity), fed by the 30Hz "spectrum" event.
export type Spectrum = { bands: number[]; level: number; flux: number };
// ARR-010 — a UI-local edit time-range [start,end] in seconds. Never a command;
// only delete_time_range sends {start,end} across the bridge when invoked.
export type TimeRange = { start: number; end: number };

export type State = {
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

  // Stage 3: plugin browser (the catalog lists themselves live in the catalogs
  // slice — ./store/catalogs; these are the pure view-state companions).
  selectedTrackId: string | null;
  expandedTracks: Set<string>;            // UI-local: tracks whose inline FX drawer is open
  browserOpen: boolean;
  remoteStatus: RemoteStatus | null;       // iPhone companion server state

  // Clip clipboard — pure UI-local view state. The captured clip descriptor only
  // crosses the bridge on paste (paste_clip); copy/cut never touch the backend
  // (swappable-seam rule). v1 holds a single clip; multi-clip copy is optional.
  clipboard: { clip: Clip; sourceTrackId: string } | null;

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
} & TelemetrySlice & MpSlice & JobsSlice & CatalogsSlice;

export const useStore = create<State>((set, get, api) => ({
  // RFC 004 slices — field groups + their actions along the existing rails.
  // Composed FIRST so the core fields below read as the remainder; no key overlaps.
  ...createTelemetrySlice(set, get, api),
  ...createMpSlice(set, get, api),
  ...createJobsSlice(set, get, api),
  ...createCatalogsSlice(set, get, api),

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
  browserOpen: false,
  remoteStatus: null,
  clipboard: null,

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
    // Thin dispatcher over the per-rail handlers in store/events.ts (verbatim body
    // motion). The order + conditions here are load-bearing and must not change:
    // transport / levels / spectrum are the 30 Hz telemetry rails that deliberately
    // bypass the snapshot.
    onEvent("mosh_event", (raw) => {
      const ev = raw as MoshEvent;
      if (ev.type === "snapshot_invalidated") {
        onSnapshotInvalidated(ev, set, get);
      } else if (ev.type === "transport") {
        onTransport(ev, set);
      } else if (ev.type === "levels") {
        onLevels(ev, set);
      } else if (ev.type === "spectrum") {
        onSpectrum(ev, set);
      } else if (ev.type === "plugin_scan_progress") {
        onPluginScanProgress(ev, set, get);
      } else if (ev.type === "transcribe_status") {
        onTranscribeStatus(ev, set);
      } else if (ev.type === "build_lyrics_status") {
        onBuildLyricsStatus(ev, set);
      } else if (ev.type === "skeleton_status") {
        onSkeletonStatus(ev, set);
      } else if (ev.type === "sketch_status") {
        onSketchStatus(ev, set);
      } else if (ev.type === "layer_render_progress") {
        onLayerRenderProgress(ev, set);
      } else if (ev.type === "layer_status") {
        onLayerStatus(ev, set, get);
      } else if (ev.type === "mp_state") {
        onMpState(ev, set);
      } else if (ev.type === "webrtc_signal") {
        onWebrtcSignal(ev);
      } else if (ev.type === "peer_selection") {
        onPeerSelection(ev, set);
      } else if (ev.type === "peer_presence") {
        onPeerPresence(ev, set);
      } else if (ev.type === "mp_commit_done") {
        onMpCommitDone(ev, set);
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

  editingClipId: null,
  openPianoRoll: (clipId) => set({ editingClipId: clipId }),
  closePianoRoll: () => set({ editingClipId: null }),
  feltWrongOpen: false,
  setFeltWrongOpen: (open) => set({ feltWrongOpen: open }),
  automationTrackId: null,
  openAutomation: (trackId) => set({ automationTrackId: trackId }),
  closeAutomation: () => set({ automationTrackId: null }),
  openBrowser: () => { set({ browserOpen: true }); get().ensurePluginCatalog(); },
  closeBrowser: () => set({ browserOpen: false }),

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
