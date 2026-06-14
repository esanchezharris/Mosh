import { create } from "zustand";
import {
  executeCommand, getSnapshot, onEvent, isNative, notifyUiReady,
  getRemoteStatus, startRemotePairing, stopRemoteCompanion,
} from "./bridge";
import type {
  Snapshot, Transport, MoshEvent, CommandResult, AvailablePlugin,
  BuiltinPlugin, AvailableColor, RenderQA, Level, AudioDevices, Clip,
  WaveInput, TrackOutputs,
  PluginCounts, PluginBlockEntry,
} from "./types";
import type { RemoteStatus } from "./bridge";
import { type SnapDiv, snapTimeMap, tempoMapFrom } from "./time";

export type Tool = "move" | "split" | "range";
export type View = "arrange" | "mixer";
export type Peaks = [number, number][];
// Live spectral feed (Moshi reactivity) — fed by the 30Hz "spectrum" event from the
// engine (master FFT). bands are per-band energy 0..1 (low→high); level/flux 0..1.
// Pure telemetry like `levels`; never a command, no audio concepts leak (just numbers).
export type Spectrum = { bands: number[]; level: number; flux: number };
// ARR-010 — a UI-local edit time-range [start,end] in seconds. Never a command;
// only delete_time_range sends {start,end} across the bridge when invoked.
export type TimeRange = { start: number; end: number };
// AUT-003 — per-track inline-automation-lane param selection (which
// AutomatableParameter the strip under each track draws). UI-local view state.
export type InlineAutoSel = { pluginIndex: number; paramIndex: number };

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
  laneHeight: number;    // track-lane height in px (vertical zoom)
  selection: Set<string>;
  peaks: Record<string, Peaks>;

  // ARR-010 — the active edit time-range (UI-local; set by the Range tool, sent
  // to the backend only via delete_time_range). null when no range is drawn.
  timeRange: TimeRange | null;
  // AUT-003 — per-track inline-lane param selection (trackId → which param).
  inlineAuto: Record<string, InlineAutoSel>;

  // Stage 3: plugin browser
  selectedTrackId: string | null;
  availablePlugins: AvailablePlugin[];
  availableBuiltins: BuiltinPlugin[];
  pluginCounts: PluginCounts | null;          // per-format catalog counts (INS-005)
  pluginBlocklist: PluginBlockEntry[];        // quarantined plugins (INS-005)
  scanProgress: { format: string; done: boolean } | null; // transient rescan state
  browserOpen: boolean;
  renderProgress: Record<string, number>; // clipId → 0..1 (Tier-B render)
  availableColors: AvailableColor[];       // SA3 colour rack (from list_colors)
  labMode: boolean;                        // ASTD unlock for generative colours
  qaByClip: Record<string, RenderQA>;      // last render's quality readout
  remoteStatus: RemoteStatus | null;       // iPhone companion server state
  audioDevices: AudioDevices | null;       // full device enumeration (on-demand, lazy)
  waveInputs: WaveInput[] | null;          // RTG-001 input choices (on-demand, lazy)
  trackOutputs: TrackOutputs | null;       // RTG-002 output destinations (on-demand, lazy)
  // Live level meters (Wave 9) — fed by the 30Hz "levels" event, NOT the snapshot.
  levels: { tracks: Record<string, Level>; master: Level };
  // Live spectral feed (Moshi reactivity) — fed by the 30Hz "spectrum" event.
  spectrum: Spectrum;

  // Clip clipboard — pure UI-local view state. The captured clip descriptor only
  // crosses the bridge on paste (paste_clip); copy/cut never touch the backend
  // (swappable-seam rule). v1 holds a single clip; multi-clip copy is optional.
  clipboard: { clip: Clip; sourceTrackId: string } | null;

  // Serialized command dispatch (rapid sequential commands never race on a stale
  // snapshot). `pending` > 0 while any command is in flight. `optimistic` is an
  // additive overlay keyed by entity id, cleared on every refresh().
  pending: number;
  optimistic: Record<string, unknown>;

  refresh: () => Promise<void>;
  exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
  // Unserialized escape hatch (rare; bypasses the queue).
  execNow: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
  // Keyed trailing-throttle for continuous controls (sliders) — coalesces rapid
  // updates and always delivers the final value, routed through the serialized queue.
  execLatest: (key: string, command: string, args?: Record<string, unknown>) => void;
  setOptimistic: (id: string, patch: Record<string, unknown> | null) => void;
  // Opt the UI in to the engine's level-meter feed (it only emits `levels` once a
  // client registers). Idempotent; re-called when the track count grows.
  enableMeters: () => void;
  init: () => void;
  refreshRemote: () => Promise<void>;
  startRemotePairing: () => Promise<void>;
  stopRemote: () => Promise<void>;

  setPxPerSec: (v: number) => void;
  setTool: (t: Tool) => void;
  setSnap: (b: boolean) => void;
  setSnapDivision: (d: SnapDiv) => void;
  setLaneHeight: (h: number) => void;
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  snapTime: (t: number) => number;
  ensurePeaks: (clipId: string) => void;

  // ARR-010 — time-range view-state actions (never cross the bridge).
  setTimeRange: (r: TimeRange | null) => void;
  clearTimeRange: () => void;
  // AUT-003 — set which param the inline lane under a track draws.
  setInlineAuto: (trackId: string, sel: InlineAutoSel) => void;

  // Clipboard actions (UI-local until paste). copy/cut capture a snapshot clip;
  // paste reconstructs it on the backend via the paste_clip command.
  copySelection: () => void;
  cutSelection: () => Promise<void>;
  pasteClipboard: () => Promise<void>;

  setSelectedTrack: (id: string | null) => void;
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
  loadBlocklist: () => Promise<void>;
  clearBlocklist: () => Promise<void>;
  refreshPluginList: () => Promise<void>;
  loadColors: () => void;
  loadAudioDevices: () => Promise<void>;   // lazy + on-demand (force re-fetch after a device change)
  loadRouting: () => Promise<void>;        // RTG-001/002 — wave inputs + track outputs
  setLab: (b: boolean) => void;

  view: View;
  setView: (v: View) => void;

  theme: "dark" | "light";
  toggleTheme: () => void;

  // UI scale (ACC-005) — pure UI-local view state (like theme): never a command,
  // never crosses the bridge. Applied via document zoom so the whole WebView reflows.
  uiScale: number;
  setUiScale: (n: number) => void;
};

