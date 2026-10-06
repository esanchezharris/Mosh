// Which plugin panels are minimized. A VIEW preference of this viewer: never a command,
// never undoable, never in the session. Kept in localStorage so it survives a reload;
// every storage access is guarded (it can throw or come back empty).
import { create } from "zustand";
import type { Plugin } from "../../types";

const STORAGE_KEY = "mosh.v3.pluginPanels";
const MAX_ENTRIES = 500;

/** The key a plugin's minimized state is stored under: its stable item id, else its
 *  track and chain position (which follows the slot on a reorder: older sessions only). */
export const panelKey = (trackId: string, plugin: Pick<Plugin, "itemId" | "index">): string =>
  plugin.itemId ? `id:${plugin.itemId}` : `slot:${trackId}:${plugin.index}`;

function load(): Record<string, true> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const [k, v] of Object.entries(parsed)) if (v === true && typeof k === "string") out[k] = true;
    return out;
  } catch {
    return {};
  }
}

function save(collapsed: Record<string, true>): void {
  try {
    const keys = Object.keys(collapsed);
    const kept = keys.length > MAX_ENTRIES ? Object.fromEntries(keys.slice(-MAX_ENTRIES).map((k) => [k, true])) : collapsed;
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    /* storage unavailable: the preference lasts for this session only */
  }
}

type PanelState = {
  collapsed: Record<string, true>;
  toggle: (key: string) => void;
  setCollapsed: (key: string, collapsed: boolean) => void;
};

export const usePanelState = create<PanelState>((set, get) => ({
  collapsed: load(),
  toggle: (key) => get().setCollapsed(key, !get().collapsed[key]),
  setCollapsed: (key, collapsed) => {
    const next = { ...get().collapsed };
    if (collapsed) next[key] = true; else delete next[key];
    save(next);
    set({ collapsed: next });
  },
}));

/** Testing hook: forget everything (and what storage holds). */
export function resetPanelStateForTests(): void {
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  usePanelState.setState({ collapsed: {} });
}
