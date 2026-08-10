import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Clip, CommandResult, Snapshot, Track } from "../types";
import { ProToolsUniverse } from "./ProToolsUniverseView";
import { useProTools } from "./proToolsState";

const clip = (id: string, start: number, length: number): Clip => ({
  id,
  name: id,
  type: id.includes("midi") ? "midi" : "wave",
  start,
  length,
  offset: 0,
  hasRenderLayer: false,
});

const track = (id: string, index: number, clips: readonly Clip[], color?: string): Track => ({
  id,
  index,
  name: id,
  type: "audio",
  clips: [...clips],
  ...(color ? { color } : {}),
});

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    length: 16,
    editFile: "/tmp/protools-universe.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    track("Vocal", 0, [clip("verse", 4, 4)], "#a24b55"),
    track("Bass", 1, [clip("midi-bass", 0, 8)], "#4778b8"),
    track("Empty", 2, []),
  ],
  transport: { playing: false, recording: false, position: 12, looping: false, loopStart: 0, loopEnd: 0 },
};

const LARGE_SNAPSHOT: Snapshot = {
  ...SNAPSHOT,
  tracks: Array.from({ length: 18 }, (_, index) => (
    track(`Track ${String(index + 1).padStart(2, "0")}`, index, [])
  )),
};

function setViewportMetrics(timeline: HTMLDivElement): void {
  Object.defineProperties(timeline, {
    clientWidth: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 1_600 },
    scrollHeight: { configurable: true, value: 400 },
  });
}

describe("ProToolsUniverse view", () => {
  let host: HTMLDivElement;
  let timeline: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    timeline = document.createElement("div");
    setViewportMetrics(timeline);
    document.body.append(host, timeline);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      projectEpoch: 91,
      exec,
    });
    useProTools.getState().resetForProject(91);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    timeline.remove();
    useStore.setState({ snapshot: null, exec: originalExec });
    vi.unstubAllGlobals();
  });

  const render = (snapshot: Snapshot = SNAPSHOT): void => {
    act(() => root.render(React.createElement(ProToolsUniverse, {
      snapshot,
      timelineRef: { current: timeline },
    })));
  };

  it("stays absent until the producer shows the optional overview", () => {
    render();
    expect(host.querySelector("[data-testid=pt-universe]")).toBeNull();
  });

  it("renders track-ordered colored clip lines and a live viewport frame", async () => {
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(_callback: ResizeObserverCallback) {}
      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    const timelineContent = document.createElement("div");
    timelineContent.className = "pt-timeline-content";
    timeline.append(timelineContent);
    useProTools.getState().setUniverseOpen(true);
    render();

    const rows = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-universe-track]")];
    const clips = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-universe-clip]")];
    const frame = host.querySelector<HTMLElement>("[data-testid=pt-universe-frame]");
    expect(rows.map((row) => row.dataset.trackId)).toEqual(["Vocal", "Bass", "Empty"]);
    expect(clips.map((item) => item.dataset.clipId)).toEqual(["verse", "midi-bass"]);
    expect(clips[0]?.style.getPropertyValue("--pt-universe-color")).toBe("#a24b55");
    await vi.waitFor(() => expect(frame?.style.width).toBe("25%"));
    expect(frame?.style.height).toBe("50%");
    expect(observe).toHaveBeenCalledWith(timeline);
    expect(observe).toHaveBeenCalledWith(timelineContent);
  });

  it("navigates horizontally and vertically by click and accessible keys without a command", () => {
    useProTools.getState().setUniverseOpen(true);
    render();
    const field = host.querySelector<HTMLButtonElement>("[data-testid=pt-universe-field]");
    if (!field) throw new Error("Universe navigation field is missing");
    vi.spyOn(field, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 10, 800, 100));

    act(() => field.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 760,
      clientY: 85,
      detail: 1,
    })));
    expect({ left: timeline.scrollLeft, top: timeline.scrollTop })
      .toEqual({ left: 1_000, top: 200 });

    timeline.scrollLeft = 0;
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    })));
    expect(timeline.scrollLeft).toBe(300);

    timeline.scrollLeft = 0;
    act(() => field.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 0,
    })));
    expect(timeline.scrollLeft).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });

  it("resizes through the keyboard and restores the documented default on double-click", () => {
    useProTools.setState({ universeOpen: true, universeHeight: 72 });
    render();
    const separator = host.querySelector<HTMLElement>("[data-testid=pt-universe-resizer]");
    if (!separator) throw new Error("Universe resize separator is missing");

    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    })));
    expect(useProTools.getState().universeHeight).toBe(80);
    act(() => separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(useProTools.getState().universeHeight).toBe(72);

    act(() => {
      separator.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 19,
        clientY: 100,
        bubbles: true,
      }));
      separator.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 19,
        clientY: 132,
        bubbles: true,
      }));
    });
    expect(useProTools.getState().universeHeight).toBe(104);
    act(() => separator.dispatchEvent(new PointerEvent("pointercancel", {
      pointerId: 19,
      bubbles: true,
    })));
    expect(useProTools.getState().universeHeight).toBe(72);
    expect(exec).not.toHaveBeenCalled();
  });

  it("scrolls a bounded large-session track window and resets it for a replacement project", () => {
    useProTools.setState({ universeOpen: true, universeHeight: 72 });
    render(LARGE_SNAPSHOT);
    const shownTrackIds = () => (
      [...host.querySelectorAll<HTMLElement>("[data-testid=pt-universe-track]")]
        .map((row) => row.dataset.trackId)
    );
    const down = host.querySelector<HTMLButtonElement>("[data-testid=pt-universe-scroll-down]");
    const up = host.querySelector<HTMLButtonElement>("[data-testid=pt-universe-scroll-up]");
    if (!down || !up) throw new Error("Universe track-window controls are missing");

    expect(shownTrackIds()).toEqual(Array.from(
      { length: 10 },
      (_, index) => `Track ${String(index + 1).padStart(2, "0")}`,
    ));
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(false);

    act(() => down.click());
    expect(shownTrackIds()[0]).toBe("Track 02");
    expect(up.disabled).toBe(false);
    for (let step = 0; step < 7; step += 1) act(() => down.click());
    expect(shownTrackIds().at(-1)).toBe("Track 18");
    expect(down.disabled).toBe(true);

    act(() => useStore.setState({ projectEpoch: 92 }));
    expect(shownTrackIds()[0]).toBe("Track 01");
    expect(up.disabled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});
