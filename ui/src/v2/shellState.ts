// v2 shell view-state — a THIN slice for state the main store doesn't already hold.
// Everything the legacy store already tracks (selection, selectedTrackId, pxPerSec,
// peaks, transport, theme, agentUtter, mp/peers, …) is read from useStore directly;
// track selection in particular MUST stay in useStore (it fires the multiplayer
// broadcast/lock claim). This slice only adds genuinely-new v2 view concerns.

import { create } from "zustand";

export type InspectorTab = "mix" | "fx" | "gen" | "lyrics" | "midi" | "takes" | "warp" | "clip";
export type SectionZoom = "8b" | "16b" | "full";
export type BrowserTab = "sounds" | "plugins";

interface ShellState {
  selectedClipId: string | null;   // clip-level selection for the contextual Inspector
  inspectorTab: InspectorTab;
  inspectorOpen: boolean;
  sectionZoom: SectionZoom;
  activityOpen: boolean;
  browserOpen: boolean;            // LEFT push-dock (sounds + plugins), pull-tab toggled
  browserTab: BrowserTab;
  rightOpen: boolean;              // RIGHT push-dock (agent · inspector · collaborators); default open

  setSelectedClip: (id: string | null) => void;
  setInspectorTab: (t: InspectorTab) => void;
  setInspectorOpen: (b: boolean) => void;
  setSectionZoom: (z: SectionZoom) => void;
  setActivityOpen: (b: boolean) => void;
  setBrowserOpen: (b: boolean) => void;
  toggleBrowser: () => void;
  openBrowserTab: (t: BrowserTab) => void;  // open the drawer ON a tab (used by "+ plugin")
  setRightOpen: (b: boolean) => void;
  toggleRight: () => void;
}

export const useShell = create<ShellState>((set) => ({
  selectedClipId: null,
  inspectorTab: "mix",
  inspectorOpen: false,
  sectionZoom: "16b",
  activityOpen: false,
  browserOpen: false,
  browserTab: "sounds",
  rightOpen: true,

  // Selecting a clip opens the inspector; deselecting leaves it as-is (the user can
  // pin/close it explicitly). Track selection is NOT here — route it through useStore.
  setSelectedClip: (id) => set(id ? { selectedClipId: id, inspectorOpen: true } : { selectedClipId: null }),
  setInspectorTab: (t) => set({ inspectorTab: t }),
  setInspectorOpen: (b) => set({ inspectorOpen: b }),
  setSectionZoom: (z) => set({ sectionZoom: z }),
  setActivityOpen: (b) => set({ activityOpen: b }),
  setBrowserOpen: (b) => set({ browserOpen: b }),
  toggleBrowser: () => set((s) => ({ browserOpen: !s.browserOpen })),
  openBrowserTab: (t) => set({ browserOpen: true, browserTab: t }),
  setRightOpen: (b) => set({ rightOpen: b }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
}));
