// UI-local floating-window state for the LoRA Lab. Same shape as useDrumWindow:
// geometry comes from the pure engine (dockLayout), the rect persists to
// localStorage, and none of it is ever a command.
//
// Larger default than the drum window because the Lab's primary element is a
// column of waveforms — the take sheet is the thing you read, and a cramped one
// turns a row of takes into a row of slivers.

import { create } from "zustand";
import { clampWindow, moveWindow, resizeWindow, type FloatWin, type ResizeEdge } from "./dockLayout";

const KEY = "mosh.loraLab";
// Sized to fit a TYPICAL run without scrolling: stub/blocker notice + run header
// + prompt + source + six take rows + the kept rack measures ~693px of content,
// and 560 gave a 513px viewport — so the run header, the one thing you watch
// while training, scrolled out of view exactly when it mattered. Measured, not
// guessed; re-measure if the Lab grows another section rather than nudging it.
const DEFAULT: FloatWin = { id: "lora-lab", x: 160, y: 70, w: 860, h: 760, minW: 560, minH: 380 };

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

interface LoraLabWindowState {
  open: boolean;
  win: FloatWin;
  show: () => void;
  close: () => void;
  toggle: () => void;
  move: (dx: number, dy: number) => void;
  resize: (edge: ResizeEdge, dx: number, dy: number) => void;
}

export const useLoraLab = create<LoraLabWindowState>((set, get) => ({
  open: false,
  win: clampWindow(load(), bounds()),
  // Re-clamp on open: the window may have been saved on a larger display, and a
  // panel restored off-screen is indistinguishable from a Lab that failed to open.
  show: () => set({ open: true, win: clampWindow(get().win, bounds()) }),
  close: () => set({ open: false }),
  toggle: () => (get().open ? set({ open: false }) : set({ open: true, win: clampWindow(get().win, bounds()) })),
  move: (dx, dy) => { const w = moveWindow(get().win, dx, dy, bounds()); save(w); set({ win: w }); },
  resize: (edge, dx, dy) => { const w = resizeWindow(get().win, edge, dx, dy, bounds()); save(w); set({ win: w }); },
}));
