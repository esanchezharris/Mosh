import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SongNav } from "./SongNav";
import { useStore } from "../../store";
import type { Snapshot } from "../../types";

const snap = (): Snapshot =>
  ({
    schemaVersion: 1,
    session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, length: 32 },
    tracks: [],
    sections: [],
  }) as unknown as Snapshot;

describe("SongNav — pointer scrubbing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onScrub: ReturnType<typeof vi.fn>;
  let frames: Array<{ id: number; cb: FrameRequestCallback }>;
  let nextFrameId: number;

  const nav = () => host.querySelector('[data-testid="v2-songnav"]') as HTMLElement;
  const render = () => act(() => {
    root.render(React.createElement(SongNav, { snapshot: snap(), onScrub }));
  });
  const pointer = (type: string, clientX: number, buttons = 1) => act(() => {
    nav().dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      pointerId: 7,
      clientX,
      buttons,
    }));
  });
  const flushFrame = () => act(() => {
    const pending = frames.splice(0);
    for (const frame of pending) frame.cb(16);
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.push({ id, cb });
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      frames = frames.filter((frame) => frame.id !== id);
    }));

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onScrub = vi.fn();
    useStore.setState({
      transport: { playing: false, recording: false, position: 0 },
      peerPresence: {},
      peers: {},
    } as never);
    render();
    vi.spyOn(nav(), "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 900,
      top: 0,
      bottom: 36,
      width: 800,
      height: 36,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("click seeks immediately without emitting a duplicate pointer-up seek", () => {
    pointer("pointerdown", 300);
    pointer("pointerup", 300, 0);

    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenLastCalledWith(9);
  });

  it("coalesces held moves and commits the exact pointer-up position", () => {
    const capture = vi.fn();
    const release = vi.fn();
    Object.defineProperties(nav(), {
      setPointerCapture: { configurable: true, value: capture },
      releasePointerCapture: { configurable: true, value: release },
    });

    pointer("pointerdown", 300);
    pointer("pointermove", 500, 0);
    pointer("pointermove", 700, 0);
    expect(onScrub).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(onScrub).toHaveBeenCalledTimes(2);
    expect(onScrub).toHaveBeenLastCalledWith(27);

    pointer("pointerup", 800, 0);
    expect(onScrub).toHaveBeenCalledTimes(3);
    expect(onScrub).toHaveBeenLastCalledWith(31.5);
    expect(capture).toHaveBeenCalledWith(7);
    expect(release).toHaveBeenCalledWith(7);
  });

  it("pointer cancellation drops the queued position and ignores later moves", () => {
    pointer("pointerdown", 300);
    pointer("pointermove", 700);
    pointer("pointercancel", 700, 0);
    flushFrame();
    pointer("pointermove", 800);
    flushFrame();

    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenLastCalledWith(9);
  });
});
