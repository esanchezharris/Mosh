import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useStore } from "../store";
import { nativeMenuPresent } from "../bridge";
import type { CommandResult } from "../types";
import { useSettings } from "../settings/store";

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
    // These tests pin MOSH-bundle behavior; the live shell's default bundle
    // (ableton under uiShell "live") would otherwise change every gesture/feel result.
    useSettings.setState({ values: { gestureTable: "mosh", keymap: "mosh" } });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    bridgeMock.eventHandlers.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        if (command === "arm_track")
          return { ok: true, command, data: { applied: true, armed: true } };
        if (command === "set_transport" && args?.action === "record")
          return { ok: true, command, data: { recording: true } };
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    useSettings.setState({ values: {} });
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      exec: originalExec,
      selection: new Set<string>(),
      editingClipId: null,
      automationTrackId: null,
      snapshot: null,
      clipboard: null,
      selectedTrackId: null,
    });
    vi.restoreAllMocks();
  });

  it("dispatches Space to the transport from the app-level shortcut hook", async () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });

    await vi.waitFor(() =>
      expect(execCalls).toContainEqual({ command: "set_transport", args: { action: "toggle" } }),
    );
  });

  it("dispatches Space from the focused empty Moshi prompt", async () => {
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

    await vi.waitFor(() =>
      expect(execCalls).toContainEqual({ command: "set_transport", args: { action: "toggle" } }),
    );
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

  it("handles Space in the WebView even when the native menu is present (the menu carries no Space equivalent)", async () => {
    // The transport menu item carries NO Space key-equivalent (a modifier-less
    // equivalent hijacks the key from the DOM — MenuController.cpp), so PLAY_PAUSE
    // is not in NATIVE_MENU_ACTIONS and the web layer must act on it directly.
    vi.mocked(nativeMenuPresent).mockReturnValue(true);
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    // play_pause rides the transport-action QUEUE (async) — flush it before asserting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(execCalls).toContainEqual({ command: "set_transport", args: { action: "toggle" } });
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

  it("dispatches Record through the app action dispatcher", async () => {
    useStore.setState({
      selectedTrackId: "record-track",
      snapshot: {
        session: {},
        tracks: [{ id: "record-track", type: "audio", clips: [] }],
      } as unknown as import("../types").Snapshot,
    });
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(execCalls).toEqual([
      { command: "arm_track", args: { trackId: "record-track", armed: true } },
      { command: "set_transport", args: { action: "record" } },
    ]);
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

  it("copies the selected arrangement clip and pastes it at the playhead", async () => {
    const clip = { id: "clip-1", name: "Hook", type: "block", start: 2, length: 2 };
    useStore.setState({
      selection: new Set(["clip-1"]),
      selectedTrackId: "t1",
      clipboard: null,
      transport: { playing: false, recording: false, position: 6, looping: false, loopStart: 0, loopEnd: 0 },
      snapshot: {
        session: {},
        tracks: [{ id: "t1", clips: [clip] }],
      } as unknown as import("../types").Snapshot,
    });
    act(() => root.render(React.createElement(Harness)));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }));
    });
    expect(useStore.getState().clipboard?.clips.map((c) => c.clip.id)).toEqual(["clip-1"]);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true }));
    });
    await vi.waitFor(() => expect(execCalls).toContainEqual({
      command: "paste_clip",
      args: { trackId: "t1", start: 6, clip },
    }));
  });

  // FU-CLIP-NUDGE — fine clip nudge: fixed-increment move_clip, independent of
  // drag/snap, bound to the plain arrow keys (unbound everywhere else).
  it("dispatches ArrowRight to nudge the selected clip forward by one grid-division step", () => {
    useStore.setState({
      selection: new Set(["clip-1"]),
      snapshot: {
        session: {}, // 120bpm 4/4 default → "1/4" grid step = 0.5s
        tracks: [{ id: "t1", clips: [{ id: "clip-1", start: 2, length: 2 }] }],
      } as unknown as import("../types").Snapshot,
    });
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(execCalls).toContainEqual({ command: "move_clip", args: { clipId: "clip-1", start: 2.5 } });
  });

  it("dispatches ArrowLeft to nudge the selected clip backward, clamped at 0", () => {
    useStore.setState({
      selection: new Set(["clip-1"]),
      snapshot: {
        session: {},
        tracks: [{ id: "t1", clips: [{ id: "clip-1", start: 0.2, length: 2 }] }],
      } as unknown as import("../types").Snapshot,
    });
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });

    expect(execCalls).toContainEqual({ command: "move_clip", args: { clipId: "clip-1", start: 0 } });
  });

  it("does not nudge a selected clip when a range slider owns focus but WebKit targets window", () => {
    useStore.setState({
      selection: new Set(["clip-1"]),
      snapshot: {
        session: {},
        tracks: [{ id: "t1", clips: [{ id: "clip-1", start: 2, length: 2 }] }],
      } as unknown as import("../types").Snapshot,
    });
    act(() => {
      root.render(React.createElement(Harness));
    });
    const slider = document.createElement("input");
    slider.type = "range";
    slider.setAttribute("aria-label", "Send level");
    document.body.appendChild(slider);
    slider.focus();

    // The packaged WKWebView can report this keydown at window even though the range
    // input remains document.activeElement. The focused inspector control owns arrows;
    // the app-level clip-nudge layer must yield to it.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    const activeElement = document.activeElement;
    const movedClip = execCalls.some((c) => c.command === "move_clip");
    slider.remove();
    expect(activeElement).toBe(slider);
    expect(movedClip).toBe(false);
  });

  it("nudge is a no-op with nothing selected", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });

    expect(execCalls.some((c) => c.command === "move_clip")).toBe(false);
  });

  it("suppresses nudge while a clip editor (piano-roll/automation) modal is open", () => {
    useStore.setState({
      selection: new Set(["clip-1"]),
      editingClipId: "clip-1",
      snapshot: {
        session: {},
        tracks: [{ id: "t1", clips: [{ id: "clip-1", start: 2, length: 2 }] }],
      } as unknown as import("../types").Snapshot,
    });
    // The gate is focus-scoped (editorKeyFocused): the modal roll always has focus
    // inside it. Model that by focusing an element inside a piano-roll node.
    const roll = document.createElement("div");
    roll.setAttribute("data-testid", "piano-roll");
    const inner = document.createElement("button");
    roll.appendChild(inner);
    document.body.appendChild(roll);
    inner.focus();
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(execCalls.some((c) => c.command === "move_clip")).toBe(false);
    roll.remove();
  });

  it("nudge reaches the arrangement while the editor is open but NOT focused (docked selection-follow)", () => {
    useStore.setState({
      selection: new Set(["clip-1"]),
      editingClipId: "clip-1",   // docked editor open, focus on the arrangement (body)
      snapshot: {
        session: {},
        tracks: [{ id: "t1", clips: [{ id: "clip-1", start: 2, length: 2 }] }],
      } as unknown as import("../types").Snapshot,
    });
    (document.activeElement as HTMLElement | null)?.blur?.();
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(execCalls.some((c) => c.command === "move_clip")).toBe(true);
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
