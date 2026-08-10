import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoshTipProvider } from "../chrome/Tooltip";
import { useStore } from "../store";
import type { CommandResult, Track } from "../types";
import { ProToolsDeviceRack } from "./ProToolsDeviceRack";

const TRACK: Track = {
  id: "vocal",
  index: 0,
  name: "Lead Vocal",
  type: "audio",
  clips: [],
  plugins: [{
    index: 0,
    name: "CLA-2A Stereo",
    type: "VST3",
    enabled: true,
    external: true,
    isInstrument: false,
    params: [],
  }],
};

describe("Pro Tools insert workflow", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  let ensurePluginCatalog: ReturnType<typeof vi.fn>;
  let rescanPlugins: ReturnType<typeof vi.fn>;
  let refreshPluginBlocklist: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    ensurePluginCatalog = vi.fn();
    rescanPlugins = vi.fn(async () => {});
    refreshPluginBlocklist = vi.fn(async () => {});
    useStore.setState({
      selectedTrackId: TRACK.id,
      availablePlugins: [{
        id: "waves-cla-2a-stereo",
        name: "CLA-2A Stereo",
        format: "VST3",
        manufacturer: "Waves",
        isInstrument: false,
      }],
      availableBuiltins: [{
        type: "compressor",
        name: "Compressor",
        category: "Dynamics",
        isInstrument: false,
        builtin: true,
      }],
      pluginCounts: { vst3: 1, au: 0, total: 1 },
      scanProgress: null,
      pluginBlocklist: [{
        id: "/Library/Audio/Plug-Ins/VST3/WaveShell1-VST3 16.7.vst3",
        rawId: "/Library/Audio/Plug-Ins/VST3/WaveShell1-VST3 16.7.vst3",
        reason: "crash_or_hang",
      }],
      lastError: null,
      exec,
      ensurePluginCatalog,
      rescanPlugins,
      refreshPluginBlocklist,
    });
    act(() => root.render(
      React.createElement(MoshTipProvider, { delay: 0 },
        React.createElement(ProToolsDeviceRack, { track: TRACK })),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".mosh-tip").forEach((node) => node.remove());
    useStore.setState({
      selectedTrackId: originalState.selectedTrackId,
      availablePlugins: originalState.availablePlugins,
      availableBuiltins: originalState.availableBuiltins,
      pluginCounts: originalState.pluginCounts,
      scanProgress: originalState.scanProgress,
      pluginBlocklist: originalState.pluginBlocklist,
      lastError: originalState.lastError,
      exec: originalState.exec,
      ensurePluginCatalog: originalState.ensurePluginCatalog,
      rescanPlugins: originalState.rescanPlugins,
      refreshPluginBlocklist: originalState.refreshPluginBlocklist,
      projectEpoch: originalState.projectEpoch,
    });
  });

  function button(testId: string): HTMLButtonElement {
    const control = document.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`);
    if (!control) throw new Error(`${testId} is missing`);
    return control;
  }

  async function openDialog(): Promise<HTMLElement> {
    await act(async () => button("pt-add-insert").click());
    const dialog = document.querySelector<HTMLElement>("[data-testid=pt-insert-dialog]");
    if (!dialog) throw new Error("insert dialog is missing");
    return dialog;
  }

  it("contains focus and restores it after Escape, backdrop, or Close", async () => {
    const trigger = button("pt-add-insert");
    const dialog = await openDialog();
    const search = dialog.querySelector<HTMLInputElement>("[data-testid=plugin-browser-search]");
    if (!search) throw new Error("plugin search is missing");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(search);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("[data-testid=pt-insert-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await openDialog();
    await act(async () => button("pt-insert-backdrop").click());
    expect(document.querySelector("[data-testid=pt-insert-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await openDialog();
    await act(async () => button("pt-insert-close").click());
    expect(document.querySelector("[data-testid=pt-insert-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes and restores focus when the project changes", async () => {
    const trigger = button("pt-add-insert");
    await openDialog();

    act(() => useStore.setState({ projectEpoch: useStore.getState().projectEpoch + 1 }));

    expect(document.querySelector("[data-testid=pt-insert-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("loads installed and built-in plugins through their exact command seams", async () => {
    let dialog = await openDialog();
    const installed = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".prow-load"))
      .find((control) => control.textContent?.includes("CLA-2A Stereo"));
    if (!installed) throw new Error("installed plugin row is missing");
    await act(async () => installed.click());
    expect(exec).toHaveBeenCalledWith("load_plugin", { trackId: TRACK.id, pluginId: "waves-cla-2a-stereo" });
    expect(document.querySelector("[data-testid=pt-insert-dialog]")).toBeNull();

    dialog = await openDialog();
    const builtin = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".prow-load"))
      .find((control) => control.textContent?.includes("Compressor"));
    if (!builtin) throw new Error("built-in plugin row is missing");
    await act(async () => builtin.click());
    expect(exec).toHaveBeenCalledWith("load_builtin", { trackId: TRACK.id, type: "compressor" });
  });

  it("offers only a VST3 rescan and surfaces progress and quarantine failures", async () => {
    let dialog = await openDialog();
    await act(async () => button("pt-insert-rescan").click());
    expect(rescanPlugins).toHaveBeenCalledWith("vst3", false, true);
    expect(dialog.textContent).not.toContain("Audio Units");

    act(() => useStore.setState({ scanProgress: { format: "vst3", done: false, count: 7, elapsedMs: 1200 } }));
    dialog = document.querySelector<HTMLElement>("[data-testid=pt-insert-dialog]")!;
    expect(dialog.querySelector("[role=status]")?.textContent).toContain("7 found");

    act(() => useStore.setState({ scanProgress: null, lastError: "VST3 scan quarantined BadPlugin" }));
    expect(dialog.querySelector("[role=alert]")?.textContent).toContain("quarantined BadPlugin");
  });

  it("retries only the selected quarantined VST3 before starting a guarded deep scan", async () => {
    const dialog = await openDialog();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(dialog.textContent).toContain("WaveShell1-VST3 16.7.vst3");

    await act(async () => button("pt-insert-retry-quarantine").click());

    expect(exec).toHaveBeenCalledWith("unblock_plugin", {
      pluginId: "/Library/Audio/Plug-Ins/VST3/WaveShell1-VST3 16.7.vst3",
    });
    expect(rescanPlugins).toHaveBeenCalledWith("vst3", false, true);
  });

  it("opens, bypasses, and removes an existing insert through store.exec", async () => {
    await act(async () => button("pt-device-open-0").click());
    await act(async () => button("pt-device-bypass-0").click());
    await act(async () => button("pt-device-remove-0").click());

    expect(exec).toHaveBeenCalledWith("open_plugin_editor", { trackId: TRACK.id, index: 0 });
    expect(exec).toHaveBeenCalledWith("bypass_plugin", { trackId: TRACK.id, index: 0, bypassed: true });
    expect(exec).toHaveBeenCalledWith("remove_plugin", { trackId: TRACK.id, index: 0 });
  });
});
