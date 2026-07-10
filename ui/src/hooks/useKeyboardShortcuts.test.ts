import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useStore } from "../store";
import { nativeMenuPresent } from "../bridge";
import type { CommandResult } from "../types";

const bridgeMock = vi.hoisted(() => ({
  eventHandlers: new Map<string, (raw: unknown) => void>(),
}));

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    onEvent: vi.fn((type: string, cb: (raw: unknown) => void) => {
      bridgeMock.eventHandlers.set(type, cb);
      return () => bridgeMock.eventHandlers.delete(type);
    }),
    nativeMenuPresent: vi.fn(() => false),
    pickFiles: vi.fn(async () => ({ ok: true, files: ["/picked/open.mosh"] })),
    pickSaveFile: vi.fn(async () => ({ ok: true, file: "/picked/save.mosh" })),
  };
});

function Harness() {
  useKeyboardShortcuts();
  return React.createElement("div", { "data-testid": "harness" });
}

describe("useKeyboardShortcuts", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalExec = useStore.getState().exec;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    bridgeMock.eventHandlers.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      exec: originalExec,
      selection: new Set<string>(),
      editingClipId: null,
      automationTrackId: null,
    });
    vi.restoreAllMocks();
  });

  it("dispatches Space to the transport from the app-level shortcut hook", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });

    expect(execCalls).toContainEqual({ command: "set_transport", args: { action: "toggle" } });
  });

  it("dispatches Space from the focused empty Moshi prompt", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    const promptWrap = document.createElement("div");
    promptWrap.className = "agent-composer";
    const prompt = document.createElement("input");
    promptWrap.appendChild(prompt);
    document.body.appendChild(promptWrap);
    prompt.focus();

    act(() => {
      prompt.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });

    expect(execCalls).toContainEqual({ command: "set_transport", args: { action: "toggle" } });
    promptWrap.remove();
  });

  it("does not hijack Space while the Moshi prompt has text", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    const promptWrap = document.createElement("div");
    promptWrap.className = "agent-composer";
    const prompt = document.createElement("input");
    prompt.value = "make the drums";
    promptWrap.appendChild(prompt);
    document.body.appendChild(promptWrap);
    prompt.focus();

    act(() => {
      prompt.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });

    expect(execCalls).toEqual([]);
    promptWrap.remove();
  });

  it("yields Space to the native menu in the packaged app", () => {
    vi.mocked(nativeMenuPresent).mockReturnValue(true);
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });

    expect(execCalls).toEqual([]);
  });

  it("keeps Delete in the WebView when the native menu is present", () => {
    vi.mocked(nativeMenuPresent).mockReturnValue(true);
    useStore.setState({ selection: new Set(["clip-1"]) });
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });

    expect(execCalls).toContainEqual({ command: "remove_clip", args: { clipId: "clip-1" } });
  });

  it("dispatches Record through the app action dispatcher", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", bubbles: true }));
    });

    expect(execCalls).toContainEqual({ command: "set_transport", args: { action: "record" } });
  });

  it("dispatches Duplicate through the app action dispatcher", () => {
    useStore.setState({ selection: new Set(["clip-1"]) });
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", metaKey: true, bubbles: true }));
    });

    expect(execCalls).toContainEqual({ command: "duplicate_clip", args: { clipId: "clip-1" } });
  });

  it("preserves native menu open_project file payloads", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      bridgeMock.eventHandlers.get("mosh_menu")?.({ action: "open_project", file: "/recent/native.mosh" });
    });

    expect(execCalls).toContainEqual({ command: "open_project", args: { file: "/recent/native.mosh" } });
  });
});
