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
      id: "folder",
      index: 1,
      name: "Vocals Folder",
      type: "group",
      isGroup: true,
      clips: [],
      volumeDb: 0,
      pan: 0,
    },
    {
      id: "aux-1",
      index: 2,
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
    expect(host.querySelectorAll("[data-testid=pt-mix-strip]")).toHaveLength(3);
    expect(vocalStrip().getAttribute("aria-label")).toBe("Lead Vocal channel strip");
    expect(vocalStrip().querySelector("[data-testid=pt-mix-inserts]")?.textContent).toContain("CLA-2A Stereo");
    expect(vocalStrip().querySelector("[data-testid=pt-mix-sends]")?.textContent).toContain("Vocal Verb");
    expect(vocalStrip().querySelector("[data-testid=pt-mix-input]")).not.toBeNull();
    expect(vocalStrip().querySelector("[data-testid=pt-mix-output]")).not.toBeNull();
    expect(vocalStrip().querySelector("[data-testid=pt-mix-automation]")).not.toBeNull();
    expect(vocalStrip().querySelector(".meter")).not.toBeNull();
    expect(host.querySelector("[data-testid=pt-mix-master-meter]")).not.toBeNull();
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

  it("keeps hidden strips out of Mix without removing their project tracks", () => {
    act(() => useProTools.getState().setTrackShown("folder", false));

    expect(host.querySelector("[data-testid=pt-mix-strip][data-track-id=folder]")).toBeNull();
    expect(useStore.getState().snapshot?.tracks.some((track) => track.id === "folder")).toBe(true);
    expect(exec).not.toHaveBeenCalled();
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
