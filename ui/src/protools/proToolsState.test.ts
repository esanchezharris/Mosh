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
      classicTheme: state.classicTheme,
      automationClipboard: state.automationClipboard,
      trackViews: state.trackViews,
      automationLanesVisible: state.automationLanesVisible,
      horizontalZoomPresets: state.horizontalZoomPresets,
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
      },
      clipListOpen: true,
      nudgeValue: 0.25,
      classicTheme: false,
      automationClipboard: null,
      trackViews: {},
      automationLanesVisible: {},
      horizontalZoomPresets: DEFAULT_HORIZONTAL_ZOOM_PRESETS,
    });
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

    state.resetForProject(projectEpoch);
    expect(useProTools.getState().editMode).toBe("grid");

    state.resetForProject(projectEpoch + 1);
    expect(useProTools.getState().editMode).toBe("slip");
    expect(useProTools.getState().trackHeaderWidth).toBe(160);
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
