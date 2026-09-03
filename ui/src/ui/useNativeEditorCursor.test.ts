import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeEditorCursor, type PianoRollCursor } from "./useNativeEditorCursor";

const setEditorCursor = vi.hoisted(() => vi.fn());

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, setEditorCursor };
});

describe("useNativeEditorCursor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let applyCursor: (cursor: PianoRollCursor, refresh?: boolean) => void;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let Harness: React.ComponentType<{ active?: boolean }>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    frames = new Map();
    nextFrame = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    setEditorCursor.mockClear();

    Harness = function CursorHarness({ active = true }: { active?: boolean }) {
      applyCursor = useNativeEditorCursor(active);
      return null;
    };
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("cancels a queued refresh before releasing the editor cursor", () => {
    act(() => applyCursor("grab"));
    act(() => applyCursor("grab", true));
    expect(frames).toHaveLength(1);

    act(() => applyCursor("default"));

    expect(frames).toHaveLength(0);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(setEditorCursor).toHaveBeenLastCalledWith("default");
  });

  it("releases the native cursor when a still-mounted editor closes", () => {
    act(() => applyCursor("grab"));
    setEditorCursor.mockClear();

    act(() => root.render(React.createElement(Harness, { active: false })));

    expect(setEditorCursor).toHaveBeenCalledTimes(1);
    expect(setEditorCursor).toHaveBeenCalledWith("default");
  });
});
