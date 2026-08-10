import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipMidi } from "./clipRenderers";

describe("ClipMidi vertical zoom", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fillRect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      scale: vi.fn(), clearRect: vi.fn(), fillRect, globalAlpha: 1, fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const renderAt = (verticalZoom: number) => {
    fillRect.mockClear();
    act(() => root.render(React.createElement(ClipMidi, {
      notes: [
        { i: 0, pitch: 60, start: 0, length: 1, velocity: 100 },
        { i: 1, pitch: 72, start: 1, length: 1, velocity: 100 },
      ],
      width: 200,
      bs: 0.5,
      secToPx: (seconds: number) => seconds * 100,
      verticalZoom,
    })));
    return fillRect.mock.calls.map((call) => Number(call[3]));
  };

  it("makes note rows taller when MIDI-note vertical zoom increases", () => {
    const normalHeights = renderAt(1);
    const zoomedHeights = renderAt(2);

    expect(normalHeights).toHaveLength(2);
    expect(zoomedHeights).toHaveLength(2);
    expect(zoomedHeights[0]).toBeGreaterThan(normalHeights[0]);
    expect(zoomedHeights[1]).toBeGreaterThan(normalHeights[1]);
  });
});
