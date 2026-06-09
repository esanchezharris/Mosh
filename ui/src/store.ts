import { create } from "zustand";
import { executeCommand, getSnapshot, onEvent, isNative } from "./bridge";
import type {
  Snapshot, Transport, MoshEvent, CommandResult, AvailablePlugin,
  AvailableColor, RenderQA,
} from "./types";

export type Tool = "move" | "split";
export type Peaks = [number, number][];

type State = {
  snapshot: Snapshot | null;
  connected: boolean;
  lastError: string | null;

  // UI-local view state (NOT commands — the swappable-seam rule: zoom, tool,
  // snap, selection never cross the bridge).
  pxPerSec: number;
  tool: Tool;
  snap: boolean;
  snapGrid: number; // seconds
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
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  snapTime: (t: number) => number;
  ensurePeaks: (clipId: string) => void;

  setSelectedTrack: (id: string | null) => void;
  openBrowser: () => void;
  closeBrowser: () => void;
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
  snapGrid: 0.25,
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
  select: (ids, additive = false) =>
    set((s) => {
      const next = new Set(additive ? s.selection : []);
      for (const id of ids) next.add(id);
      return { selection: next };
    }),
  clearSelection: () => set({ selection: new Set<string>() }),
  snapTime: (t) => {
    const { snap, snapGrid } = get();
    return snap ? Math.round(t / snapGrid) * snapGrid : t;
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
