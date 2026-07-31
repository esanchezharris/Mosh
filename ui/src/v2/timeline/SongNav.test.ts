import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SongNav } from "./SongNav";
import { useStore } from "../../store";
import type { Snapshot } from "../../types";

const snap = (): Snapshot => ({
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    metronome: false,
    key: { tonic: "A", mode: "minor" },
    length: 32,
    editFile: "",
  },
  tracks: [],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
  master: { volumeDb: 0, pan: 0 },
  sections: [],
});

describe("SongNav — pointer scrubbing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onScrub: ReturnType<typeof vi.fn>;
  let frames: Array<{ id: number; cb: FrameRequestCallback }>;
  let nextFrameId: number;
  let mounted: boolean;

  const nav = () => host.querySelector('[data-testid="v2-songnav"]') as HTMLElement;
  const render = () => act(() => {
    root.render(React.createElement(SongNav, { snapshot: snap(), onScrub }));
  });
  const pointer = (type: string, clientX: number, buttons = 1, pointerId = 7) => act(() => {
    nav().dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      pointerId,
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
    mounted = true;
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
    if (mounted) act(() => root.unmount());
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

  it("does not repeat an endpoint already committed by the last frame", () => {
    pointer("pointerdown", 300);
    pointer("pointermove", 700, 0);
    flushFrame();
    expect(onScrub).toHaveBeenCalledTimes(2);
    expect(onScrub).toHaveBeenLastCalledWith(27);

    pointer("pointerup", 700, 0);
    expect(onScrub).toHaveBeenCalledTimes(2);
  });

  it("keeps the scrub owned by its initiating pointer", () => {
    pointer("pointerdown", 300, 1, 7);
    pointer("pointerdown", 700, 1, 8);
    pointer("pointermove", 800, 1, 8);
    pointer("pointerup", 800, 0, 8);
    flushFrame();

    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenLastCalledWith(9);

    pointer("pointermove", 500, 1, 7);
    flushFrame();
    pointer("pointerup", 600, 0, 7);

    expect(onScrub).toHaveBeenCalledTimes(3);
    expect(onScrub).toHaveBeenNthCalledWith(2, 18);
    expect(onScrub).toHaveBeenLastCalledWith(22.5);
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

  it("lost pointer capture cancels queued work and later movement", () => {
    pointer("pointerdown", 300);
    pointer("pointermove", 700);
    pointer("lostpointercapture", 700, 0);
    flushFrame();
    pointer("pointermove", 800);
    flushFrame();

    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenLastCalledWith(9);
  });

  it("unmount cancels queued work and releases an active pointer", () => {
    const element = nav();
    const release = vi.fn();
    Object.defineProperty(element, "releasePointerCapture", {
      configurable: true,
      value: release,
    });

    pointer("pointerdown", 300);
    pointer("pointermove", 700);
    act(() => root.unmount());
    mounted = false;
    flushFrame();

    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenLastCalledWith(9);
    expect(release).toHaveBeenCalledWith(7);
  });
});
