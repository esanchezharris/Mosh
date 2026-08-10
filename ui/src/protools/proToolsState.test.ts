import { beforeEach, describe, expect, it } from "vitest";
import { useProTools } from "./proToolsState";
import { DEFAULT_HORIZONTAL_ZOOM_PRESETS } from "./proToolsZoom";

describe("Pro Tools shell state", () => {
  let projectEpoch = 0;

  beforeEach(() => {
    projectEpoch += 1;
    useProTools.getState().resetForProject(projectEpoch);
  });

  it("starts each project with the Edit Window defaults", () => {
    const state = useProTools.getState();

    expect({
      editMode: state.editMode,
      activeTool: state.activeTool,
      smartToolEnabled: state.smartToolEnabled,
      tabToTransient: state.tabToTransient,
      trackHeaderWidth: state.trackHeaderWidth,
      rulersVisible: state.rulersVisible,
      clipListOpen: state.clipListOpen,
      nudgeValue: state.nudgeValue,
      mainTimeScale: state.mainTimeScale,
      classicTheme: state.classicTheme,
      automationClipboard: state.automationClipboard,
      trackViews: state.trackViews,
      automationLanesVisible: state.automationLanesVisible,
      horizontalZoomPresets: state.horizontalZoomPresets,
      audioWaveformZoom: state.audioWaveformZoom,
      midiNoteZoom: state.midiNoteZoom,
      memoryLocationsOpen: state.memoryLocationsOpen,
      memoryLocationEditor: state.memoryLocationEditor,
      singleZoomEnabled: state.singleZoomEnabled,
      zoomReturnState: state.zoomReturnState,
      trackHeightScale: state.trackHeightScale,
      timelineEditLinked: state.timelineEditLinked,
      timelineSelection: state.timelineSelection,
      timelineSelectionDragging: state.timelineSelectionDragging,
    }).toEqual({
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
        markers: true,
      },
      clipListOpen: true,
      nudgeValue: 0.25,
      mainTimeScale: "barsBeats",
      classicTheme: false,
      automationClipboard: null,
      trackViews: {},
      automationLanesVisible: {},
      horizontalZoomPresets: DEFAULT_HORIZONTAL_ZOOM_PRESETS,
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
    });
  });

  it("clones the Edit span when Timeline and Edit selections are unlinked", () => {
    // Given a linked Edit selection.
    const editSelection = { start: 2, end: 6 };

    // When the producer unlinks Timeline playback.
    useProTools.getState().setTimelineEditLinked(false, editSelection);

    // Then the independent Timeline starts from the same range.
    expect(useProTools.getState().timelineEditLinked).toBe(false);
    expect(useProTools.getState().timelineSelection).toEqual(editSelection);
    expect(useProTools.getState().timelineSelectionDragging).toBe(false);
  });

  it("preserves an unlinked Timeline span when the current project resets idempotently", () => {
    // Given an independent Timeline range in the current project.
    const state = useProTools.getState();
    state.setTimelineEditLinked(false, { start: 2, end: 6 });
    state.setTimelineSelection({ start: 8, end: 12 });
    state.setTimelineSelectionDragging(true);

    // When the same project epoch is observed again.
    state.resetForProject(projectEpoch);

    // Then its view state is preserved.
    expect(useProTools.getState().timelineSelection).toEqual({ start: 8, end: 12 });
    expect(useProTools.getState().timelineSelectionDragging).toBe(true);
  });

  it("restores linked Timeline selection defaults when the project changes", () => {
    // Given an independent Timeline range in the current project.
    const state = useProTools.getState();
    state.setTimelineEditLinked(false, { start: 2, end: 6 });
    state.setTimelineSelection({ start: 8, end: 12 });
    state.setTimelineSelectionDragging(true);

    // When a replacement project epoch arrives.
    state.resetForProject(projectEpoch + 1);

    // Then the new project starts linked with no stale range.
    expect(useProTools.getState().timelineEditLinked).toBe(true);
    expect(useProTools.getState().timelineSelection).toBeNull();
    expect(useProTools.getState().timelineSelectionDragging).toBe(false);
  });

  it("keeps the Memory Locations window and editor project-scoped", () => {
    const state = useProTools.getState();
    state.setMemoryLocationsOpen(true);
    state.requestNewMemoryLocation(3.5);

    expect(useProTools.getState().memoryLocationsOpen).toBe(true);
    expect(useProTools.getState().memoryLocationEditor).toEqual({ mode: "create", seconds: 3.5 });

    useProTools.getState().requestEditMemoryLocation("marker-1");
    expect(useProTools.getState().memoryLocationEditor).toEqual({
      mode: "edit",
      annotationId: "marker-1",
    });
    useProTools.getState().closeMemoryLocationEditor();
    expect(useProTools.getState().memoryLocationEditor).toBeNull();

    state.resetForProject(projectEpoch + 1);
    expect(useProTools.getState().memoryLocationsOpen).toBe(false);
    expect(useProTools.getState().memoryLocationEditor).toBeNull();
  });

  it("keeps media zoom independent and project-scoped", () => {
    const state = useProTools.getState();
    state.setAudioWaveformZoom(3);
    state.setMidiNoteZoom(0.5);

    expect(useProTools.getState().audioWaveformZoom).toBe(3);
    expect(useProTools.getState().midiNoteZoom).toBe(0.5);

    state.resetForProject(projectEpoch);
    expect(useProTools.getState().audioWaveformZoom).toBe(3);
    expect(useProTools.getState().midiNoteZoom).toBe(0.5);

    state.resetForProject(projectEpoch + 1);
    expect(useProTools.getState().audioWaveformZoom).toBe(1);
    expect(useProTools.getState().midiNoteZoom).toBe(1);
  });

  it("returns Single Zoom to the previously selected Smart Tool state", () => {
    const state = useProTools.getState();
    state.setActiveTool("zoomer");
    state.toggleSmartTool();
    state.toggleSingleZoom();

    expect(useProTools.getState().singleZoomEnabled).toBe(true);
    expect(useProTools.getState().activeTool).toBe("zoomer");
    expect(useProTools.getState().smartToolEnabled).toBe(false);

    useProTools.getState().completeSingleZoom();
    expect(useProTools.getState().activeTool).toBe("selector");
    expect(useProTools.getState().smartToolEnabled).toBe(true);
    expect(useProTools.getState().zoomReturnState).toBeNull();
  });

  it("keeps proportional track height project-scoped", () => {
    const state = useProTools.getState();
    state.setTrackHeightScale(1.25);
    expect(useProTools.getState().trackHeightScale).toBe(1.25);

    state.resetForProject(projectEpoch);
    expect(useProTools.getState().trackHeightScale).toBe(1.25);
    state.resetForProject(projectEpoch + 1);
    expect(useProTools.getState().trackHeightScale).toBe(1);
  });

  it("clamps track-header resizing at both supported boundaries", () => {
    const state = useProTools.getState();

    state.setTrackHeaderWidth(96);
    expect(useProTools.getState().trackHeaderWidth).toBe(128);

    state.setTrackHeaderWidth(512);
    expect(useProTools.getState().trackHeaderWidth).toBe(280);
  });

  it("toggles independent ruler, list, transient, Smart Tool, and theme controls", () => {
    const state = useProTools.getState();

    state.toggleRuler("timecode");
    state.setClipListOpen(false);
    state.setTabToTransient(false);
    state.toggleSmartTool();
    state.toggleClassicTheme();

    const next = useProTools.getState();
    expect(next.rulersVisible.timecode).toBe(false);
    expect(next.rulersVisible.barsBeats).toBe(true);
    expect(next.clipListOpen).toBe(false);
    expect(next.tabToTransient).toBe(false);
    expect(next.smartToolEnabled).toBe(false);
    expect(next.classicTheme).toBe(true);
  });

  it("restores project-scoped controls only when the project epoch changes", () => {
    const state = useProTools.getState();
    state.setEditMode("grid");
    state.setTrackHeaderWidth(240);
    state.setMainTimeScale("samples");

    state.resetForProject(projectEpoch);
    expect(useProTools.getState().editMode).toBe("grid");
    expect(useProTools.getState().mainTimeScale).toBe("samples");

    state.resetForProject(projectEpoch + 1);
    expect(useProTools.getState().editMode).toBe("slip");
    expect(useProTools.getState().trackHeaderWidth).toBe(160);
    expect(useProTools.getState().mainTimeScale).toBe("barsBeats");
  });

  it("keeps the automation clipboard within one project epoch", () => {
    const clipboard = {
      duration: 3,
      sourceParamName: "Level",
      points: [{ t: 0.5, v: 0.2 }, { t: 2.5, v: 0.7 }],
    };

    useProTools.getState().setAutomationClipboard(clipboard);
    expect(useProTools.getState().automationClipboard).toEqual(clipboard);

    useProTools.getState().resetForProject(projectEpoch);
    expect(useProTools.getState().automationClipboard).toEqual(clipboard);

    useProTools.getState().resetForProject(projectEpoch + 1);
    expect(useProTools.getState().automationClipboard).toBeNull();
  });

  it("keeps Track Views project-scoped and independent per track", () => {
    const state = useProTools.getState();

    state.setTrackView("audio-1", "volume");
    state.setTrackView("midi-1", "notes");
    state.toggleAutomationLane("audio-1");

    expect(useProTools.getState().trackViews).toEqual({
      "audio-1": "volume",
      "midi-1": "notes",
    });
    expect(useProTools.getState().automationLanesVisible).toEqual({ "audio-1": true });

    state.resetForProject(projectEpoch);
    expect(useProTools.getState().trackViews).toEqual({
      "audio-1": "volume",
      "midi-1": "notes",
    });

    state.resetForProject(projectEpoch + 1);
    expect(useProTools.getState().trackViews).toEqual({});
    expect(useProTools.getState().automationLanesVisible).toEqual({});
  });
});
