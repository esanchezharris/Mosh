import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioClipEditor } from "./AudioClipEditor";
import { useStore } from "../store";
import type { Clip, CommandResult } from "../types";
import type { Peaks, State } from "../store";

type ExecCall = {
  readonly command: string;
  readonly args: Record<string, unknown> | undefined;
};

const waveClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: "wave-42",
  name: "opening chords",
  type: "wave",
  start: 2,
  length: 6,
  offset: 0,
  sourceFile: "/sessions/ideas/opening-chords.wav",
  sourceLength: 8.5,
  gainDb: -3.5,
  fadeInSec: 0.25,
  fadeOutSec: 0.75,
  reversed: false,
  hasRenderLayer: false,
  ...overrides,
});

describe("AudioClipEditor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let previous: Pick<State, "ensurePeaks" | "exec" | "peaks" | "snapshot">;
  let peakRequests: string[];
  let execCalls: ExecCall[];
  let containerWidth: number;
  let resizeObserver: TestResizeObserver | null;
  let previousResizeObserver: PropertyDescriptor | undefined;

  class TestResizeObserver {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeObserver = this;
    }

    disconnect(): void {}
    observe(_target: Element): void {}
    unobserve(_target: Element): void {}

    trigger(): void {
      this.callback([], this);
    }
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    containerWidth = 160;
    resizeObserver = null;
    previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => containerWidth);
    previous = useStore.getState();
    peakRequests = [];
    execCalls = [];
    useStore.setState({
      snapshot: null,
      peaks: {},
      ensurePeaks: (clipId) => { peakRequests.push(clipId); },
      exec: async (command, args): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    if (previousResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
    useStore.setState(previous);
  });

  const render = (clip: Clip) => {
    act(() => root.render(React.createElement(AudioClipEditor, { clip, onClose: () => {} })));
  };

  const control = (testId: string): HTMLInputElement | HTMLButtonElement => {
    const element = host.querySelector<HTMLInputElement | HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`missing ${testId}`);
    return element;
  };

  const numberControl = (testId: string): HTMLInputElement => {
    const element = control(testId);
    if (!(element instanceof HTMLInputElement)) throw new Error(`${testId} is not an input`);
    return element;
  };

  it("requests peaks, renders their waveform, and names missing sources honestly", () => {
    const clip = waveClip();
    render(clip);
    expect(peakRequests).toEqual([clip.id]);
    expect(host.querySelector('[data-testid="live-audio-waveform-status"]')?.textContent).toContain("Loading waveform");

    const peaks: Peaks = [[-0.8, 0.7], [-0.4, 0.5]];
    act(() => useStore.setState({ peaks: { [clip.id]: peaks } }));
    expect(host.querySelector('[data-testid="live-audio-waveform"] canvas')).not.toBeNull();

    render(waveClip({ sourceMissing: true, sourceFile: "/sessions/ideas/missing.wav" }));
    expect(host.querySelector('[data-testid="live-audio-waveform-status"]')?.textContent).toContain("source file is missing");
    expect(host.querySelector('[data-testid="live-audio-source"]')?.textContent).toBe("missing.wav");
  });

  it("redraws the waveform when its rendered container width changes", () => {
    const clip = waveClip();
    useStore.setState({ peaks: { [clip.id]: [[-0.8, 0.7]] } });
    render(clip);
    const canvas = host.querySelector<HTMLCanvasElement>('[data-testid="live-audio-waveform"] canvas');
    if (!canvas) throw new Error("missing waveform canvas");
    expect(canvas.width).toBe(160);
    const redrawsBefore = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length;

    containerWidth = 320;
    act(() => resizeObserver?.trigger());

    expect(canvas.width).toBe(320);
    expect(vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length).toBeGreaterThan(redrawsBefore);
  });

  it("commits each audio operation through exec with the exact command arguments", () => {
    const clip = waveClip();
    render(clip);

    act(() => {
      const gain = numberControl("live-audio-gain");
      gain.value = "-8";
      gain.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      const fadeIn = numberControl("live-audio-fade-in");
      fadeIn.value = "1.5";
      fadeIn.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      const fadeOut = numberControl("live-audio-fade-out");
      fadeOut.value = "2.25";
      fadeOut.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      control("live-audio-reverse").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      control("live-audio-normalize").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      control("live-loopbar-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(execCalls).toEqual(expect.arrayContaining([
      { command: "set_clip_gain", args: { clipId: clip.id, gainDb: -8 } },
      { command: "set_clip_fade", args: { clipId: clip.id, fadeInSec: 1.5 } },
      { command: "set_clip_fade", args: { clipId: clip.id, fadeOutSec: 2.25 } },
      { command: "set_clip_reverse", args: { clipId: clip.id, reversed: true } },
      { command: "normalize_clip", args: { clipId: clip.id, targetDb: 0 } },
      { command: "set_clip_loop", args: { clipId: clip.id, enabled: true } },
    ]));
  });
});
