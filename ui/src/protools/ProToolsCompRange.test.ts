import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Clip, CommandResult } from "../types";
import { useShell } from "../v2/shellState";
import { ProToolsCompRange } from "./ProToolsCompRange";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});

const CLIP: Clip = {
  id: "vocal-comp",
  name: "Lead Comp",
  type: "wave",
  start: 4,
  length: 6,
  offset: 0,
  sourceFile: "/tmp/lead.wav",
  hasRenderLayer: false,
  numTakes: 3,
  currentTakeIndex: 0,
};

function Harness() {
  return React.createElement("div", { className: "pt-timeline-scroll", tabIndex: 0 },
    React.createElement(ProToolsCompRange, { clip: CLIP }));
}

describe("Pro Tools target-playlist selection cycling", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({
      ok: true,
      command,
      data: { clipId: "promoted-middle", takeIndex: 1, start: 5, end: 7 },
    }));
    useStore.setState({
      exec,
      projectEpoch: 77,
      pxPerSec: 100,
      selection: new Set([CLIP.id]),
      lastError: null,
      select: (ids: string[]) => useStore.setState({ selection: new Set(ids) }),
    });
    useShell.setState({
      selectedClipId: CLIP.id,
      timeRange: { start: 5, end: 7 },
      timeRangeDragging: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      exec: originalState.exec,
      projectEpoch: originalState.projectEpoch,
      pxPerSec: originalState.pxPerSec,
      selection: new Set<string>(),
      lastError: originalState.lastError,
      select: originalState.select,
    });
    useShell.setState({ selectedClipId: null, timeRange: null, timeRangeDragging: false });
    vi.restoreAllMocks();
  });

  it("shows the main target and promotes the next take through store.exec", async () => {
    await act(async () => root.render(React.createElement(Harness)));

    expect(host.querySelector("[data-testid=pt-comp-target]")?.textContent).toBe("Target: Main");
    expect(host.querySelector("[data-testid=pt-comp-current]")?.textContent).toBe("Take 1 of 3");
    expect((host.querySelector("[data-testid=pt-comp-range]") as HTMLElement | null)?.style.left).toBe("500px");
    const next = host.querySelector<HTMLButtonElement>("[data-testid=pt-comp-next]");
    if (!next) throw new Error("next-take control is missing");
    await act(async () => next.click());

    expect(exec).toHaveBeenCalledWith("promote_take_region", {
      clipId: CLIP.id,
      takeIndex: 1,
      start: 5,
      end: 7,
    });
    expect([...useStore.getState().selection]).toEqual(["promoted-middle"]);
    expect(useShell.getState().selectedClipId).toBe("promoted-middle");
    expect(CLIP.currentTakeIndex).toBe(0);
  });

  it("owns the documented previous and next shortcuts only from timeline focus", async () => {
    await act(async () => root.render(React.createElement(Harness)));
    const timeline = host.querySelector<HTMLElement>(".pt-timeline-scroll");
    if (!timeline) throw new Error("timeline is missing");
    timeline.focus();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowUp", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("promote_take_region", {
      clipId: CLIP.id,
      takeIndex: 2,
      start: 5,
      end: 7,
    }));

    exec.mockClear();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
      await Promise.resolve();
    });
    outside.remove();
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps a rejected range visible and surfaces the command error", async () => {
    exec.mockResolvedValue({
      ok: false,
      command: "promote_take_region",
      error: "playlist region is locked by another editor",
    });
    await act(async () => root.render(React.createElement(Harness)));
    const next = host.querySelector<HTMLButtonElement>("[data-testid=pt-comp-next]");
    if (!next) throw new Error("next-take control is missing");
    await act(async () => next.click());

    expect(useStore.getState().lastError).toBe("playlist region is locked by another editor");
    expect(host.querySelector("[data-testid=pt-comp-range]")).not.toBeNull();
    expect(useShell.getState().timeRange).toEqual({ start: 5, end: 7 });
  });

  it("clears on Escape and ignores a stale successful response after project replacement", async () => {
    let resolveCommand: ((result: CommandResult) => void) | undefined;
    exec.mockImplementation(() => new Promise((resolve) => {
      resolveCommand = resolve;
    }));
    await act(async () => root.render(React.createElement(Harness)));
    const next = host.querySelector<HTMLButtonElement>("[data-testid=pt-comp-next]");
    if (!next) throw new Error("next-take control is missing");
    act(() => next.click());
    await act(async () => {
      useStore.setState({ projectEpoch: 78 });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(useShell.getState().timeRange).toBeNull());
    await act(async () => resolveCommand?.({
      ok: true,
      command: "promote_take_region",
      data: { clipId: "stale-middle" },
    }));
    expect([...useStore.getState().selection]).toEqual([CLIP.id]);

    await act(async () => {
      useShell.getState().setTimeRange({ start: 5, end: 7 });
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));
    expect(useShell.getState().timeRange).toBeNull();
  });
});
