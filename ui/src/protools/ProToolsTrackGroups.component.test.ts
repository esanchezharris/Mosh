import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsTrackGroupsPanel } from "./ProToolsTrackGroupsPanel";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48_000, tempo: 120, editFile: "/tmp/track-groups.mosh", key: { tonic: "C", mode: "major" } },
  tracks: [
    { id: "drums", index: 0, name: "Drums", type: "audio", clips: [], volumeDb: 0, pan: 0 },
    { id: "bass", index: 1, name: "Bass", type: "audio", clips: [], volumeDb: -3, pan: 0 },
  ],
  trackGroups: [{
    id: "rhythm",
    name: "Rhythm",
    trackIds: ["drums", "bass"],
    kind: "edit_mix",
    enabled: true,
  }],
  trackGroupsSuspended: false,
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Pro Tools Track Groups panel and dialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalStore = useStore.getState();
  const originalProTools = useProTools.getState();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: SNAPSHOT, selectedTrackId: "drums", projectEpoch: 12, exec });
    useProTools.setState({ trackSelectionIds: ["drums", "bass"], trackGroupDialogOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalStore.snapshot,
      selectedTrackId: originalStore.selectedTrackId,
      projectEpoch: originalStore.projectEpoch,
      exec: originalStore.exec,
    });
    useProTools.setState({
      trackSelectionIds: originalProTools.trackSelectionIds,
      trackGroupDialogOpen: originalProTools.trackGroupDialogOpen,
    });
  });

  it("shows group state, toggles Suspend All, and removes through store.exec", async () => {
    act(() => root.render(React.createElement(ProToolsTrackGroupsPanel, { snapshot: SNAPSHOT })));
    expect(host.querySelector("[data-testid=pt-track-group-row]")?.textContent).toContain("Rhythm");
    expect(host.querySelector("[data-testid=pt-track-group-row]")?.textContent).toContain("Edit + Mix");

    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-toggle]")?.click());
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-suspend]")?.click());
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-remove]")?.click());
    expect(exec).toHaveBeenCalledWith("set_track_group_enabled", { groupId: "rhythm", enabled: false });
    expect(exec).toHaveBeenCalledWith("set_track_groups_suspended", { suspended: true });
    expect(exec).toHaveBeenCalledWith("remove_track_group", { groupId: "rhythm" });
  });

  it("opens an accessible Command G dialog, traps focus, and creates a non-routing group", async () => {
    act(() => {
      useProTools.setState({ trackGroupDialogOpen: true });
      root.render(React.createElement(ProToolsTrackGroupsPanel, { snapshot: SNAPSHOT }));
    });
    const dialog = document.querySelector<HTMLElement>("[data-testid=pt-track-group-dialog]");
    const backdrop = document.querySelector<HTMLElement>("[data-testid=pt-track-group-backdrop]");
    const name = document.querySelector<HTMLInputElement>("[data-testid=pt-track-group-name]");
    const kind = document.querySelector<HTMLSelectElement>("[data-testid=pt-track-group-kind]");
    if (!dialog || !backdrop || !name || !kind) throw new Error("Track Group dialog controls are missing");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(backdrop.classList.contains("pt-protools-portal")).toBe(true);
    expect(backdrop.dataset.ptTheme).toBe("dark");
    expect(name).toBe(document.activeElement);
    expect(name.value).toBe("Group 2");

    await act(async () => {
      setInputValue(name, "Band");
      kind.value = "mix";
      kind.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-create]")?.click());
    expect(exec).toHaveBeenCalledWith("create_track_group", {
      trackIds: ["drums", "bass"],
      name: "Band",
      kind: "mix",
    });
    expect(exec).not.toHaveBeenCalledWith("create_group_track", expect.anything());
  });

  it("keeps a rejected create open and invalidates the dialog on project replacement", async () => {
    exec.mockResolvedValueOnce({ ok: false, command: "create_track_group", error: "tracks are locked" });
    act(() => root.render(React.createElement(ProToolsTrackGroupsPanel, { snapshot: SNAPSHOT })));
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-groups-new]");
    if (!trigger) throw new Error("Track Group trigger is missing");
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () => document.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-create]")?.click());

    expect(document.querySelector("[data-testid=pt-track-group-dialog]")).not.toBeNull();
    expect(document.querySelector("[role=alert]")?.textContent).toBe("tracks are locked");

    act(() => useStore.setState({ projectEpoch: 13 }));
    expect(document.querySelector("[data-testid=pt-track-group-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
