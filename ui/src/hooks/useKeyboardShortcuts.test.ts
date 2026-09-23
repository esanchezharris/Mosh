import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useStore } from "../store";
import { nativeMenuPresent } from "../bridge";
import type { CommandResult } from "../types";
import { useSettings } from "../settings/store";
import { useLive } from "../live/liveState";
import { useV3 } from "../v3/shellState";

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
    useSettings.setState({ values: { gestureTable: "mosh", keymap: "mosh" }, keyOverrides: {} });
    useV3.setState({ settingsOpen: false });
    useLive.setState({ settingsOpen: false });
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
    useSettings.setState({ values: {}, keyOverrides: {} });
    useV3.setState({ settingsOpen: false });
    useLive.setState({ settingsOpen: false });
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

  it.each(["mosh", "protools", "ableton"])("opens V3 Settings with Mod+, when the keymap is %s", (keymap) => {
    // Given: V3 is active with a selected keymap and the native menu present.
    useSettings.setState({ values: { uiShell: "v3", keymap } });
    vi.mocked(nativeMenuPresent).mockReturnValue(true);
    act(() => root.render(React.createElement(Harness)));

    // When: the advertised Settings shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true })));

    // Then: only the V3 overlay opens.
    expect(useV3.getState().settingsOpen).toBe(true);
    expect(useLive.getState().settingsOpen).toBe(false);
  });

  it("closes V3 Settings when its shortcut is pressed again", () => {
    // Given: V3 Settings is already open.
    useSettings.setState({ values: { uiShell: "v3" } });
    useV3.setState({ settingsOpen: true });
    act(() => root.render(React.createElement(Harness)));

    // When: the Settings shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true })));

    // Then: the same overlay closes.
    expect(useV3.getState().settingsOpen).toBe(false);
    expect(useLive.getState().settingsOpen).toBe(false);
  });

  it("keeps the V3 Settings shortcut rebound when an explicit key override exists", () => {
    // Given: Settings has been rebound to a different chord.
    useSettings.setState({ values: { uiShell: "v3", keymap: "mosh" }, keyOverrides: { mosh: { "key.settings": "Mod+Shift+," } } });
    act(() => root.render(React.createElement(Harness)));

    // When: the default shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true })));

    // Then: the default does not override the user's choice.
    expect(useV3.getState().settingsOpen).toBe(false);
  });

  it("routes an explicit V3 Settings rebind to the V3 overlay", () => {
    // Given: Settings has been rebound to a different chord.
    useSettings.setState({ values: { uiShell: "v3", keymap: "mosh" }, keyOverrides: { mosh: { "key.settings": "Mod+Shift+," } } });
    act(() => root.render(React.createElement(Harness)));

    // When: the rebound shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, shiftKey: true, bubbles: true })));

    // Then: it opens V3 Settings without changing the Live overlay.
    expect(useV3.getState().settingsOpen).toBe(true);
    expect(useLive.getState().settingsOpen).toBe(false);
  });

  it("preserves the Live Settings route when Live is active", () => {
    // Given: Live uses its existing default shortcut.
    useSettings.setState({ values: { uiShell: "live" } });
    act(() => root.render(React.createElement(Harness)));

    // When: the Settings shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true })));

    // Then: Live retains ownership.
    expect(useLive.getState().settingsOpen).toBe(true);
    expect(useV3.getState().settingsOpen).toBe(false);
  });

  it("does not add the V3 Settings shortcut to the classic shell", () => {
    // Given: classic has no Settings binding in its default keymap.
    useSettings.setState({ values: { uiShell: "classic", keymap: "mosh" } });
    act(() => root.render(React.createElement(Harness)));

    // When: the V3 default shortcut is pressed.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true })));

    // Then: neither overlay changes.
    expect(useLive.getState().settingsOpen).toBe(false);
    expect(useV3.getState().settingsOpen).toBe(false);
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

  it("does not hijack Space from a focused native button", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    act(() => {
      button.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(execCalls).toEqual([]);
    button.remove();
  });

  it("does not hijack Enter from a focused native button", () => {
    useSettings.setState({ values: { gestureTable: "protools", keymap: "protools" } });
    act(() => {
      root.render(React.createElement(Harness));
    });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

    act(() => {
      button.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(execCalls).toEqual([]);
    button.remove();
  });

  it("does not hijack Enter when native button activation unmounts the button", () => {
    useSettings.setState({ values: { gestureTable: "protools", keymap: "protools" } });
    act(() => {
      root.render(React.createElement(Harness));
    });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.addEventListener("keydown", () => button.remove());
    button.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

    act(() => {
      button.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(execCalls).toEqual([]);
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

  it("keeps native-menu Delete inside a focused modal piano roll", async () => {
    useStore.setState({ selection: new Set(["clip-1"]), editingClipId: "clip-1" });
    const roll = document.createElement("div");
    roll.setAttribute("data-testid", "piano-roll");
    const editorControl = document.createElement("button");
    roll.appendChild(editorControl);
    document.body.appendChild(roll);
    editorControl.focus();
    act(() => root.render(React.createElement(Harness)));

    act(() => {
      bridgeMock.eventHandlers.get("mosh_menu")?.({ action: "delete" });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(execCalls.some((call) => call.command === "remove_clip")).toBe(false);
    roll.remove();
  });

  it("lets native-menu Delete reach the arrangement beside an unfocused docked roll", async () => {
    useStore.setState({ selection: new Set(["clip-1"]), editingClipId: "clip-1" });
    const roll = document.createElement("div");
    roll.setAttribute("data-testid", "piano-roll");
    document.body.appendChild(roll);
    const arrangementClip = document.createElement("button");
    document.body.appendChild(arrangementClip);
    arrangementClip.focus();
    act(() => root.render(React.createElement(Harness)));

    act(() => {
      bridgeMock.eventHandlers.get("mosh_menu")?.({ action: "delete" });
    });

    await vi.waitFor(() =>
      expect(execCalls).toContainEqual({ command: "remove_clip", args: { clipId: "clip-1" } }),
    );
    roll.remove();
    arrangementClip.remove();
  });

  it("forwards native Cut, Copy, and Paste to a focused Pro Tools automation editor", () => {
    const automationLane = document.createElement("button");
    automationLane.dataset.moshEditOwner = "protools-automation";
    const received: string[] = [];
    automationLane.addEventListener("keydown", (event) => {
      received.push(event.key);
      event.preventDefault();
      event.stopPropagation();
    });
    document.body.appendChild(automationLane);
    automationLane.focus();
    act(() => root.render(React.createElement(Harness)));

    act(() => {
      bridgeMock.eventHandlers.get("mosh_menu")?.({ action: "cut" });
      bridgeMock.eventHandlers.get("mosh_menu")?.({ action: "copy" });
      bridgeMock.eventHandlers.get("mosh_menu")?.({ action: "paste" });
    });

    expect(received).toEqual(["x", "c", "v"]);
    expect(execCalls).toEqual([]);
    automationLane.remove();
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

  // ── demo readiness (2026-09-23) ─────────────────────────────────────────────────
  // A2: a focused slider keeps its arrows (test above) but not Space — Space after a fader
  // move plays. Checkbox/radio keep their native Space toggle in every shell.
  const flushQueue = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const toggle = { command: "set_transport", args: { action: "toggle" } };

  it("A2: Space plays while a range slider owns focus", async () => {
    act(() => root.render(React.createElement(Harness)));
    const slider = document.createElement("input");
    slider.type = "range";
    document.body.appendChild(slider);
    slider.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    act(() => { slider.dispatchEvent(event); });
    await flushQueue();

    const focused = document.activeElement;
    slider.remove();
    expect(focused).toBe(slider);
    expect(execCalls).toContainEqual(toggle);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(["checkbox", "radio"])("A2: Space stays with a focused %s (native toggle, no transport)", async (type) => {
    act(() => root.render(React.createElement(Harness)));
    const box = document.createElement("input");
    box.type = type;
    document.body.appendChild(box);
    box.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    act(() => { box.dispatchEvent(event); });
    await flushQueue();

    box.remove();
    expect(execCalls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  function v3DockField(value: string): { dock: HTMLDivElement; field: HTMLInputElement } {
    const dock = document.createElement("div");
    dock.setAttribute("data-testid", "v3-moshi-dock");
    const field = document.createElement("input");
    field.setAttribute("data-testid", "v3-moshi-field");
    field.value = value;
    dock.appendChild(field);
    document.body.appendChild(dock);
    field.focus();
    return { dock, field };
  }

  it("A2: Space from the focused EMPTY V3 dock field plays", async () => {
    act(() => root.render(React.createElement(Harness)));
    const { dock, field } = v3DockField("");
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    act(() => { field.dispatchEvent(event); });
    await flushQueue();

    dock.remove();
    expect(execCalls).toContainEqual(toggle);
    expect(event.defaultPrevented).toBe(true);   // no stray space typed into the field
  });

  it("A2: Space types into the V3 dock field once it has text", async () => {
    act(() => root.render(React.createElement(Harness)));
    const { dock, field } = v3DockField("turn the");
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    act(() => { field.dispatchEvent(event); });
    await flushQueue();

    dock.remove();
    expect(execCalls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  // A9: in the packaged app ⌘Z/⇧⌘Z/⌘X/⌘C/⌘V arrive as native-menu events, not keydowns. While
  // a V3 text field (or a field that opts in with data-owns-edit-keys) has focus they must not
  // touch the session or the clip clipboard. Other shells keep main's behaviour: their inputs
  // commit on Enter and KEEP focus, so ⌘Z from the menu must still undo that edit.
  const menu = (action: string) => act(() => { bridgeMock.eventHandlers.get("mosh_menu")?.({ action }); });

  type Where = "v3" | "opt-in" | "other-shell";
  function focusText(tag: "input" | "textarea", type = "text", value = "abc", where: Where = "v3"): HTMLElement {
    const el = document.createElement(tag);
    if (el instanceof HTMLInputElement) el.type = type;
    el.value = value;
    if (where === "v3") {
      // the V3 root (AppV3.tsx) is .v3-shell; the field sits a few levels inside it
      const shell = document.createElement("div");
      shell.className = "v3-shell";
      const pane = document.createElement("div");
      pane.appendChild(el);
      shell.appendChild(pane);
      document.body.appendChild(shell);
    } else {
      if (where === "opt-in") el.setAttribute("data-owns-edit-keys", "");
      document.body.appendChild(el);
    }
    el.focus();
    return el;
  }
  const removeField = (el: HTMLElement) => (el.closest(".v3-shell") ?? el).remove();

  it.each([
    ["a text input", "input", "text", "abc"],
    ["an empty text input", "input", "text", ""],
    ["a search input", "input", "search", "kick"],
    ["a number input", "input", "number", "90"],
    ["a textarea", "textarea", "text", "notes"],
  ] as const)("A9: native-menu Undo/Redo with %s focused in V3 performs no session undo", async (_label, tag, type, value) => {
    act(() => root.render(React.createElement(Harness)));
    const el = focusText(tag, type, value);

    menu("undo");
    menu("redo");
    await flushQueue();

    const focused = document.activeElement;
    removeField(el);
    expect(focused).toBe(el);
    expect(execCalls.map((c) => c.command)).not.toContain("undo");
    expect(execCalls.map((c) => c.command)).not.toContain("redo");
  });

  it("A9: a field outside V3 that opts in (data-owns-edit-keys, e.g. the shared Re-Imagine prompt) is guarded too", async () => {
    act(() => root.render(React.createElement(Harness)));
    const el = focusText("input", "text", "warm tape", "opt-in");
    expect(el.closest(".v3-shell")).toBeNull();   // anti-vacuity: guarded by the attribute alone

    menu("undo");
    menu("redo");
    await flushQueue();

    removeField(el);
    expect(execCalls.map((c) => c.command)).not.toContain("undo");
    expect(execCalls.map((c) => c.command)).not.toContain("redo");
  });

  it.each([
    ["a Pro Tools track-name input", "input", "text", "Lead Vox"],
    ["a Pro Tools clip-gain number input", "input", "number", "-3"],
  ] as const)("A9 scope: native-menu Undo/Redo with %s focused (another shell) still undo/redo the session, as on main", async (_label, tag, type, value) => {
    act(() => root.render(React.createElement(Harness)));
    const el = focusText(tag, type, value, "other-shell");

    menu("undo");
    await vi.waitFor(() => expect(execCalls.map((c) => c.command)).toContain("undo"));
    menu("redo");
    await vi.waitFor(() => expect(execCalls.map((c) => c.command)).toContain("redo"));
    removeField(el);
  });

  it("A9 scope: native-menu Copy with a text field focused in another shell still copies the selected clip, as on main", async () => {
    clipFixture();
    act(() => root.render(React.createElement(Harness)));
    const el = focusText("input", "text", "Lead Vox", "other-shell");

    menu("copy");

    removeField(el);
    expect(useStore.getState().clipboard?.clips.map((c) => c.clip.id)).toEqual(["clip-1"]);
  });

  it("A9: native-menu Undo with a range slider focused still undoes the session (fader case)", async () => {
    act(() => root.render(React.createElement(Harness)));
    const slider = document.createElement("input");
    slider.type = "range";
    document.body.appendChild(slider);
    slider.focus();

    menu("undo");
    await vi.waitFor(() => expect(execCalls).toContainEqual({ command: "undo", args: undefined }));
    slider.remove();
  });

  const clipFixture = () => {
    const clip = { id: "clip-1", name: "Hook", type: "block", start: 2, length: 2 };
    useStore.setState({
      selection: new Set(["clip-1"]),
      selectedTrackId: "t1",
      clipboard: null,
      transport: { playing: false, recording: false, position: 6, looping: false, loopStart: 0, loopEnd: 0 },
      snapshot: { session: {}, tracks: [{ id: "t1", clips: [clip] }] } as unknown as import("../types").Snapshot,
    });
  };

  it("A9: native-menu Copy/Cut with a text field focused never copy or cut the selected clip", async () => {
    clipFixture();
    act(() => root.render(React.createElement(Harness)));
    const el = focusText("input", "text", "turn the drums");

    menu("copy");
    menu("cut");
    await flushQueue();

    removeField(el);
    expect(useStore.getState().clipboard).toBeNull();
    expect(useStore.getState().selection.has("clip-1")).toBe(true);
    expect(execCalls.map((c) => c.command)).not.toContain("remove_clip");
  });

  it("A9: native-menu Paste into an EMPTY focused text field pastes no clip", async () => {
    clipFixture();
    act(() => root.render(React.createElement(Harness)));
    act(() => useStore.getState().copySelection());
    expect(useStore.getState().clipboard?.clips.map((c) => c.clip.id)).toEqual(["clip-1"]);   // a clip IS on the clipboard
    const el = focusText("input", "text", "");

    menu("paste");
    await flushQueue();

    removeField(el);
    expect(execCalls.map((c) => c.command)).not.toContain("paste_clip");
  });

  it("A9: native-menu Copy then Paste with no text field focused still copy and paste the clip", async () => {
    clipFixture();
    (document.activeElement as HTMLElement | null)?.blur?.();
    act(() => root.render(React.createElement(Harness)));

    menu("copy");
    expect(useStore.getState().clipboard?.clips.map((c) => c.clip.id)).toEqual(["clip-1"]);
    menu("paste");
    await vi.waitFor(() => expect(execCalls.map((c) => c.command)).toContain("paste_clip"));
  });

});
