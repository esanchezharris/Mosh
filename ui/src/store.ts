import { create } from "zustand";
import { executeCommand, getSnapshot, onEvent, isNative } from "./bridge";
import type {
  Snapshot, Transport, MoshEvent, CommandResult, AvailablePlugin,
  AvailableColor, RenderQA,
} from "./types";

export type Tool = "move" | "split";
export type Peaks = [number, number][];
// Musical snap divisions (Stage 14): seconds are derived from the snapshot's
// tempo/time-sig at snap time — the grid is musical, the wire stays seconds.
export type SnapDiv = "bar" | "1/2" | "1/4" | "1/8" | "1/16" | "1/16T";
export const SNAP_DIVS: SnapDiv[] = ["bar", "1/2", "1/4", "1/8", "1/16", "1/16T"];

type State = {
  snapshot: Snapshot | null;
  connected: boolean;
  lastError: string | null;

  // UI-local view state (NOT commands — the swappable-seam rule: zoom, tool,
  // snap, selection never cross the bridge).
  pxPerSec: number;
  tool: Tool;
  snap: boolean;
  snapDiv: SnapDiv;
  selection: Set<string>;
  peaks: Record<string, Peaks>;

  // Stage 3: plugin browser
  selectedTrackId: string | null;
  availablePlugins: AvailablePlugin[];
  browserOpen: boolean;
  renderProgress: Record<string, number>; // clipId → 0..1 (Tier-B render)
  availableColors: AvailableColor[];       // SA3 colour rack (from list_colors)
  labMode: boolean;                        // ASTD unlock for generative colours
  qaByClip: Record<string, RenderQA>;      // last render's quality readout

  refresh: () => Promise<void>;
  exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
  init: () => void;

  setPxPerSec: (v: number) => void;
  setTool: (t: Tool) => void;
  setSnap: (b: boolean) => void;
  setSnapDiv: (d: SnapDiv) => void;
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  secsPerBeat: () => number;
  beatsPerBar: () => number;
  snapSeconds: () => number; // the current snap division, in seconds
  snapTime: (t: number) => number;
  ensurePeaks: (clipId: string) => void;

  setSelectedTrack: (id: string | null) => void;
  openBrowser: () => void;
  closeBrowser: () => void;

  // Clip context menu + follow-playhead (Stage 15, pure view state).
  ctxMenu: { x: number; y: number; clipId: string } | null;
  setCtxMenu: (m: { x: number; y: number; clipId: string } | null) => void;
  follow: boolean;
  setFollow: (b: boolean) => void;

  // Piano roll (Stage 16): which MIDI clip is open in the editor drawer.
  editingClipId: string | null;
  setEditingClip: (id: string | null) => void;

  // Mixer view (Stage 17): swaps the rack area with channel strips.
  mixerOpen: boolean;
  setMixerOpen: (b: boolean) => void;

  // Crate browser (Stage 18): left drawer over the sample library.
  crateOpen: boolean;
  setCrateOpen: (b: boolean) => void;

  // Clip rename overlay (Stage 21).
  renamingClipId: string | null;
  setRenamingClip: (id: string | null) => void;
  loadColors: () => void;
  setLab: (b: boolean) => void;

  theme: "dark" | "light";
  toggleTheme: () => void;
};

export const useStore = create<State>((set, get) => ({
  snapshot: null,
  connected: isNative(),
  lastError: null,

  pxPerSec: 80,
  tool: "move",
  snap: true,
  snapDiv: "1/16",
  selection: new Set<string>(),
  peaks: {},
  selectedTrackId: null,
  availablePlugins: [],
  browserOpen: false,
  renderProgress: {},
  availableColors: [],
  labMode: false,
  qaByClip: {},

  refresh: async () => {
    if (!isNative()) return;
    try {
      const snap = await getSnapshot<Snapshot>();
      set({ snapshot: snap, connected: true });
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
    const res = await executeCommand<CommandResult>({ command, args });
    if (!res.ok) set({ lastError: res.error ?? `${command} failed` });
    return res;
  },

  init: () => {
    onEvent("mosh_event", (raw) => {
      const ev = raw as MoshEvent;
      if (ev.type === "snapshot_invalidated") {
        void get().refresh();
      } else if (ev.type === "transport") {
        const t = ev.payload as Transport;
        set((s) => (s.snapshot ? { snapshot: { ...s.snapshot, transport: t } } : {}));
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
    void get().refresh();
  },

  setPxPerSec: (v) => set({ pxPerSec: Math.max(20, Math.min(400, v)) }),
  setTool: (t) => set({ tool: t }),
  setSnap: (b) => set({ snap: b }),
  setSnapDiv: (d) => set({ snapDiv: d }),
  select: (ids, additive = false) =>
    set((s) => {
      const next = new Set(additive ? s.selection : []);
      for (const id of ids) next.add(id);
      return { selection: next };
    }),
  clearSelection: () => set({ selection: new Set<string>() }),
  secsPerBeat: () => 60 / (get().snapshot?.session.tempo || 120),
  beatsPerBar: () => {
    const s = get().snapshot?.session;
    // Beats here are quarter notes (the engine's beat unit); a 4/4 bar is 4.
    return ((s?.timeSigNumerator || 4) * 4) / (s?.timeSigDenominator || 4);
  },
  snapSeconds: () => {
    const spb = get().secsPerBeat();
    switch (get().snapDiv) {
      case "bar": return spb * get().beatsPerBar();
      case "1/2": return spb * 2;
      case "1/4": return spb;
      case "1/8": return spb / 2;
      case "1/16T": return spb / 6;
      default: return spb / 4; // 1/16
    }
  },
  snapTime: (t) => {
    const { snap } = get();
    if (!snap) return t;
    const g = get().snapSeconds();
    return Math.round(t / g) * g;
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

  setSelectedTrack: (id) => set({ selectedTrackId: id }),
  ctxMenu: null,
  setCtxMenu: (m) => set({ ctxMenu: m }),
  follow: true,
  setFollow: (b) => set({ follow: b }),
  editingClipId: null,
  setEditingClip: (id) => set({ editingClipId: id }),
  mixerOpen: false,
  setMixerOpen: (b) => set({ mixerOpen: b }),
  crateOpen: false,
  setCrateOpen: (b) => set({ crateOpen: b }),
  renamingClipId: null,
  setRenamingClip: (id) => set({ renamingClipId: id }),
  openBrowser: () => {
    set({ browserOpen: true });
    if (get().availablePlugins.length === 0)
      void executeCommand<CommandResult<{ plugins: AvailablePlugin[] }>>({
        command: "list_plugins",
        args: {},
      }).then((res) => {
        if (res.ok && res.data) set({ availablePlugins: res.data.plugins });
      });
  },
  closeBrowser: () => set({ browserOpen: false }),

  loadColors: () => {
    if (get().availableColors.length > 0) return;
    void executeCommand<CommandResult<{ colors: AvailableColor[] }>>({
      command: "list_colors",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.colors) set({ availableColors: res.data.colors });
    });
  },
  setLab: (b) => set({ labMode: b }),

  theme: "dark",
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      return { theme: next };
    }),
}));