// ── Dispatch plumbing (transient runtime state, not reactive UI state) ──────────
// A single serialized command chain: each exec/execLatest waits for the prior to
// settle, so rapid sequential dispatches submit in order and never race on a stale
// snapshot. The tail is always a non-rejecting promise so one failure can't poison
// the queue. latestArgs/latestQueued back execLatest's keyed trailing-throttle.
let cmdChain: Promise<unknown> = Promise.resolve();
const latestArgs: Record<string, { command: string; args: Record<string, unknown> }> = {};
const latestQueued = new Set<string>();

export const useStore = create<State>((set, get) => ({
  snapshot: null,
  connected: isNative(),
  lastError: null,
  pending: 0,
  optimistic: {},

  pxPerSec: 80,
  tool: "move",
  snap: true,
  snapDivision: "1/4",
  laneHeight: 84,
  selection: new Set<string>(),
  peaks: {},
  timeRange: null,
  inlineAuto: {},
  selectedTrackId: null,
  availablePlugins: [],
  availableBuiltins: [],
  pluginCounts: null,
  pluginBlocklist: [],
  scanProgress: null,
  browserOpen: false,
  renderProgress: {},
  availableColors: [],
  labMode: false,
  qaByClip: {},
  remoteStatus: null,
  audioDevices: null,
  waveInputs: null,
  trackOutputs: null,
  levels: { tracks: {}, master: { l: -100, r: -100 } },
  spectrum: { bands: [], level: 0, flux: 0 },
  clipboard: null,

  refresh: async () => {
    if (!isNative()) return;
    try {
      const snap = await getSnapshot<Snapshot>();
      const grew = snap.tracks.length > (get().snapshot?.tracks.length ?? 0);
      // A fresh snapshot supersedes any optimistic overlay.
      set({ snapshot: snap, connected: true, optimistic: {} });
      // New tracks need their meter registered (enable_all_meters is idempotent).
      if (grew) get().enableMeters();
      // Prune selection / fetch peaks for current clips.
      const ids = new Set(snap.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      set((s) => ({ selection: new Set([...s.selection].filter((id) => ids.has(id))) }));
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
    // Serialize onto the shared chain: this command runs only after the prior one
    // settles, so a burst of commands submits in submission order and never races
    // on a stale snapshot. The tail is a non-rejecting promise (a prior failure is
    // swallowed) so one error can't poison the queue.
    const run = cmdChain.then(
      () => executeCommand<CommandResult>({ command, args }),
      () => executeCommand<CommandResult>({ command, args }),
    );
    cmdChain = run.then(() => undefined, () => undefined);
    set((s) => ({ pending: s.pending + 1 }));
    try {
      const res = await run;
      if (!res.ok) set({ lastError: res.error ?? `${command} failed` });
      return res;
    } finally {
      set((s) => ({ pending: Math.max(0, s.pending - 1) }));
    }
  },

  execNow: async (command, args = {}) => {
    // Unserialized: fires immediately, bypassing the queue. Use only for reads that
    // must not wait behind a long mutation.
    const res = await executeCommand<CommandResult>({ command, args });
    if (!res.ok) set({ lastError: res.error ?? `${command} failed` });
    return res;
  },

  execLatest: (key, command, args = {}) => {
    // Record the most recent intent for this key, then flush the LATEST through the
    // serialized queue. Intermediate drags coalesce; the final value always lands.
    latestArgs[key] = { command, args };
    if (latestQueued.has(key)) return;
    latestQueued.add(key);
    const flush = () => {
      latestQueued.delete(key);
      const latest = latestArgs[key];
      if (!latest) return undefined;
      return executeCommand<CommandResult>(latest).then((res) => {
        if (!res.ok) set({ lastError: res.error ?? `${latest.command} failed` });
        return res;
      });
    };
    const run = cmdChain.then(flush, flush);
    cmdChain = run.then(() => undefined, () => undefined);
    set((s) => ({ pending: s.pending + 1 }));
    void run.then(
      () => set((s) => ({ pending: Math.max(0, s.pending - 1) })),
      () => set((s) => ({ pending: Math.max(0, s.pending - 1) })),
    );
  },

  setOptimistic: (id, patch) =>
    set((s) => {
      const next = { ...s.optimistic };
      if (patch === null) delete next[id];
      else next[id] = patch;
      return { optimistic: next };
    }),

  enableMeters: () => {
    if (isNative()) void get().exec("enable_all_meters");
  },

  init: () => {
    onEvent("mosh_event", (raw) => {
      const ev = raw as MoshEvent;
      if (ev.type === "snapshot_invalidated") {
        void get().refresh();
      } else if (ev.type === "transport") {
        const t = ev.payload as Transport;
        set((s) => (s.snapshot ? { snapshot: { ...s.snapshot, transport: t } } : {}));
      } else if (ev.type === "levels") {
        // Targeted set (no snapshot refetch) — same lightweight path as transport.
        const p = ev.payload as { tracks: { id: string; l: number; r: number }[]; master: Level };
        const tracks: Record<string, Level> = {};
        for (const t of p.tracks ?? []) tracks[t.id] = { l: t.l, r: t.r };
        set({ levels: { tracks, master: p.master ?? { l: -100, r: -100 } } });
      } else if (ev.type === "spectrum") {
        // Master FFT feed (Moshi reactivity) — targeted set, no snapshot refetch.
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
      } else if (ev.type === "layer_render_progress") {
        const p = ev.payload as { clipId: string; progress: number };
        set((s) => ({ renderProgress: { ...s.renderProgress, [p.clipId]: p.progress } }));
      } else if (ev.type === "layer_status") {
        const p = ev.payload as { clipId?: string; qa?: RenderQA };
        if (p?.clipId && p.qa)
          set((s) => ({ qaByClip: { ...s.qaByClip, [p.clipId!]: p.qa as RenderQA } }));
        void get().refresh();
      }
    });
    void notifyUiReady();
    void get().refresh();
    void get().enableMeters();
    void get().refreshRemote();
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
  setLaneHeight: (h) => set({ laneHeight: Math.max(48, Math.min(220, h)) }),
  select: (ids, additive = false) =>
    set((s) => {
      const next = new Set(additive ? s.selection : []);
      for (const id of ids) next.add(id);
      return { selection: next };
    }),
  clearSelection: () => set({ selection: new Set<string>() }),
  setTimeRange: (r) => set({ timeRange: r }),
  clearTimeRange: () => set({ timeRange: null }),
  setInlineAuto: (trackId, sel) =>
    set((s) => ({ inlineAuto: { ...s.inlineAuto, [trackId]: sel } })),
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
    const { clipboard, selectedTrackId, snapshot } = get();
    if (!clipboard) return;
    await get().exec("paste_clip", {
      trackId: selectedTrackId ?? clipboard.sourceTrackId,
      start: snapshot?.transport.position ?? 0,
      clip: clipboard.clip,
    });
    await get().refresh();
  },

  setSelectedTrack: (id) => set({ selectedTrackId: id }),
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

  loadBlocklist: async () => {
    const res = await executeCommand<CommandResult<{ blocklist: PluginBlockEntry[] }>>({
      command: "get_plugin_blocklist",
      args: {},
    });
    if (res.ok && res.data) set({ pluginBlocklist: res.data.blocklist });
  },

  clearBlocklist: async () => {
    await get().exec("clear_plugin_blocklist");
    await get().loadBlocklist();
    await get().refreshPluginList();
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

  theme: "dark",
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      return { theme: next };
    }),

  uiScale: 1,
  setUiScale: (n) =>
    set(() => {
      // Clamp to a legible range; zoom reflows cleanly in the JUCE WebView (no
      // transform-origin / scrollbar artifacts) so we drive it directly.
      const next = Math.min(1.4, Math.max(0.8, Number.isFinite(n) ? n : 1));
      (document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(next);
      return { uiScale: next };
    }),
}));
