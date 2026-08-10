import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsMemoryLocations } from "./ProToolsMemoryLocations";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-memory-window.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: {
    playing: false,
    recording: false,
    position: 2,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
  annotations: [
    { id: "marker-2", text: "Hook", beat: 8, color: "#d9904a" },
    { id: "marker-1", text: "Verse In", beat: 4, color: "#4a90d9" },
  ],
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Pro Tools Memory Locations window", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      projectEpoch: 30,
      exec,
      lastError: null,
    });
    useProTools.getState().resetForProject(30);
    useProTools.getState().setMemoryLocationsOpen(true);
    act(() => root.render(React.createElement(ProToolsMemoryLocations, { snapshot: SNAPSHOT })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      projectEpoch: originalState.projectEpoch,
      exec: originalState.exec,
      lastError: originalState.lastError,
    });
  });

  function button(testId: string): HTMLButtonElement {
    const control = host.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`);
    if (!control) throw new Error(`${testId} is missing`);
    return control;
  }

  function input(testId: string): HTMLInputElement {
    const control = host.querySelector<HTMLInputElement>(`[data-testid=${testId}]`);
    if (!control) throw new Error(`${testId} is missing`);
    return control;
  }

  it("shows a time-sorted, searchable nonmodal marker list and seeks on row activation", async () => {
    const window = host.querySelector<HTMLElement>("[data-testid=pt-memory-locations]");
    expect(window?.getAttribute("aria-label")).toBe("Memory Locations");
    expect(Array.from(host.querySelectorAll("[data-memory-location-number]"))
      .map((row) => row.getAttribute("data-memory-location-number"))).toEqual(["1", "2"]);

    act(() => setInputValue(input("pt-memory-search"), "hook"));
    expect(host.textContent).toContain("Hook");
    expect(host.textContent).not.toContain("Verse In");

    await act(async () => button("pt-memory-recall-marker-2").click());
    expect(exec).toHaveBeenCalledWith("set_transport", { position: 4 });
  });

  it("creates a marker at the current transport through the annotation command seam", async () => {
    const trigger = button("pt-memory-add");
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = host.querySelector<HTMLElement>("[data-testid=pt-memory-dialog]");
    const name = input("pt-memory-name");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(name);

    act(() => setInputValue(name, "Chorus In"));
    await act(async () => button("pt-memory-save").click());

    expect(exec).toHaveBeenCalledWith("create_annotation", { text: "Chorus In", beat: 4 });
    expect(host.querySelector("[data-testid=pt-memory-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("edits and removes markers through the persisted annotation commands", async () => {
    await act(async () => button("pt-memory-edit-marker-1").click());
    const name = input("pt-memory-name");
    expect(name.value).toBe("Verse In");
    act(() => setInputValue(name, "Verse Pickup"));
    await act(async () => button("pt-memory-save").click());
    expect(exec).toHaveBeenCalledWith("edit_annotation", {
      annotationId: "marker-1",
      text: "Verse Pickup",
      color: "#4a90d9",
    });

    await act(async () => button("pt-memory-remove-marker-2").click());
    expect(exec).toHaveBeenCalledWith("remove_annotation", { annotationId: "marker-2" });
  });

  it("traps focus, closes on Escape, restores focus, and invalidates edits across projects", async () => {
    const trigger = button("pt-memory-edit-marker-1");
    trigger.focus();
    await act(async () => trigger.click());
    const name = input("pt-memory-name");
    act(() => setInputValue(name, "Stale Edit"));
    act(() => useStore.setState({ projectEpoch: 31 }));
    await act(async () => button("pt-memory-save").click());
    expect(exec).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=pt-memory-dialog]")).toBeNull();

    useStore.setState({ projectEpoch: 30 });
    await act(async () => trigger.click());
    expect(document.activeElement).toBe(input("pt-memory-name"));
    const dialog = host.querySelector<HTMLElement>("[data-testid=pt-memory-dialog]");
    const close = dialog?.querySelector<HTMLButtonElement>("header button");
    if (!dialog || !close) throw new Error("Memory Location dialog controls are missing");
    close.focus();
    act(() => close.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", shiftKey: true, bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(button("pt-memory-save"));
    act(() => button("pt-memory-save").dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(close);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("[data-testid=pt-memory-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
