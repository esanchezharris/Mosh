// UI-local dock layout state (Phase 6). Holds the resizable/collapsible fixed
// zones — the BOTTOM detail dock and the LEFT browser — and persists them to
// localStorage. Pure view state — never crosses the seam, never a command. The
// geometry is delegated to the pure engine (dockLayout.ts); this is the persisted
// store + the user actions.

import { create } from "zustand";
import { resizeZone, toggleZone, type Zone } from "./dockLayout";

const KEY = "mosh.dockLayout";
const DEFAULT_BOTTOM: Zone = { id: "detail", size: 196, min: 120, max: 520 };
// The browser is opt-in: collapsed to a rail by default so it never disrupts the
// existing layout; pin it open and the width persists.
// prevSize seeds the FIRST expand (toggleZone restores prevSize ?? min) so the
// browser opens at a comfortable 240px rather than snapping to its minimum.
const DEFAULT_LEFT: Zone = { id: "browser", size: 240, min: 170, max: 420, collapsed: true, prevSize: 240 };

type Stored = { size: number; collapsed?: boolean; prevSize?: number };
function readZone(raw: unknown, def: Zone): Zone {
  const r = raw as Partial<Stored> | null;
  if (r && typeof r.size === "number")
    return { ...def, size: r.size, collapsed: !!r.collapsed, prevSize: typeof r.prevSize === "number" ? r.prevSize : undefined };
  return def;
}
function load(): { bottom: Zone; left: Zone } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw === "object") {
      // Current shape { bottom, left }; migrate the old bottom-only { size,… } shape.
      if ("bottom" in raw || "left" in raw)
        return { bottom: readZone(raw.bottom, DEFAULT_BOTTOM), left: readZone(raw.left, DEFAULT_LEFT) };
      return { bottom: readZone(raw, DEFAULT_BOTTOM), left: DEFAULT_LEFT };
    }
  } catch { /* corrupt → defaults */ }
  return { bottom: DEFAULT_BOTTOM, left: DEFAULT_LEFT };
}
const pack = (z: Zone): Stored => ({ size: z.size, collapsed: z.collapsed, prevSize: z.prevSize });
function save(s: { bottom: Zone; left: Zone }): void {
  try { localStorage.setItem(KEY, JSON.stringify({ bottom: pack(s.bottom), left: pack(s.left) })); } catch { /* noop */ }
}

interface DockLayoutState {
  bottom: Zone;
  left: Zone;
  resizeBottom: (deltaPx: number) => void;
  toggleBottom: () => void;
  resizeLeft: (deltaPx: number) => void;
  toggleLeft: () => void;
  setLeftCollapsed: (collapsed: boolean) => void;
}

export const useDockLayout = create<DockLayoutState>((set, get) => {
  const persist = () => save({ bottom: get().bottom, left: get().left });
  return {
    ...load(),
    resizeBottom: (deltaPx) => { set({ bottom: resizeZone(get().bottom, deltaPx) }); persist(); },
    toggleBottom: () => { set({ bottom: toggleZone(get().bottom, 0) }); persist(); },
    resizeLeft: (deltaPx) => { set({ left: resizeZone(get().left, deltaPx) }); persist(); },
    toggleLeft: () => { set({ left: toggleZone(get().left, 0) }); persist(); },
    setLeftCollapsed: (collapsed) => {
      const cur = get().left;
      if (!!cur.collapsed === collapsed) return;
      set({ left: toggleZone(cur, 0) }); persist();
    },
  };
});
