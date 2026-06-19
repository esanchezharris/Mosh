// UI-local floating-window state (Phase 6). Drives the FL-style drum-sequencer
// window: which clip it edits + its on-screen rect. Geometry is the pure engine
// (dockLayout: clampWindow/moveWindow/resizeWindow); the rect persists to
// localStorage. Pure view state — never a command, never crosses the seam.

import { create } from "zustand";
import { clampWindow, moveWindow, resizeWindow, type FloatWin, type ResizeEdge } from "./dockLayout";

const KEY = "mosh.drumWindow";
const DEFAULT: FloatWin = { id: "drum-seq", x: 120, y: 150, w: 720, h: 380, minW: 480, minH: 300 };

const bounds = () => ({
  w: typeof window !== "undefined" ? window.innerWidth : 1280,
  h: typeof window !== "undefined" ? window.innerHeight : 800,
});

function load(): FloatWin {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || "null");
    if (r && typeof r.x === "number") return { ...DEFAULT, x: r.x, y: r.y, w: r.w, h: r.h };
  } catch { /* corrupt → default */ }
  return DEFAULT;
}
function save(w: FloatWin): void {
  try { localStorage.setItem(KEY, JSON.stringify({ x: w.x, y: w.y, w: w.w, h: w.h })); } catch { /* noop */ }
}

interface DrumWindowState {
  clipId: string | null;       // null = closed
  win: FloatWin;
  open: (clipId: string) => void;
  close: () => void;
  move: (dx: number, dy: number) => void;
  resize: (edge: ResizeEdge, dx: number, dy: number) => void;
}

export const useDrumWindow = create<DrumWindowState>((set, get) => ({
  clipId: null,
  win: clampWindow(load(), bounds()),
  open: (clipId) => set({ clipId, win: clampWindow(get().win, bounds()) }),
  close: () => set({ clipId: null }),
  move: (dx, dy) => { const w = moveWindow(get().win, dx, dy, bounds()); save(w); set({ win: w }); },
  resize: (edge, dx, dy) => { const w = resizeWindow(get().win, edge, dx, dy, bounds()); save(w); set({ win: w }); },
}));
