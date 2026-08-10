import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipWave } from "./clipRenderers";

describe("ClipWave amplitude mapping", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fillRect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(4);
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

  it("scales each waveform column with the shell-provided amplitude", () => {
    const amplitudeAt = vi.fn((ratio: number) => ratio < 0.5 ? 0.5 : 1);
    act(() => root.render(React.createElement(ClipWave, {
      peaks: [[-1, 1], [-1, 1], [-1, 1], [-1, 1]],
      width: 4,
      amplitudeAt,
    })));

    expect(amplitudeAt.mock.calls.map(([ratio]) => ratio)).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(fillRect).toHaveBeenCalledTimes(4);
    expect(fillRect.mock.calls[0][0]).toBe(0);
    expect(fillRect.mock.calls[0][1]).toBeCloseTo(27, 8);
    expect(fillRect.mock.calls[0][3]).toBeCloseTo(46, 8);
    expect(fillRect.mock.calls[2][0]).toBe(2);
    expect(fillRect.mock.calls[2][1]).toBeCloseTo(4, 8);
    expect(fillRect.mock.calls[2][3]).toBeCloseTo(92, 8);
  });
});
