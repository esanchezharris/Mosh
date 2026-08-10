import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot, Track } from "../types";
import { ProToolsSends } from "./ProToolsSends";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});

const SOURCE: Track = {
  id: "vocal",
  index: 0,
  name: "Lead Vocal",
  type: "audio",
  clips: [],
  sends: [{ bus: 0, db: -12, mute: false }],
};

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-sends.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [SOURCE, {
    id: "plate-return",
    index: 1,
    name: "Plate",
    type: "audio",
    clips: [],
    isReturn: true,
    returnBus: 0,
  }, {
    id: "delay-return",
    index: 2,
    name: "Delay",
    type: "audio",
    clips: [],
    isReturn: true,
    returnBus: 1,
  }],
  buses: [
    { bus: 0, name: "Plate", trackId: "plate-return" },
    { bus: 1, name: "Delay", trackId: "delay-return" },
  ],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

const setValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("native input value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("Pro Tools sends and Aux returns", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => command === "create_bus"
      ? { ok: true, command, data: { busNumber: 2, trackId: "room-return", name: "Room" } }
      : { ok: true, command });
    useStore.setState({
      snapshot: SNAPSHOT,
      selectedTrackId: SOURCE.id,
      editingClipId: null,
      projectEpoch: 71,
      exec,
      lastError: null,
      refresh: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      selectedTrackId: originalState.selectedTrackId,
      editingClipId: originalState.editingClipId,
      projectEpoch: originalState.projectEpoch,
      exec: originalState.exec,
      lastError: originalState.lastError,
      refresh: originalState.refresh,
    });
    vi.restoreAllMocks();
  });

  const render = () => act(() => root.render(React.createElement(ProToolsSends, { track: SOURCE })));

  it("renders assigned and available buses and routes send edits through store.exec", async () => {
    render();

    expect(host.querySelector("[data-testid=pt-sends]")).not.toBeNull();
    expect(host.querySelector("[data-testid=pt-send-post-0]")?.textContent).toBe("Post");
    expect(host.querySelector<HTMLInputElement>("[data-testid=pt-send-level-0]")?.value).toBe("-12");
    expect(host.querySelector("[data-testid=pt-send-level-readout-0]")?.textContent).toBe("-12.0 dB");

    const level = host.querySelector<HTMLInputElement>("[data-testid=pt-send-level-0]");
    const remove = host.querySelector<HTMLButtonElement>("[data-testid=pt-remove-send-0]");
    const assign = host.querySelector<HTMLButtonElement>("[data-testid=pt-add-send-1]");
    if (!level || !remove || !assign) throw new Error("send controls are missing");
    await act(async () => setValue(level, "-6"));
    await act(async () => remove.click());
    await act(async () => assign.click());

    expect(exec).toHaveBeenCalledWith("set_send_level", { trackId: "vocal", bus: 0, db: -6 });
    expect(exec).toHaveBeenCalledWith("remove_send", { trackId: "vocal", bus: 0 });
    expect(exec).toHaveBeenCalledWith("add_send", { trackId: "vocal", bus: 1, db: 0 });
  });

  it("opens the matching Aux return so its fader and insert rack are reachable", async () => {
    render();
    const open = host.querySelector<HTMLButtonElement>("[data-testid=pt-open-return-0]");
    if (!open) throw new Error("open-return control is missing");

    await act(async () => open.click());

    expect(useStore.getState().selectedTrackId).toBe("plate-return");
    expect(useStore.getState().editingClipId).toBeNull();
  });

  it("creates a named Aux bus from the keyboard and selects its returned track", async () => {
    render();
    const add = host.querySelector<HTMLButtonElement>("[data-testid=pt-add-bus]");
    if (!add) throw new Error("add-bus control is missing");
    await act(async () => add.click());
    const input = host.querySelector<HTMLInputElement>("[data-testid=pt-new-bus-name]");
    if (!input) throw new Error("new-bus name field is missing");
    act(() => setValue(input, "Room"));

    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })));

    expect(exec).toHaveBeenCalledWith("create_bus", { name: "Room" });
    expect(useStore.getState().selectedTrackId).toBe("room-return");
  });

  it("renames buses and confirm-gates project-wide removal", async () => {
    render();
    const rename = host.querySelector<HTMLButtonElement>("[data-testid=pt-rename-bus-0]");
    if (!rename) throw new Error("rename-bus control is missing");
    await act(async () => rename.click());
    const input = host.querySelector<HTMLInputElement>("[data-testid=pt-bus-name-0]");
    if (!input) throw new Error("rename field is missing");
    act(() => setValue(input, "Vocal Plate"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })));
    expect(exec).toHaveBeenCalledWith("rename_bus", { bus: 0, name: "Vocal Plate" });

    const remove = host.querySelector<HTMLButtonElement>("[data-testid=pt-remove-bus-0]");
    if (!remove) throw new Error("remove-bus control is missing");
    await act(async () => remove.click());
    expect(host.querySelector("[data-testid=pt-remove-bus-confirm]")).not.toBeNull();
    const confirm = host.querySelector<HTMLButtonElement>("[data-testid=pt-remove-bus-confirm-confirm]");
    if (!confirm) throw new Error("remove-bus confirmation is missing");
    await act(async () => confirm.click());

    expect(exec).toHaveBeenCalledWith("remove_bus", { bus: 0 });
  });

  it("surfaces command failure and keeps the project snapshot immutable", async () => {
    exec.mockResolvedValueOnce({ ok: false, command: "add_send", error: "bus is locked" });
    render();
    const assign = host.querySelector<HTMLButtonElement>("[data-testid=pt-add-send-1]");
    if (!assign) throw new Error("assign-send control is missing");

    await act(async () => assign.click());

    expect(useStore.getState().lastError).toBe("bus is locked");
    expect(SOURCE.sends).toEqual([{ bus: 0, db: -12, mute: false }]);
  });

  it("ignores a command response that arrives after project replacement", async () => {
    let resolveCommand: ((result: CommandResult) => void) | null = null;
    exec.mockImplementationOnce(() => new Promise<CommandResult>((resolve) => { resolveCommand = resolve; }));
    render();
    const assign = host.querySelector<HTMLButtonElement>("[data-testid=pt-add-send-1]");
    if (!assign) throw new Error("assign-send control is missing");

    act(() => assign.click());
    act(() => useStore.setState({ projectEpoch: 72 }));
    await act(async () => resolveCommand?.({ ok: false, command: "add_send", error: "stale project error" }));

    expect(useStore.getState().lastError).toBeNull();
  });
});
