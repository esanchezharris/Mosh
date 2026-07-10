import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipView } from "./ClipView";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Clip, CommandResult, Snapshot } from "../../types";

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
    tracks: [],
  } as unknown as Snapshot;
}

describe("v2 clip menu grid actions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({
      pxPerSec: 80,
      snapDivision: "1/4",
      gridMode: "fixed",
      exec: vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<CommandResult> => {
        return { ok: true, command };
      }),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useShell.setState({ selectedClipId: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("switches to adaptive grid from the MIDI clip context menu", () => {
    const clip: Clip = {
      id: "clip-1",
      name: "mid",
      type: "midi",
      start: 0,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
      notes: [{ i: 0, pitch: 64, start: 0, length: 1, velocity: 100 }],
    };

    act(() => {
      root.render(React.createElement(ClipView, { clip, trackType: "audio", snapshot: makeSnapshot() }));
    });

    const clipNode = host.querySelector<HTMLElement>('[data-clip-id="clip-1"]')!;
    act(() => {
      clipNode.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 12, button: 2 }));
    });

    const menu = document.body.querySelector('[data-testid="v2-clip-menu"]');
    expect(menu).not.toBeNull();
    const adaptive = [...document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find((b) => b.textContent === "Adaptive grid");
    expect(adaptive).toBeTruthy();
    act(() => {
      adaptive!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useStore.getState().gridMode).toBe("adaptive");
  });

  it("sets a fixed triplet division from the MIDI clip context menu", () => {
    const clip: Clip = {
      id: "clip-2",
      name: "mid",
      type: "midi",
      start: 0,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
      notes: [{ i: 0, pitch: 64, start: 0, length: 1, velocity: 100 }],
    };

    act(() => {
      root.render(React.createElement(ClipView, { clip, trackType: "audio", snapshot: makeSnapshot() }));
    });

    const clipNode = host.querySelector<HTMLElement>('[data-clip-id="clip-2"]')!;
    act(() => {
      clipNode.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 12, button: 2 }));
    });

    const triplet = [...document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find((b) => b.textContent === "1/8T");
    expect(triplet).toBeTruthy();
    act(() => {
      triplet!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useStore.getState().gridMode).toBe("fixed");
    expect(useStore.getState().snapDivision).toBe("1/8T");
  });
});
