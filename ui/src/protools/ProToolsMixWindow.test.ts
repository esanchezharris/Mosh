import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsMixWindow } from "./ProToolsMixWindow";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-mix-window.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    {
      id: "vocal",
      index: 0,
      name: "Lead Vocal",
      type: "audio",
      clips: [],
      armed: false,
      monitor: "automatic",
      volumeDb: -3,
      pan: 0.25,
      automationMode: "read",
      input: { deviceID: "in-1-2", name: "Input 1-2", kind: "wave" },
      output: { isTrack: false, deviceID: "out-1-2", name: "Main Speakers" },
      plugins: [{
        index: 0,
        name: "CLA-2A Stereo",
        type: "VST3",
        enabled: true,
        external: true,
        isInstrument: false,
        params: [],
      }],
      sends: [{ bus: 1, db: -12, mute: false }],
    },
    {
      id: "double",
      index: 1,
      name: "Double",
      type: "audio",
      clips: [],
      armed: false,
      monitor: "automatic",
      volumeDb: -4,
      pan: -0.1,
      automationMode: "read",
      sends: [{ bus: 1, db: -10, mute: false }],
    },
    {
      id: "folder",
      index: 2,
      name: "Vocals Folder",
      type: "group",
      isGroup: true,
      clips: [],
      volumeDb: 0,
      pan: 0,
    },
    {
      id: "aux-1",
      index: 3,
      name: "Vocal Verb",
      type: "audio",
      isReturn: true,
      returnBus: 1,
      clips: [],
      volumeDb: -6,
      pan: 0,
    },
  ],
  buses: [{ bus: 1, name: "Vocal Verb", trackId: "aux-1" }],
  master: {
    volumeDb: -1.5,
    pan: 0.1,
    plugins: [{
      index: 0,
      name: "Master Glue",
      type: "compressor",
      enabled: true,
      external: false,
      builtin: true,
      isInstrument: false,
      params: [],
    }],
  },
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
const selectValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;

