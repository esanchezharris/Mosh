import { beforeEach, describe, expect, it } from "vitest";
import { useProTools } from "./proToolsState";

describe("Pro Tools Track List view state", () => {
  let projectEpoch = 400;

  beforeEach(() => {
    projectEpoch += 1;
    useProTools.getState().resetForProject(projectEpoch);
  });

  it("keeps shown-track choices within one project epoch", () => {
    // Given every session track is shown by default.
    const state = useProTools.getState();
    expect(state.trackVisibility).toEqual({});

    // When one track is hidden in the current Edit Window.
    state.setTrackShown("bass-1", false);

    // Then the choice survives an idempotent reset but not a replacement project.
    expect(useProTools.getState().trackVisibility).toEqual({ "bass-1": false });
    state.resetForProject(projectEpoch);
    expect(useProTools.getState().trackVisibility).toEqual({ "bass-1": false });
    state.resetForProject(projectEpoch + 1);
    expect(useProTools.getState().trackVisibility).toEqual({});
  });

  it("keeps one exact restore point for a Show Only track filter", () => {
    // Given Bass was hidden before a Show Only filter is applied.
    const trackIds = ["vocal-1", "bass-1", "keys-1"];
    const state = useProTools.getState();
    state.setTrackShown("bass-1", false);

    // When Keys becomes the only shown track and the previous view is restored.
    state.showOnlyTrackIds(trackIds, ["keys-1"]);
    expect(useProTools.getState().trackVisibility)
      .toEqual({ "vocal-1": false, "bass-1": false });
    state.restorePreviouslyShownTracks();

    // Then the exact earlier view returns and the one-level restore point is consumed.
    expect(useProTools.getState().trackVisibility).toEqual({ "bass-1": false });
    expect(useProTools.getState().previousTrackVisibility).toBeNull();
    state.restorePreviouslyShownTracks();
    expect(useProTools.getState().trackVisibility).toEqual({ "bass-1": false });
  });

  it("invalidates a pending visibility restore when the project changes", () => {
    // Given this project has captured a visibility restore point.
    const state = useProTools.getState();
    state.showOnlyTrackIds(["vocal-1", "bass-1"], ["vocal-1"]);
    expect(useProTools.getState().previousTrackVisibility).toEqual({});

    // When a replacement project arrives.
    state.resetForProject(projectEpoch + 1);

    // Then neither the filtered view nor its restore point crosses the epoch boundary.
    expect(useProTools.getState().trackVisibility).toEqual({});
    expect(useProTools.getState().previousTrackVisibility).toBeNull();
  });
});
