import type { AutomationClipboard } from "./automationEditing";
import { DEFAULT_HORIZONTAL_ZOOM_PRESETS } from "./proToolsZoom";
import type { ProToolsIntent, ProToolsTool } from "./smartTool";
import type { ProToolsTrackView } from "./trackViews";
import type { ProToolsTrackVisibility } from "./proToolsTrackVisibility";
import type { TimeRangeSel } from "../v2/shellState";
import type { SpotTimeScale } from "./spotTime";
import { PROTOOLS_UNIVERSE_DEFAULT_HEIGHT } from "./proToolsUniverse";
import type { ProToolsAutomationTargetId } from "./sendAutomationTargets";

export type ProToolsEditMode = "shuffle" | "slip" | "spot" | "grid";
export type ProToolsMainWindow = "edit" | "mix";
export type ProToolsRuler = "markers" | "barsBeats" | "timecode" | "minutesSeconds" | "samples";

export type ProToolsMemoryLocationEditor =
  | { readonly mode: "create"; readonly seconds: number }
  | { readonly mode: "edit"; readonly annotationId: string };

export type ProToolsZoomReturnState = {
  readonly activeTool: ProToolsTool;
  readonly smartToolEnabled: boolean;
};

export type ProToolsRulersVisible = Readonly<Record<ProToolsRuler, boolean>>;

export type ProToolsViewState = {
  readonly projectEpoch: number;
  readonly mainWindow: ProToolsMainWindow;
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
  readonly automationTargets: Readonly<Record<string, ProToolsAutomationTargetId>>;
  readonly trackVisibility: ProToolsTrackVisibility;
  readonly previousTrackVisibility: ProToolsTrackVisibility | null;
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
  readonly trackGroupDialogOpen: boolean;
  readonly universeOpen: boolean;
  readonly universeHeight: number;
};

export const proToolsProjectDefaults = (projectEpoch: number): ProToolsViewState => ({
  projectEpoch,
  mainWindow: "edit",
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
  automationTargets: {},
  trackVisibility: {},
  previousTrackVisibility: null,
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
  trackGroupDialogOpen: false,
  universeOpen: false,
  universeHeight: PROTOOLS_UNIVERSE_DEFAULT_HEIGHT,
});
