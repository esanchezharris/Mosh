// UI-local dock layout state (Phase 6). Holds the resizable/collapsible BOTTOM
// detail zone (the Dock) and persists it to localStorage. Pure view state — never
// crosses the seam, never a command. The geometry is delegated to the pure engine
// (dockLayout.ts); this is just the persisted store + the two user actions.

import { create } from "zustand";
import { resizeZone, toggleZone, type Zone } from "./dockLayout";

const KEY = "mosh.dockLayout";
const DEFAULT_BOTTOM: Zone = { id: "detail", size: 196, min: 120, max: 520 };

function load(): Zone {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw.size === "number")
      return { ...DEFAULT_BOTTOM, size: raw.size, collapsed: !!raw.collapsed, prevSize: typeof raw.prevSize === "number" ? raw.prevSize : undefined };
  } catch { /* corrupt → default */ }
  return DEFAULT_BOTTOM;
}
function save(z: Zone): void {
  try { localStorage.setItem(KEY, JSON.stringify({ size: z.size, collapsed: z.collapsed, prevSize: z.prevSize })); } catch { /* noop */ }
}

interface DockLayoutState {
  bottom: Zone;
  /** Resize the bottom dock by `deltaPx` (positive grows it), clamped to [min,max]. */
  resizeBottom: (deltaPx: number) => void;
  /** Collapse ↔ expand the bottom dock (remembers its prior height). */
  toggleBottom: () => void;
}

export const useDockLayout = create<DockLayoutState>((set, get) => ({
  bottom: load(),
  resizeBottom: (deltaPx) => { const b = resizeZone(get().bottom, deltaPx); save(b); set({ bottom: b }); },
  toggleBottom: () => { const b = toggleZone(get().bottom, 0); save(b); set({ bottom: b }); },
}));
