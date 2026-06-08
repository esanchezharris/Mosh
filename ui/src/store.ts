import { create } from "zustand";
import { executeCommand, getSnapshot, onEvent, isNative } from "./bridge";
import type { Snapshot, Transport, MoshEvent, CommandResult } from "./types";

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

  refresh: async () => {
    if (!isNative()) return;
    try {
      const snap = await getSnapshot<Snapshot>();
      set({ snapshot: snap, connected: true });
      // Prune selection / fetch peaks for current clips.
      const ids = new Set(snap.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      set((s) => ({ selection: new Set([...s.selection].filter((id) => ids.has(id))) }));
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
}));
