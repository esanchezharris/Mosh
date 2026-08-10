import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult } from "../types";
import { useProTools } from "./proToolsState";
import {
  scopeProToolsEditSelectionToTracks,
  selectProToolsTrack,
  toggleProToolsTrackEditLink,
} from "./proToolsTrackEditSelection";

describe("Pro Tools multi-track Edit association", () => {
  const originalExec = useStore.getState().exec;
  const exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));

  beforeEach(() => {
    exec.mockReset();
    useProTools.getState().resetForProject();
    useStore.setState({ selectedTrackId: null, exec });
  });

  afterEach(() => {
    useStore.setState({ selectedTrackId: null, exec: originalExec });
  });

  it("associates an ordered vertical range with every linked track", () => {
    // Given the default linked Track/Edit state.
    expect(useProTools.getState().trackEditLinked).toBe(true);

    // When a Vocal-to-Keys vertical Edit range is established.
    scopeProToolsEditSelectionToTracks(["vocal", "double", "keys"], "keys");

    // Then both selection sets match and the focus lane owns the active inspector.
    expect(useProTools.getState().editSelectionTrackIds).toEqual(["vocal", "double", "keys"]);
    expect(useProTools.getState().trackSelectionIds).toEqual(["vocal", "double", "keys"]);
    expect(useProTools.getState().editSelectionTrackId).toBe("keys");
    expect(useStore.getState().selectedTrackId).toBe("keys");
    expect(exec).not.toHaveBeenCalled();
  });

  it("preserves both multi-track sets when Track/Edit is unlinked", () => {
    // Given a linked two-track Edit range.
    useProTools.setState({
      editSelectionTrackId: "keys",
      editSelectionTrackIds: ["double", "keys"],
      trackSelectionIds: ["double", "keys"],
    });
    useStore.setState({ selectedTrackId: "keys" });

    // When Track/Edit is disabled.
    toggleProToolsTrackEditLink();

    // Then neither selection set collapses or mutates the project.
    expect(useProTools.getState().trackEditLinked).toBe(false);
    expect(useProTools.getState().editSelectionTrackIds).toEqual(["double", "keys"]);
    expect(useProTools.getState().trackSelectionIds).toEqual(["double", "keys"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("lets Track selection diverge from a retained multi-track Edit range", () => {
    // Given Track/Edit is disabled with an Edit range on two tracks.
    useProTools.setState({
      trackEditLinked: false,
      editSelectionTrackId: "keys",
      editSelectionTrackIds: ["double", "keys"],
      trackSelectionIds: ["double", "keys"],
    });

    // When a different track header is selected.
    selectProToolsTrack("drums");

    // Then only Track selection changes and the Edit ownership is retained.
    expect(useProTools.getState().editSelectionTrackIds).toEqual(["double", "keys"]);
    expect(useProTools.getState().trackSelectionIds).toEqual(["drums"]);
    expect(useStore.getState().selectedTrackId).toBe("drums");
    expect(exec).not.toHaveBeenCalled();
  });

  it("restores the complete Edit-track set when Track/Edit is relinked", () => {
    // Given Track and Edit selections have diverged.
    useProTools.setState({
      trackEditLinked: false,
      editSelectionTrackId: "keys",
      editSelectionTrackIds: ["double", "keys"],
      trackSelectionIds: ["drums"],
    });
    useStore.setState({ selectedTrackId: "drums" });

    // When Track/Edit is enabled again.
    toggleProToolsTrackEditLink();

    // Then Track selection rejoins every Edit track and focus returns to Keys.
    expect(useProTools.getState().trackEditLinked).toBe(true);
    expect(useProTools.getState().trackSelectionIds).toEqual(["double", "keys"]);
    expect(useStore.getState().selectedTrackId).toBe("keys");
    expect(exec).not.toHaveBeenCalled();
  });
});
