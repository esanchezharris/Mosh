import { create } from "zustand";
import type { AutomationClipboard } from "./automationEditing";
import {
  clampHorizontalZoom,
  clampVerticalZoom,
  DEFAULT_HORIZONTAL_ZOOM_PRESETS,
} from "./proToolsZoom";
import type { ProToolsIntent, ProToolsTool } from "./smartTool";
import { clampTrackHeightScale } from "./trackHeightZoom";
import type { ProToolsTrackView } from "./trackViews";
import type { TimeRangeSel } from "../v2/shellState";
import type { SpotTimeScale } from "./spotTime";
import {
  clampProToolsUniverseHeight,
  PROTOOLS_UNIVERSE_DEFAULT_HEIGHT,
} from "./proToolsUniverse";

export type ProToolsEditMode = "shuffle" | "slip" | "spot" | "grid";
export type ProToolsRuler = "markers" | "barsBeats" | "timecode" | "minutesSeconds" | "samples";

export type ProToolsMemoryLocationEditor =
  | { readonly mode: "create"; readonly seconds: number }
  | { readonly mode: "edit"; readonly annotationId: string };

export type ProToolsZoomReturnState = {
  readonly activeTool: ProToolsTool;
  readonly smartToolEnabled: boolean;
};

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
  readonly mainTimeScale: SpotTimeScale;
  readonly classicTheme: boolean;
  readonly hoveredIntent: ProToolsIntent | null;
  readonly automationClipboard: AutomationClipboard | null;
  readonly trackViews: Readonly<Record<string, ProToolsTrackView>>;
  readonly automationLanesVisible: Readonly<Record<string, boolean>>;
  readonly horizontalZoomPresets: readonly number[];
  readonly audioWaveformZoom: number;
  readonly midiNoteZoom: number;
  readonly memoryLocationsOpen: boolean;
  readonly memoryLocationEditor: ProToolsMemoryLocationEditor | null;
  readonly singleZoomEnabled: boolean;
  readonly zoomReturnState: ProToolsZoomReturnState | null;
  readonly trackHeightScale: number;
  readonly timelineEditLinked: boolean;
  readonly timelineSelection: TimeRangeSel | null;
  readonly timelineSelectionDragging: boolean;
  readonly trackEditLinked: boolean;
  readonly editSelectionTrackId: string | null;
  readonly editSelectionTrackIds: readonly string[];
  readonly trackSelectionIds: readonly string[];
  readonly universeOpen: boolean;
  readonly universeHeight: number;
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
  readonly setMainTimeScale: (scale: SpotTimeScale) => void;
  readonly toggleClassicTheme: () => void;
  readonly setHoveredIntent: (intent: ProToolsIntent | null) => void;
  readonly setAutomationClipboard: (clipboard: AutomationClipboard) => void;
  readonly setTrackView: (trackId: string, view: ProToolsTrackView) => void;
  readonly toggleAutomationLane: (trackId: string) => void;
  readonly setHorizontalZoomPreset: (index: number, pxPerSec: number) => void;
  readonly setAudioWaveformZoom: (value: number) => void;
  readonly setMidiNoteZoom: (value: number) => void;
  readonly setMemoryLocationsOpen: (open: boolean) => void;
  readonly requestNewMemoryLocation: (seconds: number) => void;
  readonly requestEditMemoryLocation: (annotationId: string) => void;
  readonly closeMemoryLocationEditor: () => void;
  readonly toggleSingleZoom: () => void;
  readonly completeSingleZoom: () => void;
  readonly setTrackHeightScale: (scale: number) => void;
  readonly setTimelineEditLinked: (linked: boolean, editSelection: TimeRangeSel | null) => void;
  readonly setTimelineSelection: (selection: TimeRangeSel | null) => void;
  readonly setTimelineSelectionDragging: (dragging: boolean) => void;
  readonly setTrackEditLinked: (linked: boolean) => void;
  readonly setEditSelectionTrackId: (trackId: string | null) => void;
  readonly setEditSelectionTracks: (trackIds: readonly string[], focusTrackId: string | null) => void;
  readonly setTrackSelectionIds: (trackIds: readonly string[]) => void;
  readonly setUniverseOpen: (open: boolean) => void;
  readonly setUniverseHeight: (height: number) => void;
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
    markers: true,
    barsBeats: true,
    timecode: true,
    minutesSeconds: true,
    samples: true,
  },
  clipListOpen: true,
  nudgeValue: 0.25,
  mainTimeScale: "barsBeats",
  classicTheme: false,
  hoveredIntent: null,
  automationClipboard: null,
  trackViews: {},
  automationLanesVisible: {},
  horizontalZoomPresets: [...DEFAULT_HORIZONTAL_ZOOM_PRESETS],
  audioWaveformZoom: 1,
  midiNoteZoom: 1,
  memoryLocationsOpen: false,
  memoryLocationEditor: null,
  singleZoomEnabled: false,
  zoomReturnState: null,
  trackHeightScale: 1,
  timelineEditLinked: true,
  timelineSelection: null,
  timelineSelectionDragging: false,
  trackEditLinked: true,
  editSelectionTrackId: null,
  editSelectionTrackIds: [],
  trackSelectionIds: [],
  universeOpen: false,
  universeHeight: PROTOOLS_UNIVERSE_DEFAULT_HEIGHT,
});

