// UI-local dock layout state (Phase 6). Holds the resizable/collapsible fixed
// zones — the BOTTOM detail dock and the LEFT browser — and persists them to
// localStorage. Pure view state — never crosses the seam, never a command. The
// geometry is delegated to the pure engine (dockLayout.ts); this is the persisted
// store + the user actions.

import { create } from "zustand";
import { resizeZone, toggleZone, collapseZone, expandZone, type Zone } from "./dockLayout";

// Merge a layout-preset's {collapsed,size} onto a zone THROUGH the collapse/expand
// engine, so a preset-driven collapse stashes the live width into prevSize (and a later
// expand restores it) instead of a raw spread that leaves size/prevSize desynced.
function mergePreset(z: Zone, p?: Partial<Zone>): Zone {
  if (!p) return z;
  if (p.collapsed === true) return collapseZone(z); // stash prevSize, size→0 (ignore any preset size)
  let next = p.collapsed === false ? expandZone(z) : z; // expand restores prevSize (no-op if already open)
  if (typeof p.size === "number") next = { ...next, size: clampSize(next, p.size) };
  return next;
}
const clampSize = (z: Zone, s: number) => Math.max(z.min, Math.min(z.max, s));

const KEY = "mosh.dockLayout";
const DEFAULT_BOTTOM: Zone = { id: "detail", size: 196, min: 120, max: 520 };
// The browser is opt-in: collapsed to a rail by default so it never disrupts the
// existing layout; pin it open and the width persists.
// prevSize seeds the FIRST expand (toggleZone restores prevSize ?? min) so the
// browser opens at a comfortable 240px rather than snapping to its minimum.
const DEFAULT_LEFT: Zone = { id: "browser", size: 240, min: 170, max: 420, collapsed: true, prevSize: 240 };
// The right "Session" rail (participants + inspector). Open by default in the
// redesign so the agent (Moshi) + collaborators are present; collapsible to an edge
// tab for more arrange space. Only ever rendered when the redesign flag is on.
const DEFAULT_RIGHT: Zone = { id: "inspector", size: 300, min: 220, max: 480, collapsed: false, prevSize: 300 };

type Stored = { size: number; collapsed?: boolean; prevSize?: number };
function readZone(raw: unknown, def: Zone): Zone {
  const r = raw as Partial<Stored> | null;
  if (r && typeof r.size === "number")
    return { ...def, size: r.size, collapsed: !!r.collapsed, prevSize: typeof r.prevSize === "number" ? r.prevSize : undefined };
  return def;
}
// Pure: turn the parsed localStorage value into the three zones. Current shape is
// { bottom, left, right }; the old { bottom, left } and bottom-only { size,… } shapes
// migrate by defaulting any missing zone.
export function parseDock(raw: unknown): { bottom: Zone; left: Zone; right: Zone } {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if ("bottom" in r || "left" in r || "right" in r)
      return { bottom: readZone(r.bottom, DEFAULT_BOTTOM), left: readZone(r.left, DEFAULT_LEFT), right: readZone(r.right, DEFAULT_RIGHT) };
    return { bottom: readZone(raw, DEFAULT_BOTTOM), left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
  }
  return { bottom: DEFAULT_BOTTOM, left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
}
function load(): { bottom: Zone; left: Zone; right: Zone } {
  try { return parseDock(JSON.parse(localStorage.getItem(KEY) || "null")); }
  catch { return { bottom: DEFAULT_BOTTOM, left: DEFAULT_LEFT, right: DEFAULT_RIGHT }; }
}
const pack = (z: Zone): Stored => ({ size: z.size, collapsed: z.collapsed, prevSize: z.prevSize });
function save(s: { bottom: Zone; left: Zone; right: Zone }): void {
  try { localStorage.setItem(KEY, JSON.stringify({ bottom: pack(s.bottom), left: pack(s.left), right: pack(s.right) })); } catch { /* noop */ }
}

interface DockLayoutState {
  bottom: Zone;
  left: Zone;
  right: Zone;
  resizeBottom: (deltaPx: number) => void;
  toggleBottom: () => void;
  resizeLeft: (deltaPx: number) => void;
  toggleLeft: () => void;
  resizeRight: (deltaPx: number) => void;
  toggleRight: () => void;
  // Seed zones from a template's layout preset (DAW templates). Merges the given
  // collapsed/size onto each named zone + persists; untouched zones are left as-is.
  applyPreset: (p: { left?: Partial<Zone>; right?: Partial<Zone>; bottom?: Partial<Zone> }) => void;
}

export const useDockLayout = create<DockLayoutState>((set, get) => {
  const persist = () => save({ bottom: get().bottom, left: get().left, right: get().right });
  return {
    ...load(),
    resizeBottom: (deltaPx) => { set({ bottom: resizeZone(get().bottom, deltaPx) }); persist(); },
    toggleBottom: () => { set({ bottom: toggleZone(get().bottom, 0) }); persist(); },
    resizeLeft: (deltaPx) => { set({ left: resizeZone(get().left, deltaPx) }); persist(); },
    toggleLeft: () => { set({ left: toggleZone(get().left, 0) }); persist(); },
    resizeRight: (deltaPx) => { set({ right: resizeZone(get().right, deltaPx) }); persist(); },
    toggleRight: () => { set({ right: toggleZone(get().right, 0) }); persist(); },
    applyPreset: (p) => {
      set((s) => ({
        left: mergePreset(s.left, p.left),
        right: mergePreset(s.right, p.right),
        bottom: mergePreset(s.bottom, p.bottom),
      }));
      persist();
    },
  };
});
