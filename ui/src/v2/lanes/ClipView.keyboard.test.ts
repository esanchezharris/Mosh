import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipView } from "./ClipView";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import { readShellCss } from "../cssSource";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import type { Clip, CommandResult, Snapshot } from "../../types";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return {
    ...actual,
    onEvent: vi.fn(() => () => {}),
    nativeMenuPresent: vi.fn(() => false),
    pickFiles: vi.fn(),
    pickSaveFile: vi.fn(),
  };
});

const CLIP = {
  id: "c1", name: "Spoken Hook", type: "block", start: 2, length: 4, offset: 0, hasRenderLayer: false,
} as unknown as Clip;

const SNAPSHOT = {
  schemaVersion: 1,
  session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 },
  tracks: [{ id: "t1", type: "audio", clips: [CLIP] }],
  transport: { playing: false, recording: false, position: 3, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

function Harness() {
  useKeyboardShortcuts();
  return React.createElement(ClipView, { clip: CLIP, trackType: "audio", snapshot: SNAPSHOT });
}

describe("v2 ClipView keyboard access", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalLoadCapabilities = useStore.getState().loadCapabilities;

  const render = () => act(() => root.render(React.createElement(Harness)));
  const clip = () => host.querySelector<HTMLElement>('[data-testid="v2-clip"]')!;
  const key = (target: EventTarget, value: string, init: KeyboardEventInit = {}) => act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }));
  });
  const keyAsync = async (target: EventTarget, value: string, init: KeyboardEventInit = {}) => act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      selection: new Set<string>(),
      selectedTrackId: "t1",
      pxPerSec: 80,
      snap: false,
      tool: "move",
      transport: { playing: false, recording: false, position: 3, looping: false, loopStart: 0, loopEnd: 0 },
      exec,
      loadCapabilities: vi.fn(async () => {}),
    });
    useShell.setState({ selectedClipId: null });
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: null,
      selection: new Set<string>(),
      selectedTrackId: null,
      exec: useStore.getInitialState().exec,
      loadCapabilities: originalLoadCapabilities,
    });
    useShell.setState({ selectedClipId: null });
    vi.restoreAllMocks();
  });

  it("is a named, selectable menu trigger in the natural tab order", () => {
    expect(clip().getAttribute("role")).toBe("button");
    expect(clip().tabIndex).toBe(0);
    expect(clip().getAttribute("aria-label")).toContain("Spoken Hook");
    expect(clip().getAttribute("aria-pressed")).toBe("false");
    expect(clip().getAttribute("aria-haspopup")).toBe("menu");
    clip().focus();
    expect(document.activeElement).toBe(clip());
  });

  it("keeps the keyboard focus ring stronger than the selected outline", () => {
    const css = readShellCss();
    const selectedRule = css.indexOf(".v2-clip.sel {");
    const focusRule = css.indexOf(".v2-clip:focus-visible {");
    expect(selectedRule).toBeGreaterThanOrEqual(0);
    expect(focusRule).toBeGreaterThan(selectedRule);
    expect(css.slice(focusRule, css.indexOf("}", focusRule))).toContain("outline: 3px solid");
  });

  it.each(["Enter", " "])("selects with %s and keeps Shift additive", (value) => {
    act(() => useStore.setState({ selection: new Set(["already-selected"]) }));
    key(clip(), value);
    expect([...useStore.getState().selection]).toEqual(["c1"]);
    expect(useShell.getState().selectedClipId).toBe("c1");

    act(() => useStore.setState({ selection: new Set(["already-selected"]) }));
    key(clip(), value, { shiftKey: true });
    expect([...useStore.getState().selection]).toEqual(["already-selected", "c1"]);
  });

  it("routes nudge, copy/paste, and Delete from the focused clip through the app shortcuts", async () => {
    clip().focus();
    await keyAsync(clip(), "Enter");
    await keyAsync(clip(), "ArrowRight");
    expect(exec).toHaveBeenCalledWith("move_clip", { clipId: "c1", start: 2.5 });

    await keyAsync(clip(), "c", { metaKey: true });
    expect(useStore.getState().clipboard?.clips.map((c) => c.clip.id)).toEqual(["c1"]);

    await keyAsync(clip(), "Delete");
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("remove_clip", { clipId: "c1" }));
    expect(useStore.getState().selection.size).toBe(0);

    await keyAsync(clip(), "v", { metaKey: true });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("paste_clip", {
      trackId: "t1", start: 3, clip: CLIP,
    }));
  });

  it("opens the shared menu with Shift-F10, splits at an in-clip playhead, and restores focus", async () => {
    clip().focus();
    key(clip(), "F10", { shiftKey: true });

    const menu = document.querySelector<HTMLElement>('[data-testid="v2-clip-menu"]')!;
    const split = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(split.textContent).toBe("Split at playhead");
    expect(document.activeElement).toBe(split);

    act(() => split.click());
    expect(exec).toHaveBeenCalledWith("split_clip", { clipId: "c1", time: 3 });
    await vi.waitFor(() => expect(document.activeElement).toBe(clip()));
    expect(document.querySelector('[data-testid="v2-clip-menu"]')).toBeNull();
  });

  it("uses the clip midpoint when the playhead is outside and says so in the menu", () => {
    act(() => useStore.setState({
      transport: { playing: false, recording: false, position: 99, looping: false, loopStart: 0, loopEnd: 0 },
    }));
    clip().focus();
    key(clip(), "ContextMenu");
    const split = document.querySelector<HTMLButtonElement>('[data-testid="v2-clip-menu"] [role="menuitem"]')!;
    expect(split.textContent).toBe("Split at clip midpoint");
    act(() => split.click());
    expect(exec).toHaveBeenCalledWith("split_clip", { clipId: "c1", time: 4 });
  });

  it("keeps right-click on the same menu with the pointer insertion point", () => {
    clip().getBoundingClientRect = () => ({
      left: 100, top: 200, right: 420, bottom: 260, width: 320, height: 60, x: 100, y: 200, toJSON: () => ({}),
    }) as DOMRect;
    act(() => clip().dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 230,
    })));
    const split = document.querySelector<HTMLButtonElement>('[data-testid="v2-clip-menu"] [role="menuitem"]')!;
    expect(split.textContent).toBe("Split here");
    act(() => split.click());
    expect(exec).toHaveBeenCalledWith("split_clip", { clipId: "c1", time: 3 });
  });

  it("uses menu arrow keys and Escape closes back to the clip", async () => {
    clip().focus();
    key(clip(), "ContextMenu");
    const items = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="v2-clip-menu"] [role="menuitem"]')];
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    key(items[0], "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key(items[1], "ArrowUp");
    expect(document.activeElement).toBe(items[0]);
    key(items[0], "Escape");
    await vi.waitFor(() => expect(document.activeElement).toBe(clip()));
    expect(document.querySelector('[data-testid="v2-clip-menu"]')).toBeNull();
  });
});
