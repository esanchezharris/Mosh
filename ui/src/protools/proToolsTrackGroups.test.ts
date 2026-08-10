import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { useProTools } from "./proToolsState";
import {
  handleProToolsTrackGroupShortcut,
  proToolsEditGroupSelection,
  proToolsMixGroupTrackIds,
  selectProToolsTrackGroup,
} from "./proToolsTrackGroups";

const originalStore = useStore.getState();
const originalProTools = useProTools.getState();

describe("Pro Tools Edit and Mix Track Groups", () => {
  let project: Snapshot;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    __resetMockForTests();
    project = await mockSnapshot<Snapshot>();
    const [drums, bass, keys] = project.tracks;
    if (!drums || !bass || !keys) throw new Error("track-group fixtures are missing");
    project.trackGroups = [
      { id: "edit-1", name: "Rhythm Edit", trackIds: [drums.id, bass.id], kind: "edit", enabled: true },
      { id: "mix-1", name: "Rhythm Mix", trackIds: [drums.id, bass.id], kind: "mix", enabled: true },
      { id: "mix-2", name: "Band Mix", trackIds: [bass.id, keys.id], kind: "edit_mix", enabled: true },
    ];
    project.trackGroupsSuspended = false;
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: project, selectedTrackId: drums.id, exec });
    useProTools.setState({ trackSelectionIds: [drums.id], trackGroupDialogOpen: false });
  });

  afterEach(() => {
    useStore.setState({
      snapshot: originalStore.snapshot,
      selectedTrackId: originalStore.selectedTrackId,
      exec: originalStore.exec,
    });
    useProTools.setState({
      trackSelectionIds: originalProTools.trackSelectionIds,
      trackGroupDialogOpen: originalProTools.trackGroupDialogOpen,
    });
  });

  it("expands enabled Edit groups in visible track order", () => {
    const [drums, bass, keys] = project.tracks;
    if (!drums || !bass || !keys) throw new Error("track-group fixtures are missing");

    expect(proToolsEditGroupSelection(project, [drums.id])).toEqual([drums.id, bass.id, keys.id]);
    expect(proToolsEditGroupSelection(project, [keys.id])).toEqual([drums.id, bass.id, keys.id]);
  });

  it("resolves overlapping Mix groups transitively and bypasses them while suspended", () => {
    const [drums, bass, keys] = project.tracks;
    if (!drums || !bass || !keys) throw new Error("track-group fixtures are missing");

    expect(proToolsMixGroupTrackIds(project, drums.id)).toEqual([drums.id, bass.id, keys.id]);
    project.trackGroupsSuspended = true;
    expect(proToolsMixGroupTrackIds(project, drums.id)).toEqual([drums.id]);
    expect(proToolsEditGroupSelection(project, [drums.id])).toEqual([drums.id]);
  });

  it("does not link through a disabled group", () => {
    const [drums, bass, keys] = project.tracks;
    if (!drums || !bass || !keys) throw new Error("track-group fixtures are missing");
    const bridge = project.trackGroups?.find((group) => group.id === "mix-2");
    if (!bridge) throw new Error("overlapping Track Group is missing");
    bridge.enabled = false;

    expect(proToolsMixGroupTrackIds(project, drums.id)).toEqual([drums.id, bass.id]);
    expect(proToolsEditGroupSelection(project, [keys.id])).toEqual([keys.id]);
  });

  it("filters Mix linkage by the selected supported attribute", () => {
    const [drums, bass, keys] = project.tracks;
    if (!drums || !bass || !keys) throw new Error("track-group fixtures are missing");
    project.trackGroups = [{
      id: "mix-attrs",
      name: "Control Link",
      trackIds: [drums.id, bass.id],
      kind: "mix",
      enabled: true,
      mixAttributes: ["main_mute", "record_enable"],
    }];

    expect(proToolsMixGroupTrackIds(project, drums.id, "main_volume")).toEqual([drums.id]);
    expect(proToolsMixGroupTrackIds(project, drums.id, "main_mute")).toEqual([drums.id, bass.id]);
    expect(proToolsMixGroupTrackIds(project, drums.id, "record_enable")).toEqual([drums.id, bass.id]);
    expect(proToolsMixGroupTrackIds(project, drums.id, "input_monitoring")).toEqual([drums.id]);
  });

  it("maps Command or Control G to the Track Group dialog without a routing command", () => {
    const event = new KeyboardEvent("keydown", {
      key: "g",
      code: "KeyG",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(handleProToolsTrackGroupShortcut(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(useProTools.getState().trackGroupDialogOpen).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("selects exact group members and associates the retained Edit span only while linked", () => {
    const [drums, bass, keys] = project.tracks;
    if (!drums || !bass || !keys) throw new Error("track-group fixtures are missing");
    useProTools.setState({
      trackEditLinked: true,
      editSelectionTrackId: keys.id,
      editSelectionTrackIds: [keys.id],
      trackSelectionIds: [keys.id],
    });

    selectProToolsTrackGroup(project, [drums.id, bass.id]);
    expect(useProTools.getState().trackSelectionIds).toEqual([drums.id, bass.id]);
    expect(useProTools.getState().editSelectionTrackIds).toEqual([drums.id, bass.id]);
    expect(useStore.getState().selectedTrackId).toBe(bass.id);
    expect(exec).not.toHaveBeenCalled();

    useProTools.setState({
      trackEditLinked: false,
      editSelectionTrackId: keys.id,
      editSelectionTrackIds: [keys.id],
    });
    selectProToolsTrackGroup(project, [drums.id]);
    expect(useProTools.getState().trackSelectionIds).toEqual([drums.id]);
    expect(useProTools.getState().editSelectionTrackIds).toEqual([keys.id]);
  });
});
