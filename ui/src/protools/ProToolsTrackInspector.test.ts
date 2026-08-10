import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsDetailDock } from "./ProToolsDetailDock";
import { ProToolsTrackHeaders } from "./ProToolsTrackHeaders";

const TRACK_ID = "audio-track";
const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-routing.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: TRACK_ID,
    index: 0,
    name: "Lead Vocal",
    type: "audio",
    clips: [],
    armed: false,
    monitor: "automatic",
    volumeDb: -3,
    pan: 0.25,
    input: { deviceID: "in-1-2", name: "Input 1-2", kind: "wave" },
    output: { isTrack: false, deviceID: "out-1-2", name: "Main Speakers" },
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Pro Tools selected-track inspector", () => {
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
      data: command === "set_input_monitor" || command === "arm_track" ? { applied: true } : undefined,
    }));
    useStore.setState({
      snapshot: SNAPSHOT,
      selectedTrackId: TRACK_ID,
      editingClipId: null,
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
        tracks: [{ id: TRACK_ID, name: "Lead Vocal" }],
        audioEnabled: true,
      },
      loadRouting: vi.fn(async () => {}),
      loadMidiInputs: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating").forEach((node) => node.remove());
    useStore.setState({
      snapshot: originalState.snapshot,
      selectedTrackId: originalState.selectedTrackId,
      editingClipId: originalState.editingClipId,
      exec: originalState.exec,
      lastError: originalState.lastError,
      waveInputs: originalState.waveInputs,
      midiInputs: originalState.midiInputs,
      trackOutputs: originalState.trackOutputs,
      loadRouting: originalState.loadRouting,
      loadMidiInputs: originalState.loadMidiInputs,
    });
  });

  function renderDock(): void {
    act(() => root.render(React.createElement(ProToolsDetailDock, { onOpenFades: vi.fn() })));
  }

  it("renders real routing, monitoring, volume, and pan controls for the selected track", () => {
    renderDock();

    expect(host.querySelector("[data-testid=pt-track-inspector]")).not.toBeNull();
    expect(host.querySelector("[data-testid=pt-detail-dock]")?.getAttribute("aria-label"))
      .toBe("Lead Vocal track inspector");
    expect(host.querySelector("[data-testid=pt-io-input]")?.textContent).toContain("Input 1-2");
    expect(host.querySelector("[data-testid=pt-io-output]")?.textContent).toContain("Main Speakers");
    expect(host.querySelector("[data-testid=pt-monitor-automatic]")?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector<HTMLInputElement>("[data-testid=pt-track-volume]")?.value).toBe("-3");
    expect(host.querySelector<HTMLInputElement>("[data-testid=pt-track-pan]")?.value).toBe("0.25");
  });

  it("uses snapshot routing names while the lazy catalogs are still loading", () => {
    useStore.setState({ waveInputs: null, midiInputs: null, trackOutputs: null });

    renderDock();

    expect(host.querySelector("[data-testid=pt-io-input]")?.textContent).toContain("Input 1-2");
    expect(host.querySelector("[data-testid=pt-io-output]")?.textContent).toContain("Main Speakers");
  });

  it("routes input, output, monitor, volume, pan, and rename mutations through store.exec", async () => {
    renderDock();

    const input = host.querySelector<HTMLButtonElement>("[data-testid=pt-io-input]");
    if (!input) throw new Error("input menu is missing");
    await act(async () => input.click());
    const inputOption = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid=pt-io-input-option]"))
      .find((button) => button.textContent?.includes("Input 3-4"));
    if (!inputOption) throw new Error("input option is missing");
    await act(async () => inputOption.click());

    const output = host.querySelector<HTMLButtonElement>("[data-testid=pt-io-output]");
    if (!output) throw new Error("output menu is missing");
    await act(async () => output.click());
    const outputOption = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid=pt-io-output-option]"))
      .find((button) => button.textContent?.includes("Headphones"));
    if (!outputOption) throw new Error("output option is missing");
    await act(async () => outputOption.click());

    const monitor = host.querySelector<HTMLButtonElement>("[data-testid=pt-monitor-on]");
    if (!monitor) throw new Error("monitor control is missing");
    await act(async () => monitor.click());

    const volume = host.querySelector<HTMLInputElement>("[data-testid=pt-track-volume]");
    const pan = host.querySelector<HTMLInputElement>("[data-testid=pt-track-pan]");
    if (!volume || !pan) throw new Error("mix controls are missing");
    act(() => setInputValue(volume, "-6"));
    act(() => setInputValue(pan, "-0.5"));
    act(() => pan.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    const name = host.querySelector<HTMLInputElement>("[data-testid=pt-track-name]");
    if (!name) throw new Error("track name field is missing");
    act(() => setInputValue(name, "Vocal Comp"));
    await act(async () => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(exec).toHaveBeenCalledWith("set_track_input", { trackId: TRACK_ID, deviceID: "in-3-4" });
    expect(exec).toHaveBeenCalledWith("set_track_output", { trackId: TRACK_ID, deviceID: "out-3-4" });
    expect(exec).toHaveBeenCalledWith("set_input_monitor", { trackId: TRACK_ID, mode: "on" });
    expect(exec).toHaveBeenCalledWith("set_track_volume", { trackId: TRACK_ID, db: -6 });
    expect(exec).toHaveBeenCalledWith("set_track_pan", { trackId: TRACK_ID, pan: -0.5 });
    expect(exec).toHaveBeenCalledWith("set_track_pan", { trackId: TRACK_ID, pan: 0 });
    expect(exec).toHaveBeenCalledWith("rename_track", { trackId: TRACK_ID, name: "Vocal Comp" });
  });

  it("rejects an empty track name without issuing a command", async () => {
    renderDock();
    const name = host.querySelector<HTMLInputElement>("[data-testid=pt-track-name]");
    if (!name) throw new Error("track name field is missing");

    act(() => setInputValue(name, "   "));
    await act(async () => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(exec).not.toHaveBeenCalledWith("rename_track", expect.anything());
    expect(name.getAttribute("aria-invalid")).toBe("true");
  });

  it("surfaces an applied-false monitoring result through the shared error bar state", async () => {
    exec.mockResolvedValueOnce({
      ok: true,
      command: "set_input_monitor",
      data: { applied: false, reason: "no input device" },
    });
    renderDock();
    const monitor = host.querySelector<HTMLButtonElement>("[data-testid=pt-monitor-on]");
    if (!monitor) throw new Error("monitor control is missing");

    await act(async () => monitor.click());

    expect(useStore.getState().lastError).toBe("no input device");
  });

  it("opens an Aux return with its bus input, mix controls, and insert rack", async () => {
    const aux: Snapshot["tracks"][number] = {
      id: "plate-return",
      index: 1,
      name: "Plate",
      type: "audio",
      clips: [],
      isReturn: true,
      returnBus: 0,
      volumeDb: -4,
      pan: 0,
      plugins: [],
    };
    useStore.setState({
      snapshot: { ...SNAPSHOT, tracks: [...SNAPSHOT.tracks, aux], buses: [
        { bus: 0, name: "Plate", trackId: aux.id },
      ] },
      selectedTrackId: aux.id,
    });
    renderDock();

    expect(host.querySelector(".pt-detail-title")?.textContent).toBe("Aux — Plate");
    expect(host.querySelector("[data-testid=pt-aux-input]")?.textContent).toBe("Bus — Plate");
    expect(host.querySelector("[data-testid=pt-monitor-automatic]")).toBeNull();
    expect(host.querySelector("[data-testid=pt-device-rack]")?.getAttribute("aria-label"))
      .toBe("Inserts on Plate");

    const name = host.querySelector<HTMLInputElement>("[data-testid=pt-track-name]");
    if (!name) throw new Error("Aux name field is missing");
    act(() => setInputValue(name, "Vocal Plate"));
    await act(async () => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(exec).toHaveBeenCalledWith("rename_bus", { bus: 0, name: "Vocal Plate" });
    expect(exec).not.toHaveBeenCalledWith("rename_track", expect.anything());
  });
});

describe("Pro Tools track header routing feedback", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({ snapshot: SNAPSHOT, selectedTrackId: TRACK_ID, lastError: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      selectedTrackId: originalState.selectedTrackId,
      exec: originalState.exec,
      lastError: originalState.lastError,
    });
  });

  it("shows the actual output route instead of a fixed output label", () => {
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    expect(host.querySelector(".pt-track-route")?.textContent).toBe("Main Speakers");
  });

  it("surfaces an applied-false arm result through the shared error bar state", async () => {
    useStore.setState({
      exec: vi.fn(async (): Promise<CommandResult> => ({
        ok: true,
        command: "arm_track",
        data: { applied: false, reason: "no input device" },
      })),
    });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));
    const arm = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-arm]");
    if (!arm) throw new Error("arm control is missing");

    await act(async () => arm.click());

    expect(useStore.getState().lastError).toBe("no input device");
  });
});