function changeInput(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeSelect(select: HTMLSelectElement, value: string): void {
  if (!selectValueSetter) throw new Error("native select value setter is unavailable");
  selectValueSetter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Pro Tools Mix Window", () => {
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
      data: command === "arm_track" || command === "set_input_monitor" ? { applied: true } : undefined,
    }));
    useProTools.getState().resetForProject(useProTools.getState().projectEpoch + 1);
    useStore.setState({
      snapshot: SNAPSHOT,
      selectedTrackId: "vocal",
      editingClipId: null,
      selection: new Set(),
      exec,
      lastError: null,
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
      ensurePluginCatalog: vi.fn(),
      waveInputs: [
        { deviceID: "in-1-2", name: "Input 1-2", enabled: true, isStereoPair: true },
        { deviceID: "in-3-4", name: "Input 3-4", enabled: true, isStereoPair: true },
      ],
      midiInputs: [],
      trackOutputs: {
        outputs: [
          { deviceID: "out-1-2", name: "Main Speakers", enabled: true },
          { deviceID: "out-3-4", name: "Headphones", enabled: true },
        ],
        tracks: SNAPSHOT.tracks.map(({ id, name }) => ({ id, name })),
        audioEnabled: true,
      },
      loadRouting: vi.fn(async () => {}),
      loadMidiInputs: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    });
    act(() => root.render(React.createElement(ProToolsMixWindow, { snapshot: SNAPSHOT })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      selectedTrackId: originalState.selectedTrackId,
      editingClipId: originalState.editingClipId,
      selection: originalState.selection,
      exec: originalState.exec,
      lastError: originalState.lastError,
      availablePlugins: originalState.availablePlugins,
      availableBuiltins: originalState.availableBuiltins,
      ensurePluginCatalog: originalState.ensurePluginCatalog,
      waveInputs: originalState.waveInputs,
      midiInputs: originalState.midiInputs,
      trackOutputs: originalState.trackOutputs,
      loadRouting: originalState.loadRouting,
      loadMidiInputs: originalState.loadMidiInputs,
      refresh: originalState.refresh,
    });
  });

  const vocalStrip = (): HTMLElement => {
    const strip = host.querySelector<HTMLElement>("[data-testid=pt-mix-strip][data-track-id=vocal]");
    if (!strip) throw new Error("vocal strip is missing");
    return strip;
  };

  it("renders every track and Aux as a labelled strip with the documented control hierarchy", () => {
    expect(host.querySelector("[data-testid=pt-mix-window]")).not.toBeNull();
    expect(host.querySelectorAll("[data-testid=pt-mix-strip]")).toHaveLength(4);
    expect(vocalStrip().getAttribute("aria-label")).toBe("Lead Vocal channel strip");
    expect(vocalStrip().querySelector("[data-testid=pt-mix-inserts]")?.textContent).toContain("CLA-2A Stereo");
    expect(vocalStrip().querySelector("[data-testid=pt-mix-sends]")?.textContent).toContain("Vocal Verb");
    expect(vocalStrip().querySelector("[data-testid=pt-mix-input]")).not.toBeNull();
    expect(vocalStrip().querySelector("[data-testid=pt-mix-output]")).not.toBeNull();
    expect(vocalStrip().querySelector("[data-testid=pt-mix-automation]")).not.toBeNull();
    expect(vocalStrip().querySelector(".meter")).not.toBeNull();
    expect(host.querySelector("[data-testid=pt-mix-master-meter]")).not.toBeNull();
    expect(host.querySelector("[data-testid=pt-mix-master-inserts]")?.textContent).toContain("Master Glue");
    expect(host.querySelector<HTMLInputElement>("[data-testid=pt-mix-master-volume]")?.value).toBe("-1.5");
    expect(host.querySelector<HTMLInputElement>("[data-testid=pt-mix-master-pan]")?.value).toBe("0.1");
    const groupStrip = host.querySelector<HTMLElement>("[data-testid=pt-mix-strip][data-track-id=folder]");
    expect(groupStrip?.querySelector<HTMLInputElement>("[data-testid=pt-mix-volume]")?.disabled).toBe(false);
    expect(groupStrip?.querySelector<HTMLInputElement>("[data-testid=pt-mix-pan]")?.disabled).toBe(true);
    expect(groupStrip?.querySelector<HTMLSelectElement>("[data-testid=pt-mix-output]")?.disabled).toBe(true);
    expect(groupStrip?.querySelector<HTMLButtonElement>("[data-testid=pt-mix-mute]")?.disabled).toBe(true);
    expect(groupStrip?.querySelector<HTMLButtonElement>("[data-testid=pt-mix-add-insert]")?.disabled).toBe(true);
  });

  it("routes master fader, pan, and existing inserts through master-only commands", async () => {
    const volume = host.querySelector<HTMLInputElement>("[data-testid=pt-mix-master-volume]");
    const pan = host.querySelector<HTMLInputElement>("[data-testid=pt-mix-master-pan]");
    const open = host.querySelector<HTMLButtonElement>("[data-testid=pt-mix-master-insert-open-0]");
    const bypass = host.querySelector<HTMLButtonElement>("[data-testid=pt-mix-master-insert-bypass-0]");
    const remove = host.querySelector<HTMLButtonElement>("[data-testid=pt-mix-master-insert-remove-0]");
    if (!volume || !pan || !open || !bypass || !remove) throw new Error("master controls are missing");

    await act(async () => {
      changeInput(volume, "-4");
      changeInput(pan, "-0.2");
      open.click();
      bypass.click();
      remove.click();
    });

    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("set_master_volume", { db: -4 }));
    expect(exec).toHaveBeenCalledWith("set_master_pan", { pan: -0.2 });
    expect(exec).toHaveBeenCalledWith("open_master_plugin_editor", { index: 0 });
    expect(exec).toHaveBeenCalledWith("bypass_master_plugin", { index: 0, bypassed: true });
    expect(exec).toHaveBeenCalledWith("remove_master_plugin", { index: 0 });
  });

  it("loads a Master insert without targeting the selected channel strip", async () => {
    const add = host.querySelector<HTMLButtonElement>("[data-testid=pt-mix-master-add-insert]");
    if (!add) throw new Error("master insert control is missing");

    await act(async () => add.click());
    const dialog = host.querySelector<HTMLElement>("[data-testid=pt-insert-dialog]");
    const compressor = Array.from(dialog?.querySelectorAll<HTMLButtonElement>(".prow-load") ?? [])
      .find((control) => control.textContent?.includes("Compressor"));
    if (!dialog || !compressor) throw new Error("master insert dialog is missing");
    expect(dialog.textContent).toContain("Add Master Insert");
    expect(document.activeElement).toBe(dialog.querySelector("[data-testid=plugin-browser-search]"));

    await act(async () => compressor.click());
    expect(exec).toHaveBeenCalledWith("load_master_builtin", { type: "compressor" });
    expect(exec).not.toHaveBeenCalledWith("load_builtin", expect.anything());
    expect(host.querySelector("[data-testid=pt-insert-dialog]")).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it("routes fader, pan, automation, I/O, insert, send, and track controls through store.exec", async () => {
    const strip = vocalStrip();
    const volume = strip.querySelector<HTMLInputElement>("[data-testid=pt-mix-volume]");
    const pan = strip.querySelector<HTMLInputElement>("[data-testid=pt-mix-pan]");
    const automation = strip.querySelector<HTMLSelectElement>("[data-testid=pt-mix-automation]");
    const input = strip.querySelector<HTMLSelectElement>("[data-testid=pt-mix-input]");
    const output = strip.querySelector<HTMLSelectElement>("[data-testid=pt-mix-output]");
    const send = strip.querySelector<HTMLInputElement>("[data-testid=pt-mix-send-level-1]");
    const mute = strip.querySelector<HTMLButtonElement>("[data-testid=pt-mix-mute]");
    const bypass = strip.querySelector<HTMLButtonElement>("[data-testid=pt-mix-insert-bypass-0]");
    const remove = strip.querySelector<HTMLButtonElement>("[data-testid=pt-mix-insert-remove-0]");
    if (!volume || !pan || !automation || !input || !output || !send || !mute || !bypass || !remove)
      throw new Error("mix controls are missing");

    await act(async () => {
      changeInput(volume, "-9");
      changeInput(pan, "-0.5");
      changeSelect(automation, "write");
      changeSelect(input, "in-3-4");
      changeSelect(output, "dev:out-3-4");
      changeInput(send, "-6");
      mute.click();
      bypass.click();
      remove.click();
    });

    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("set_track_volume", { trackId: "vocal", db: -9 }));
    expect(exec).toHaveBeenCalledWith("set_track_pan", { trackId: "vocal", pan: -0.5 });
    expect(exec).toHaveBeenCalledWith("set_track_automation_mode", { trackId: "vocal", mode: "write" });
    expect(exec).toHaveBeenCalledWith("set_track_input", { trackId: "vocal", deviceID: "in-3-4" });
    expect(exec).toHaveBeenCalledWith("set_track_output", { trackId: "vocal", deviceID: "out-3-4" });
    expect(exec).toHaveBeenCalledWith("set_send_level", { trackId: "vocal", bus: 1, db: -6 });
    expect(exec).toHaveBeenCalledWith("set_track_mute", { trackId: "vocal", mute: true });
    expect(exec).toHaveBeenCalledWith("bypass_plugin", { trackId: "vocal", index: 0, bypassed: true });
    expect(exec).toHaveBeenCalledWith("remove_plugin", { trackId: "vocal", index: 0 });
    expect(useStore.getState().selectedTrackId).toBe("vocal");
  });

  it("Option applies compatible Mix actions to all shown strips in session order", async () => {
    const strip = vocalStrip();
    const automation = strip.querySelector<HTMLSelectElement>("[data-testid=pt-mix-automation]");
    const output = strip.querySelector<HTMLSelectElement>("[data-testid=pt-mix-output]");
    const mute = strip.querySelector<HTMLButtonElement>("[data-testid=pt-mix-mute]");
    const addInsert = strip.querySelector<HTMLButtonElement>("[data-testid=pt-mix-add-insert]");
    if (!automation || !output || !mute || !addInsert) throw new Error("fan-out controls are missing");

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt", code: "AltLeft", altKey: true, bubbles: true,
    })));
    await act(async () => {
      changeSelect(automation, "write");
      changeSelect(output, "dev:out-3-4");
      mute.click();
      addInsert.click();
    });
    const dialog = host.querySelector<HTMLElement>("[data-testid=pt-insert-dialog]");
    const compressor = Array.from(dialog?.querySelectorAll<HTMLButtonElement>(".prow-load") ?? [])
      .find((control) => control.textContent?.includes("Compressor"));
    if (!compressor) throw new Error("fan-out Insert row is missing");
    await act(async () => compressor.click());
    act(() => window.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Alt", code: "AltLeft", altKey: false, bubbles: true,
    })));

    await vi.waitFor(() => expect(exec.mock.calls.filter(([command]) => command === "set_track_automation_mode"))
      .toEqual([
        ["set_track_automation_mode", { trackId: "vocal", mode: "write" }],
        ["set_track_automation_mode", { trackId: "double", mode: "write" }],
        ["set_track_automation_mode", { trackId: "aux-1", mode: "write" }],
      ]));
    expect(exec.mock.calls.filter(([command]) => command === "set_track_output")).toEqual([
      ["set_track_output", { trackId: "vocal", deviceID: "out-3-4" }],
      ["set_track_output", { trackId: "double", deviceID: "out-3-4" }],
      ["set_track_output", { trackId: "aux-1", deviceID: "out-3-4" }],
    ]);
    expect(exec.mock.calls.filter(([command]) => command === "set_track_mute")).toEqual([
      ["set_track_mute", { trackId: "vocal", mute: true }],
      ["set_track_mute", { trackId: "double", mute: true }],
      ["set_track_mute", { trackId: "aux-1", mute: true }],
    ]);
    expect(exec.mock.calls.filter(([command]) => command === "load_builtin")).toEqual([
      ["load_builtin", { trackId: "vocal", type: "compressor" }],
      ["load_builtin", { trackId: "double", type: "compressor" }],
      ["load_builtin", { trackId: "aux-1", type: "compressor" }],
    ]);
  });

  it("Option changes a matching send on every compatible strip that owns it", async () => {
    const send = vocalStrip().querySelector<HTMLInputElement>("[data-testid=pt-mix-send-level-1]");
    if (!send) throw new Error("Vocal Verb send is missing");

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt", code: "AltLeft", altKey: true, bubbles: true,
    })));
    await act(async () => changeInput(send, "-4"));
    act(() => window.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Alt", code: "AltLeft", altKey: false, bubbles: true,
    })));

    await vi.waitFor(() => expect(exec.mock.calls.filter(([command]) => command === "set_send_level"))
      .toEqual([
        ["set_send_level", { trackId: "vocal", bus: 1, db: -4 }],
        ["set_send_level", { trackId: "double", bus: 1, db: -4 }],
      ]));
  });

  it("stops all-strip input routing when hardware reports applied false", async () => {
    const input = vocalStrip().querySelector<HTMLSelectElement>("[data-testid=pt-mix-input]");
    if (!input) throw new Error("Mix input is missing");
    exec.mockResolvedValueOnce({
      ok: true,
      command: "set_track_input",
      data: { applied: false, reason: "Input 3-4 is unavailable" },
    });

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt", code: "AltLeft", altKey: true, bubbles: true,
    })));
    await act(async () => changeSelect(input, "in-3-4"));
    act(() => window.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Alt", code: "AltLeft", altKey: false, bubbles: true,
    })));

    await vi.waitFor(() => expect(useStore.getState().lastError).toBe("Input 3-4 is unavailable"));
    expect(exec.mock.calls.filter(([command]) => command === "set_track_input")).toEqual([
      ["set_track_input", { trackId: "vocal", deviceID: "in-3-4" }],
    ]);
  });

  it("Option-Shift applies a fader action only to selected Track Names", async () => {
    act(() => useProTools.setState({
      trackSelectionIds: ["aux-1"],
      editSelectionTrackIds: ["aux-1"],
      editSelectionTrackId: "aux-1",
    }));
    const volume = vocalStrip().querySelector<HTMLInputElement>("[data-testid=pt-mix-volume]");
    if (!volume) throw new Error("Mix fader is missing");

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Alt", code: "AltLeft", altKey: true, shiftKey: true, bubbles: true,
    })));
    await act(async () => changeInput(volume, "-7"));
    act(() => window.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Alt", code: "AltLeft", altKey: false, shiftKey: true, bubbles: true,
    })));

    await vi.waitFor(() => expect(exec.mock.calls.filter(([command]) => command === "set_track_volume"))
      .toEqual([["set_track_volume", { trackId: "aux-1", db: -7 }]]));
  });

  it("keeps an Aux strip's direct Mute action operational", async () => {
    const aux = host.querySelector<HTMLElement>("[data-testid=pt-mix-strip][data-track-id=aux-1]");
    const mute = aux?.querySelector<HTMLButtonElement>("[data-testid=pt-mix-mute]");
    if (!mute) throw new Error("Aux mute is missing");

    await act(async () => mute.click());

    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("set_track_mute", {
      trackId: "aux-1",
      mute: true,
    }));
  });

  it("keeps hidden strips out of Mix without removing their project tracks", () => {
    act(() => useProTools.getState().setTrackShown("folder", false));

    expect(host.querySelector("[data-testid=pt-mix-strip][data-track-id=folder]")).toBeNull();
    expect(useStore.getState().snapshot?.tracks.some((track) => track.id === "folder")).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("selects contiguous or noncontiguous Track Names directly in Mix", () => {
    const vocalName = vocalStrip().querySelector<HTMLButtonElement>(".pt-mix-track-name");
    const double = host.querySelector<HTMLElement>("[data-testid=pt-mix-strip][data-track-id=double]");
    const doubleName = double?.querySelector<HTMLButtonElement>(".pt-mix-track-name");
    if (!vocalName || !doubleName) throw new Error("Mix Track Names are missing");

    act(() => vocalName.click());
    act(() => doubleName.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    })));

    expect(useProTools.getState().trackSelectionIds).toEqual(["vocal", "double"]);
    expect(vocalStrip().dataset.selected).toBe("true");
    expect(double?.dataset.selected).toBe("true");
  });

  it("opens the shared Insert dialog for the strip selected by keyboard or pointer", async () => {
    const aux = host.querySelector<HTMLElement>("[data-testid=pt-mix-strip][data-track-id=aux-1]");
    const add = aux?.querySelector<HTMLButtonElement>("[data-testid=pt-mix-add-insert]");
    if (!aux || !add) throw new Error("Aux insert control is missing");

    await act(async () => {
      add.focus();
      add.click();
    });

    expect(useStore.getState().selectedTrackId).toBe("aux-1");
    expect(host.querySelector("[data-testid=pt-insert-dialog]")).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-testid=plugin-browser-search]"));

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })));
    expect(host.querySelector("[data-testid=pt-insert-dialog]")).toBeNull();
    expect(document.activeElement).toBe(add);
  });
});
