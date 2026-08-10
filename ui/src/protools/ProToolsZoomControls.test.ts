import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { useProTools } from "./proToolsState";
import {
  DEFAULT_HORIZONTAL_ZOOM_PRESETS,
  nextHorizontalZoom,
  nextVerticalZoom,
} from "./proToolsZoom";
import { ProToolsZoomControls } from "./ProToolsZoomControls";

describe("Pro Tools horizontal zoom controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalPxPerSec = useStore.getState().pxPerSec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({ pxPerSec: 80, projectEpoch: 91 });
    useProTools.getState().resetForProject(91);
    act(() => root.render(React.createElement(ProToolsZoomControls)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelector(".pt-test-zoom-timeline")?.remove();
    useStore.setState({ pxPerSec: originalPxPerSec });
  });

  it("steps through bounded horizontal zoom levels", () => {
    expect(nextHorizontalZoom(80, 1)).toBe(112);
    expect(nextHorizontalZoom(80, -1)).toBe(56);
    expect(nextHorizontalZoom(400, 1)).toBe(400);
    expect(nextHorizontalZoom(20, -1)).toBe(20);
  });

  it("steps through bounded vertical zoom levels", () => {
    expect(nextVerticalZoom(1, 1)).toBe(1.5);
    expect(nextVerticalZoom(1, -1)).toBe(0.75);
    expect(nextVerticalZoom(4, 1)).toBe(4);
    expect(nextVerticalZoom(0.5, -1)).toBe(0.5);
  });

  it("changes audio-waveform and MIDI-note zoom independently", () => {
    const audioIn = host.querySelector<HTMLButtonElement>("[data-testid=pt-waveform-zoom-in]");
    const midiOut = host.querySelector<HTMLButtonElement>("[data-testid=pt-midi-zoom-out]");
    if (!audioIn || !midiOut) throw new Error("vertical zoom controls are missing");

    act(() => audioIn.click());
    expect(useProTools.getState().audioWaveformZoom).toBe(1.5);
    expect(useProTools.getState().midiNoteZoom).toBe(1);

    act(() => midiOut.click());
    expect(useProTools.getState().audioWaveformZoom).toBe(1.5);
    expect(useProTools.getState().midiNoteZoom).toBe(0.75);
  });

  it("exposes Single Zoom as project-scoped tool behavior without changing project data", () => {
    const single = host.querySelector<HTMLButtonElement>("[data-testid=pt-single-zoom]");
    if (!single) throw new Error("Single Zoom control is missing");

    act(() => single.click());

    expect(single.getAttribute("aria-pressed")).toBe("true");
    expect(useProTools.getState().singleZoomEnabled).toBe(true);
    act(() => useProTools.getState().resetForProject(92));
    expect(useProTools.getState().singleZoomEnabled).toBe(false);
  });

  it("zooms with the cluster buttons and recalls presets", () => {
    const zoomIn = host.querySelector<HTMLButtonElement>("[data-testid=pt-zoom-in]");
    const presetFive = host.querySelector<HTMLButtonElement>("[data-testid=pt-zoom-preset-5]");
    if (!zoomIn || !presetFive) throw new Error("zoom controls are missing");

    act(() => zoomIn.click());
    expect(useStore.getState().pxPerSec).toBe(112);

    act(() => presetFive.click());
    expect(useStore.getState().pxPerSec).toBe(DEFAULT_HORIZONTAL_ZOOM_PRESETS[4]);
  });

  it("preserves the time at the viewport center while zooming", async () => {
    const timeline = document.createElement("div");
    timeline.className = "pt-timeline-scroll pt-test-zoom-timeline";
    Object.defineProperty(timeline, "clientWidth", { configurable: true, value: 400 });
    timeline.getBoundingClientRect = () => ({
      left: 100, top: 0, right: 500, bottom: 200, width: 400, height: 200, x: 100, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    timeline.scrollLeft = 200;
    document.body.appendChild(timeline);
    const zoomIn = host.querySelector<HTMLButtonElement>("[data-testid=pt-zoom-in]");
    if (!zoomIn) throw new Error("zoom-in control is missing");

    act(() => zoomIn.click());

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(timeline.scrollLeft).toBe(360);
  });

  it("preserves the same center across two zoom steps before the next frame", async () => {
    const timeline = document.createElement("div");
    timeline.className = "pt-timeline-scroll pt-test-zoom-timeline";
    Object.defineProperty(timeline, "clientWidth", { configurable: true, value: 400 });
    timeline.getBoundingClientRect = () => ({
      left: 100, top: 0, right: 500, bottom: 200, width: 400, height: 200, x: 100, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    timeline.scrollLeft = 200;
    document.body.appendChild(timeline);
    const zoomIn = host.querySelector<HTMLButtonElement>("[data-testid=pt-zoom-in]");
    if (!zoomIn) throw new Error("zoom-in control is missing");

    act(() => { zoomIn.click(); zoomIn.click(); });

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(useStore.getState().pxPerSec).toBe(160);
    expect(timeline.scrollLeft).toBe(600);
  });

  it("stores the current zoom in a preset with Command-click and resets it by project", () => {
    act(() => useStore.setState({ pxPerSec: 224 }));
    const presetTwo = host.querySelector<HTMLButtonElement>("[data-testid=pt-zoom-preset-2]");
    if (!presetTwo) throw new Error("zoom preset is missing");

    act(() => presetTwo.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    })));
    expect(useProTools.getState().horizontalZoomPresets[1]).toBe(224);
    expect(useStore.getState().pxPerSec).toBe(224);

    act(() => useProTools.getState().resetForProject(92));
    expect(useProTools.getState().horizontalZoomPresets).toEqual(DEFAULT_HORIZONTAL_ZOOM_PRESETS);
  });
});
