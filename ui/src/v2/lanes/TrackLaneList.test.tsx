import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackLaneList } from "./TrackLaneList";
import { useStore } from "../../store";
import type { CommandResult, Snapshot } from "../../types";

function makeSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000,
      tempo: 120,
      timeSigNumerator: 4,
      timeSigDenominator: 4,
      metronome: false,
      length: 16,
      editFile: "/mock/song.mosh",
      key: { tonic: "C", mode: "major" },
    },
    tracks: [
      {
        id: "t1",
        index: 0,
        name: "Bass",
        type: "audio",
        volumeDb: 0,
        pan: 0,
        clips: [],
      },
    ],
  } as unknown as Snapshot;
}

describe("v2 arrangement-to-mix morph", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      mixMorph: 0,
      pxPerSec: 80,
      exec: vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<CommandResult> => ({ ok: true, command })),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("adjusts mixMorph when alt-wheel is used on the timeline", () => {
    act(() => {
      root.render(React.createElement(TrackLaneList, { snapshot: makeSnapshot() }));
    });

    const timeline = host.querySelector<HTMLElement>('[data-testid="v2-timeline"]')!;
    act(() => {
      timeline.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -220, altKey: true }));
    });

    expect(useStore.getState().mixMorph).toBeGreaterThan(0);
  });

  it("accepts ctrl-wheel and clamps the morph at both ends", () => {
    act(() => {
      root.render(React.createElement(TrackLaneList, { snapshot: makeSnapshot() }));
    });

    const timeline = host.querySelector<HTMLElement>('[data-testid="v2-timeline"]');
    if (!timeline) throw new Error("timeline is missing");
    act(() => {
      timeline.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 220, ctrlKey: true }));
    });
    expect(useStore.getState().mixMorph).toBe(0);

    useStore.setState({ mixMorph: 0.95 });
    act(() => {
      timeline.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -220, ctrlKey: true }));
    });
    expect(useStore.getState().mixMorph).toBe(1);
  });
});
