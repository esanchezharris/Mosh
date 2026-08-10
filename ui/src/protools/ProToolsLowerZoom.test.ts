import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { ProToolsLowerZoom } from "./ProToolsLowerZoom";
import { useProTools } from "./proToolsState";

describe("Pro Tools lower timeline zoom controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let projectEpoch = 109;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    projectEpoch += 1;
    useStore.setState({ pxPerSec: 80, projectEpoch, exec: vi.fn() });
    useProTools.getState().resetForProject(projectEpoch);
    act(() => root.render(React.createElement(ProToolsLowerZoom)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ pxPerSec: originalState.pxPerSec, exec: originalState.exec });
  });

  it("steps the timeline scale in both directions without a project command", () => {
    const zoomIn = host.querySelector<HTMLButtonElement>("[data-testid=pt-lower-zoom-in]");
    const zoomOut = host.querySelector<HTMLButtonElement>("[data-testid=pt-lower-zoom-out]");
    if (!zoomIn || !zoomOut) throw new Error("lower zoom buttons are missing");

    act(() => zoomIn.click());
    expect(useStore.getState().pxPerSec).toBe(112);
    act(() => zoomOut.click());
    expect(useStore.getState().pxPerSec).toBe(80);
    expect(useStore.getState().exec).not.toHaveBeenCalled();
  });

  it("steps proportional track height in both directions without a project command", () => {
    const zoomIn = host.querySelector<HTMLButtonElement>("[data-testid=pt-lower-track-height-in]");
    const zoomOut = host.querySelector<HTMLButtonElement>("[data-testid=pt-lower-track-height-out]");
    if (!zoomIn || !zoomOut) throw new Error("track-height buttons are missing");

    act(() => zoomOut.click());
    expect(useProTools.getState().trackHeightScale).toBe(0.75);
    act(() => zoomIn.click());
    expect(useProTools.getState().trackHeightScale).toBe(1);
    expect(useStore.getState().exec).not.toHaveBeenCalled();
  });
});
