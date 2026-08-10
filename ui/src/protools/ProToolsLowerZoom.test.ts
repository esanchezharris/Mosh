import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { ProToolsLowerZoom } from "./ProToolsLowerZoom";

describe("Pro Tools lower timeline zoom controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({ pxPerSec: 80, projectEpoch: 110, exec: vi.fn() });
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
});
