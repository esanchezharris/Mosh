// v2 shell view-state — a THIN slice for state the main store doesn't already hold.
// Everything the legacy store already tracks (selection, selectedTrackId, pxPerSec,
// peaks, transport, theme, agentUtter, mp/peers, …) is read from useStore directly;
// track selection in particular MUST stay in useStore (it fires the multiplayer
// broadcast/lock claim). This slice only adds genuinely-new v2 view concerns.

import { create } from "zustand";

export type InspectorTab = "mix" | "fx" | "gen" | "lyrics" | "midi" | "takes" | "warp" | "clip";
export type SectionZoom = "8b" | "16b" | "full";
export type BrowserTab = "sounds" | "plugins";
export type RailTab = "clip" | "track" | "agent";

// UIREACH-TIMERANGE — a time-span selection, drawn by shift-dragging the bar ruler.
// UI-local like every other selection concept in this codebase (never mirrored to the
// backend): the span only becomes a command when the producer picks an explicit action
// off it (delete_time_range, ripple delete, or loop-this-range). null = no span drawn.
export type TimeRangeSel = { start: number; end: number };

interface ShellState {
  selectedClipId: string | null;   // clip-level selection for the contextual Inspector
  inspectorTab: InspectorTab;
  inspectorOpen: boolean;
  sectionZoom: SectionZoom;
  activityOpen: boolean;
  browserOpen: boolean;            // LEFT push-dock (sounds + plugins), pull-tab toggled
  browserTab: BrowserTab;
  arrangementToolsOpen: boolean;
  rightOpen: boolean;              // RIGHT push-dock (agent · inspector · collaborators); default open
  railTab: RailTab;
  // Session picker, shown once per app LAUNCH. Module-scope zustand means this lives
  // exactly as long as the React app does — deliberately NOT persisted to localStorage,
  // because a remembered "don't show me again" would silently restore the very behaviour
  // the picker exists to replace (reopening the last edit with no say in it).
  sessionPickerDismissed: boolean;
  // The ruler-drawn time-range span (UIREACH-TIMERANGE) + whether it is still being
  // dragged. Dragging is tracked separately so the action toolbar (TimeRangeBand) can
  // withhold itself while the span is still moving under the pointer, rather than
  // jittering across the screen mid-gesture.
  timeRange: TimeRangeSel | null;
  timeRangeDragging: boolean;

  setSelectedClip: (id: string | null) => void;
  setInspectorTab: (t: InspectorTab) => void;
  setInspectorOpen: (b: boolean) => void;
  setSectionZoom: (z: SectionZoom) => void;
  setActivityOpen: (b: boolean) => void;
  setBrowserOpen: (b: boolean) => void;
  toggleBrowser: () => void;
  openBrowserTab: (t: BrowserTab) => void;  // open the drawer ON a tab (used by "+ plugin")
  toggleArrangementTools: () => void;
  setRightOpen: (b: boolean) => void;
  setRailTab: (t: RailTab) => void;
  openRailTab: (t: RailTab) => void;
  dismissSessionPicker: () => void;
  toggleRight: () => void;
  setTimeRange: (r: TimeRangeSel | null) => void;
  setTimeRangeDragging: (b: boolean) => void;
}

export const useShell = create<ShellState>((set) => ({
  selectedClipId: null,
  inspectorTab: "mix",
  inspectorOpen: false,
  sectionZoom: "16b",
  activityOpen: false,
  browserOpen: false,
  browserTab: "sounds",
  arrangementToolsOpen: false,
  rightOpen: true,
  railTab: "track",
  sessionPickerDismissed: false,
  timeRange: null,
  timeRangeDragging: false,

  // Selecting a clip opens the inspector; deselecting leaves it as-is (the user can
  // pin/close it explicitly). Track selection is NOT here — route it through useStore.
  setSelectedClip: (id) => set(id
    ? { selectedClipId: id, inspectorOpen: true, railTab: "clip", rightOpen: true }
    : { selectedClipId: null }),
  setInspectorTab: (t) => set({ inspectorTab: t }),
  setInspectorOpen: (b) => set({ inspectorOpen: b }),
  setSectionZoom: (z) => set({ sectionZoom: z }),
  setActivityOpen: (b) => set({ activityOpen: b }),
  setBrowserOpen: (b) => set({ browserOpen: b }),
  toggleBrowser: () => set((s) => ({ browserOpen: !s.browserOpen })),
  openBrowserTab: (t) => set({ browserOpen: true, browserTab: t }),
  toggleArrangementTools: () => set((s) => ({ arrangementToolsOpen: !s.arrangementToolsOpen })),
  setRightOpen: (b) => set({ rightOpen: b }),
  setRailTab: (t) => set({ railTab: t }),
  openRailTab: (t) => set({ railTab: t, rightOpen: true }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  dismissSessionPicker: () => set({ sessionPickerDismissed: true }),
  setTimeRange: (r) => set({ timeRange: r }),
  setTimeRangeDragging: (b) => set({ timeRangeDragging: b }),
}));
