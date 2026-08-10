import { create } from "zustand";
import type { AutomationClipboard } from "./automationEditing";
import type { ProToolsIntent, ProToolsTool } from "./smartTool";

export type ProToolsEditMode = "shuffle" | "slip" | "spot" | "grid";
export type ProToolsRuler = "barsBeats" | "timecode" | "minutesSeconds" | "samples";

export type ProToolsRulersVisible = Readonly<Record<ProToolsRuler, boolean>>;

type ProToolsViewState = {
  readonly projectEpoch: number;
  readonly editMode: ProToolsEditMode;
  readonly activeTool: ProToolsTool;
  readonly smartToolEnabled: boolean;
  readonly tabToTransient: boolean;
  readonly trackHeaderWidth: number;
  readonly rulersVisible: ProToolsRulersVisible;
  readonly clipListOpen: boolean;
  readonly nudgeValue: number;
  readonly classicTheme: boolean;
  readonly hoveredIntent: ProToolsIntent | null;
  readonly automationClipboard: AutomationClipboard | null;
};

type ProToolsActions = {
  readonly setEditMode: (mode: ProToolsEditMode) => void;
  readonly setActiveTool: (tool: ProToolsTool) => void;
  readonly toggleSmartTool: () => void;
  readonly setTabToTransient: (enabled: boolean) => void;
  readonly setTrackHeaderWidth: (width: number) => void;
  readonly toggleRuler: (ruler: ProToolsRuler) => void;
  readonly setClipListOpen: (open: boolean) => void;
  readonly setNudgeValue: (seconds: number) => void;
  readonly toggleClassicTheme: () => void;
  readonly setHoveredIntent: (intent: ProToolsIntent | null) => void;
  readonly setAutomationClipboard: (clipboard: AutomationClipboard) => void;
  readonly resetForProject: (projectEpoch?: number) => void;
};

export type ProToolsState = ProToolsViewState & ProToolsActions;

const projectDefaults = (projectEpoch: number): ProToolsViewState => ({
  projectEpoch,
  editMode: "slip",
  activeTool: "selector",
  smartToolEnabled: true,
  tabToTransient: true,
  trackHeaderWidth: 160,
  rulersVisible: {
    barsBeats: true,
    timecode: true,
    minutesSeconds: true,
    samples: true,
  },
  clipListOpen: true,
  nudgeValue: 0.25,
  classicTheme: false,
  hoveredIntent: null,
  automationClipboard: null,
});

export const useProTools = create<ProToolsState>((set) => ({
  ...projectDefaults(0),
  setEditMode: (editMode) => set({ editMode }),
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleSmartTool: () => set((state) => ({ smartToolEnabled: !state.smartToolEnabled })),
  setTabToTransient: (tabToTransient) => set({ tabToTransient }),
  setTrackHeaderWidth: (width) => set({ trackHeaderWidth: Math.min(280, Math.max(128, width)) }),
  toggleRuler: (ruler) => set((state) => ({
    rulersVisible: { ...state.rulersVisible, [ruler]: !state.rulersVisible[ruler] },
  })),
  setClipListOpen: (clipListOpen) => set({ clipListOpen }),
  setNudgeValue: (seconds) => set({ nudgeValue: Math.min(60, Math.max(0.001, seconds)) }),
  toggleClassicTheme: () => set((state) => ({ classicTheme: !state.classicTheme })),
  setHoveredIntent: (hoveredIntent) => set({ hoveredIntent }),
  setAutomationClipboard: (automationClipboard) => set({ automationClipboard }),
  resetForProject: (nextEpoch) => set((state) => {
    if (nextEpoch !== undefined && nextEpoch === state.projectEpoch) return state;
    return projectDefaults(nextEpoch ?? state.projectEpoch);
  }),
}));