export const useProTools = create<ProToolsState>((set) => ({
  ...projectDefaults(0),
  setEditMode: (editMode) => set({ editMode }),
  setActiveTool: (activeTool) => set((state) => {
    if (activeTool === "zoomer") {
      if (!state.smartToolEnabled && state.activeTool === "zoomer") return state;
      return {
        activeTool,
        zoomReturnState: {
          activeTool: state.activeTool,
          smartToolEnabled: state.smartToolEnabled,
        },
      };
    }
    return { activeTool, zoomReturnState: null };
  }),
  toggleSmartTool: () => set((state) => ({
    smartToolEnabled: !state.smartToolEnabled,
    ...(!state.smartToolEnabled ? { zoomReturnState: null } : {}),
  })),
  setTabToTransient: (tabToTransient) => set({ tabToTransient }),
  setTrackHeaderWidth: (width) => set({ trackHeaderWidth: Math.min(280, Math.max(128, width)) }),
  toggleRuler: (ruler) => set((state) => ({
    rulersVisible: { ...state.rulersVisible, [ruler]: !state.rulersVisible[ruler] },
  })),
  setClipListOpen: (clipListOpen) => set({ clipListOpen }),
  setNudgeValue: (seconds) => set({ nudgeValue: Math.min(60, Math.max(0.001, seconds)) }),
  setMainTimeScale: (mainTimeScale) => set({ mainTimeScale }),
  toggleClassicTheme: () => set((state) => ({ classicTheme: !state.classicTheme })),
  setHoveredIntent: (hoveredIntent) => set({ hoveredIntent }),
  setAutomationClipboard: (automationClipboard) => set({ automationClipboard }),
  setTrackView: (trackId, view) => set((state) => ({
    trackViews: { ...state.trackViews, [trackId]: view },
  })),
  toggleAutomationLane: (trackId) => set((state) => ({
    automationLanesVisible: {
      ...state.automationLanesVisible,
      [trackId]: !state.automationLanesVisible[trackId],
    },
  })),
  setHorizontalZoomPreset: (index, pxPerSec) => set((state) => {
    if (!Number.isInteger(index) || index < 0 || index >= state.horizontalZoomPresets.length) return state;
    const horizontalZoomPresets = [...state.horizontalZoomPresets];
    horizontalZoomPresets[index] = clampHorizontalZoom(pxPerSec);
    return { horizontalZoomPresets };
  }),
  setAudioWaveformZoom: (value) => set({ audioWaveformZoom: clampVerticalZoom(value) }),
  setMidiNoteZoom: (value) => set({ midiNoteZoom: clampVerticalZoom(value) }),
  setMemoryLocationsOpen: (memoryLocationsOpen) => set({
    memoryLocationsOpen,
    ...(!memoryLocationsOpen ? { memoryLocationEditor: null } : {}),
  }),
  requestNewMemoryLocation: (seconds) => set({
    memoryLocationsOpen: true,
    memoryLocationEditor: {
      mode: "create",
      seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
    },
  }),
  requestEditMemoryLocation: (annotationId) => set({
    memoryLocationsOpen: true,
    memoryLocationEditor: { mode: "edit", annotationId },
  }),
  closeMemoryLocationEditor: () => set({ memoryLocationEditor: null }),
  toggleSingleZoom: () => set((state) => ({ singleZoomEnabled: !state.singleZoomEnabled })),
  completeSingleZoom: () => set((state) => {
    if (!state.singleZoomEnabled || !state.zoomReturnState) return state;
    return {
      activeTool: state.zoomReturnState.activeTool,
      smartToolEnabled: state.zoomReturnState.smartToolEnabled,
      zoomReturnState: null,
    };
  }),
  setTrackHeightScale: (scale) => set({ trackHeightScale: clampTrackHeightScale(scale) }),
  setTimelineEditLinked: (timelineEditLinked, editSelection) => set((state) => ({
    timelineEditLinked,
    timelineSelection: timelineEditLinked ? state.timelineSelection : editSelection,
    timelineSelectionDragging: false,
  })),
  setTimelineSelection: (timelineSelection) => set({ timelineSelection }),
  setTimelineSelectionDragging: (timelineSelectionDragging) => set({ timelineSelectionDragging }),
  setTrackEditLinked: (trackEditLinked) => set({ trackEditLinked }),
  setEditSelectionTrackId: (editSelectionTrackId) => set({
    editSelectionTrackId,
    editSelectionTrackIds: editSelectionTrackId ? [editSelectionTrackId] : [],
  }),
  setEditSelectionTracks: (editSelectionTrackIds, editSelectionTrackId) => set({
    editSelectionTrackId,
    editSelectionTrackIds: [...editSelectionTrackIds],
  }),
  setTrackSelectionIds: (trackSelectionIds) => set({ trackSelectionIds: [...trackSelectionIds] }),
  setUniverseOpen: (universeOpen) => set({ universeOpen }),
  setUniverseHeight: (height) => set({ universeHeight: clampProToolsUniverseHeight(height) }),
  resetForProject: (nextEpoch) => set((state) => {
    if (nextEpoch !== undefined && nextEpoch === state.projectEpoch) return state;
    return projectDefaults(nextEpoch ?? state.projectEpoch);
  }),
}));
